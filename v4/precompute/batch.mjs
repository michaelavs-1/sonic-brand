// v4/precompute/batch.mjs
//
// Slow-and-safe batch that:
//   1) Reads the execution plan written by dry-run.mjs (state/dry-run.json)
//   2) Upserts biztype_genres, playlist_genres, playlist_tracks (cheap, no API)
//   3) For each unique spotify_id not yet in track_analyses, calls RapidAPI
//      directly (bypassing the Vercel 30s function timeout) and upserts the
//      result into track_analyses.
//
// Iron-clad cost cap — four independent guards (any one will halt the run):
//   1. CLI arg `--max-rapidapi-calls=N` is REQUIRED, and N must be <=
//      HARDCODED_CEILING below (defense against typo).
//   2. Persisted month-keyed counter in state/rapidapi-call-count.json. Pre-check
//      before each call; abort if a call would push the month over the cap.
//   3. The execution plan's `expected_new_calls` must be <= --max-rapidapi-calls.
//   4. The execution plan must be < FRESHNESS_HOURS old.
//
// Execution profile:
//   - Worker pool: N concurrent workers (--concurrency=N, default 3), each
//     doing serial RapidAPI calls. NOT a start-rate limiter — empirically the
//     RapidAPI upstream analysis service degrades sharply under concurrent
//     load (latencies balloon from 3s to 7min+), so we cap in-flight directly.
//   - Retries: 429 with retry-after; 5xx/network with exponential backoff
//   - Terminal failures recorded as status='error' so we don't retry forever
//   - Persistent progress in state/progress.json — crash-safe & resumable
//   - Dual logging: console + state/batch.log (append-only)
//
// Run (from anywhere):
//   node v4/precompute/batch.mjs --max-rapidapi-calls=15000
//   node v4/precompute/batch.mjs --max-rapidapi-calls=15000 --concurrency=2

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------- env loader ----------
(function loadDotEnv() {
    const p = path.join(REPO_ROOT, '.env.local');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
})();

const { pgrSelectIn, pgrUpsert } = await import('../../api/v4/supabase-client.js');

// ---------- constants ----------
const HARDCODED_CEILING   = 50000;    // absolute max for --max-rapidapi-calls (== PRO tier monthly quota)
const FRESHNESS_HOURS     = 24;       // execution plan must be no older than this
const DEFAULT_CONCURRENCY = 3;        // overridable via --concurrency=N
const MAX_CONCURRENCY     = 8;        // refuse anything higher (upstream degrades fast)
const RAPIDAPI_HOST       = 'track-analysis.p.rapidapi.com';

const PLAN_PATH      = path.join(STATE_DIR, 'dry-run.json');
const COUNTER_PATH   = path.join(STATE_DIR, 'rapidapi-call-count.json');
const PROGRESS_PATH  = path.join(STATE_DIR, 'progress.json');
const LOG_PATH       = path.join(STATE_DIR, 'batch.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry pgrUpsert on transient failures (network blips, fetch failures,
// 5xx from PostgREST). Three attempts with backoff. Throws after exhaustion
// so callers can record a real errored entry. Important: we've already paid
// for the RapidAPI call by the time we get here — losing the analysis to a
// transient DB blip is wasted money.
const UPSERT_RETRY_BACKOFF_MS = [3000, 10000, 30000];
async function upsertWithRetries(table, row, label) {
    let lastErr;
    for (let attempt = 0; attempt <= UPSERT_RETRY_BACKOFF_MS.length; attempt++) {
        try {
            await pgrUpsert(table, row);
            return;
        } catch (err) {
            lastErr = err;
            if (attempt < UPSERT_RETRY_BACKOFF_MS.length) {
                const wait = UPSERT_RETRY_BACKOFF_MS[attempt];
                warn(`${label} upsert attempt ${attempt + 1} failed (${err.message}); backoff ${wait}ms`);
                await sleep(wait);
            }
        }
    }
    throw lastErr;
}

// ---------- CLI args ----------
function parseArgs() {
    const args = {};
    for (const a of process.argv.slice(2)) {
        const m = a.match(/^--([a-z0-9-]+)(?:=(.+))?$/);
        if (m) args[m[1]] = m[2] ?? true;
    }
    return args;
}

// ---------- logging (console + append-only log) ----------
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
function log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
    console.log(line);
    logStream.write(line + '\n');
}
function warn(...parts) {
    const line = `[${new Date().toISOString()}] WARN ${parts.join(' ')}`;
    console.warn(line);
    logStream.write(line + '\n');
}
function fail(msg) {
    const line = `[${new Date().toISOString()}] FATAL ${msg}`;
    console.error(line);
    logStream.write(line + '\n');
    process.exit(1);
}

// ---------- persisted RapidAPI call counter ----------
function readCounter() {
    if (!fs.existsSync(COUNTER_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf-8')); }
    catch { return {}; }
}
function currentYearMonth() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// Sync counter increment. Direct writeFileSync (no rename) to avoid Windows
// EPERM quirks during high-frequency writes. With a brief retry loop for
// transient file locks (antivirus, IDE watcher).
function bumpCounter(by = 1) {
    const counter = readCounter();
    const key = currentYearMonth();
    counter[key] = (counter[key] || 0) + by;
    const payload = JSON.stringify(counter);
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.writeFileSync(COUNTER_PATH, payload);
            return counter[key];
        } catch (err) {
            lastErr = err;
            // Block briefly without an event-loop tick — keeps callers correct
            // in their read-after-bump assumption.
            const until = Date.now() + 50;
            while (Date.now() < until) { /* spin */ }
        }
    }
    // All retries failed. Log and continue — the in-memory `counter[key]`
    // value is still correct for this process; we just may diverge from disk.
    warn(`bumpCounter write failed after retries: ${lastErr?.code || ''} ${lastErr?.message || ''}`);
    return counter[key];
}
function readCurrentMonthCount() {
    return readCounter()[currentYearMonth()] || 0;
}

// ---------- persisted per-id progress ----------
// Direct writeFile (no write-then-rename) — atomic rename hits Windows EPERM
// quirks when antivirus / IDE file-watchers hold a brief lock on the dest.
// Queue serializes writes so there's no concurrent-write race anyway. If the
// process is killed mid-write the JSON may be corrupt; readProgress() falls
// back to empty in that case, and Supabase remains the source of truth for
// already-analyzed IDs.
function readProgress() {
    if (!fs.existsSync(PROGRESS_PATH)) return { done: [], errored: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
        return {
            done:    Array.isArray(parsed.done) ? parsed.done : [],
            errored: Array.isArray(parsed.errored) ? parsed.errored : [],
        };
    } catch {
        return { done: [], errored: [] };
    }
}
let progressWriteQueue = Promise.resolve();
function queueProgressWrite(progress) {
    progressWriteQueue = progressWriteQueue.then(async () => {
        try {
            await fs.promises.writeFile(PROGRESS_PATH, JSON.stringify(progress));
        } catch (err) {
            // Don't crash the batch over a transient file lock — log and continue.
            // Worst case: the file is briefly out-of-date; the next successful
            // write reconciles. Supabase is the source of truth.
            warn(`progress write failed (continuing): ${err.code || ''} ${err.message}`);
        }
    });
    return progressWriteQueue;
}

// ---------- RapidAPI call with retries ----------
const RETRY_429_BACKOFF_MS = [10000, 30000, 60000, 120000, 300000];
const RETRY_5XX_BACKOFF_MS = [5000, 15000, 45000, 120000, 300000, 600000];

async function callRapidApiOnce(spotifyId, apiKey) {
    const r = await fetch(`https://${RAPIDAPI_HOST}/pktx/spotify/${encodeURIComponent(spotifyId)}`, {
        method:  'GET',
        headers: {
            'x-rapidapi-key':  apiKey,
            'x-rapidapi-host': RAPIDAPI_HOST,
        },
    });
    // 404 = track not found on RapidAPI — terminal, but a known shape we record.
    if (r.status === 404) return { kind: 'not_found' };
    if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10);
        return { kind: 'rate_limited', retryAfter };
    }
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        return { kind: 'server_error', status: r.status, body: text.slice(0, 300) };
    }
    const data = await r.json().catch(() => null);
    if (!data) return { kind: 'server_error', status: 200, body: 'invalid JSON' };

    // RapidAPI sometimes returns HTTP 200 with an explicit error payload like
    // `{"error": "Failed to pull track data"}`. Treat as a server error so the
    // retry loop gets a chance — these are often transient.
    if (data.error) {
        return { kind: 'server_error', status: 200, body: `error payload: ${String(data.error).slice(0, 200)}` };
    }
    // RapidAPI also sometimes returns a stub: `{"id": "<base64>"}` or
    // `{"id": "...", "loudness": ""}` — the track exists but couldn't be
    // analyzed. None of the atmospheric fields are present. Treat as not_found
    // (terminal, no retry, no quota waste on repeated attempts).
    const hasAtmosphericFields =
        data.energy != null || data.danceability != null || data.popularity != null;
    if (!hasAtmosphericFields) {
        return { kind: 'not_found' };
    }

    return { kind: 'ok', data };
}

async function callWithRetries(spotifyId, apiKey, cap) {
    let rate429Idx = 0;
    let serr5xxIdx = 0;

    while (true) {
        // Per-call counter pre-check. Hard stop — better to abort the
        // batch than to nudge over the cap on a retry.
        const projected = readCurrentMonthCount() + 1;
        if (projected > cap) {
            return { kind: 'aborted_by_cap', projected, cap };
        }
        bumpCounter(1);

        let result;
        try {
            result = await callRapidApiOnce(spotifyId, apiKey);
        } catch (err) {
            result = { kind: 'network_error', message: err.message };
        }

        if (result.kind === 'ok' || result.kind === 'not_found') return result;

        if (result.kind === 'rate_limited') {
            if (rate429Idx >= RETRY_429_BACKOFF_MS.length) {
                return { kind: 'terminal', reason: '429 retries exhausted' };
            }
            const wait = result.retryAfter > 0
                ? Math.min(result.retryAfter * 1000, RETRY_429_BACKOFF_MS[rate429Idx])
                : RETRY_429_BACKOFF_MS[rate429Idx];
            warn(`429 on ${spotifyId}; backoff ${wait}ms (attempt ${rate429Idx + 1}/${RETRY_429_BACKOFF_MS.length})`);
            await sleep(wait);
            rate429Idx++;
            continue;
        }

        // server_error or network_error → 5xx backoff schedule
        if (serr5xxIdx >= RETRY_5XX_BACKOFF_MS.length) {
            return { kind: 'terminal', reason: `${result.kind} retries exhausted` };
        }
        const wait = RETRY_5XX_BACKOFF_MS[serr5xxIdx];
        warn(`${result.kind} on ${spotifyId}: ${result.status || ''} ${result.body || result.message || ''}; backoff ${wait}ms (attempt ${serr5xxIdx + 1}/${RETRY_5XX_BACKOFF_MS.length})`);
        await sleep(wait);
        serr5xxIdx++;
    }
}

// ---------- analysis → row mapping ----------
// Pull the small set of typed fields we know; stash the rest in raw_analysis.
// RapidAPI's exact shape isn't fully documented — be defensive.
function buildAnalysisRow(spotifyId, raw) {
    const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : null));
    return {
        spotify_id:       spotifyId,
        energy:           num(raw.energy),
        danceability:     num(raw.danceability),
        popularity:       num(raw.popularity),
        tempo:            num(raw.tempo),
        valence:          num(raw.valence),
        acousticness:     num(raw.acousticness),
        instrumentalness: num(raw.instrumentalness),
        raw_analysis:     raw,
        status:           'ok',
        analyzed_at:      new Date().toISOString(),
    };
}

// ---------- main ----------
async function main() {
    const args = parseArgs();

    // --- Guard 1: --max-rapidapi-calls required and <= HARDCODED_CEILING ---
    if (!args['max-rapidapi-calls']) {
        fail('--max-rapidapi-calls=N is required. Pick N <= ' + HARDCODED_CEILING + '.');
    }
    const cap = parseInt(args['max-rapidapi-calls'], 10);
    if (!Number.isFinite(cap) || cap <= 0) {
        fail('--max-rapidapi-calls must be a positive integer.');
    }
    if (cap > HARDCODED_CEILING) {
        fail(`--max-rapidapi-calls=${cap} exceeds hardcoded ceiling ${HARDCODED_CEILING}. Edit the source if you really mean this.`);
    }

    // --- Concurrency arg ---
    const concurrency = args['concurrency'] ? parseInt(args['concurrency'], 10) : DEFAULT_CONCURRENCY;
    if (!Number.isFinite(concurrency) || concurrency <= 0) {
        fail('--concurrency must be a positive integer.');
    }
    if (concurrency > MAX_CONCURRENCY) {
        fail(`--concurrency=${concurrency} exceeds MAX_CONCURRENCY=${MAX_CONCURRENCY}. Upstream RapidAPI degrades sharply under high concurrency; edit the source if you really mean this.`);
    }

    // --- Retry-errors flag ---
    // Default behavior: any row in track_analyses (ok/not_found/error) is treated
    // as "done" and skipped. With --retry-errors, status='error' rows are NOT
    // treated as done; the script re-attempts them. Useful after a batch where
    // some calls returned transient error payloads (e.g. RapidAPI was unhealthy).
    const retryErrors = !!args['retry-errors'];

    // --- Guard 4: execution plan must exist and be fresh ---
    if (!fs.existsSync(PLAN_PATH)) {
        fail(`No execution plan at ${PLAN_PATH}. Run tests/.test-precompute-dry-run.mjs first.`);
    }
    const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8'));
    const planAgeHours = (Date.now() - new Date(plan.generated_at).getTime()) / 3_600_000;
    if (planAgeHours > FRESHNESS_HOURS) {
        fail(`Execution plan is ${planAgeHours.toFixed(1)}h old (max ${FRESHNESS_HOURS}h). Re-run the dry-run.`);
    }

    log(`=== batch start ===`);
    log(`plan generated: ${plan.generated_at} (${planAgeHours.toFixed(2)}h ago)`);
    log(`target biz types: ${plan.target_biz_types.join(', ')}`);
    log(`unique track ids: ${plan.unique_track_ids.length}`);
    log(`plan-time expected new calls: ${plan.expected_new_calls} (may be stale)`);
    log(`cap: ${cap}`);
    log(`concurrency: ${concurrency} workers (each does serial calls)`);
    log(`retry-errors: ${retryErrors ? 'YES — status=error rows will be re-attempted' : 'no (default)'}`);

    // --- API key ---
    const apiKey = process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;
    if (!apiKey) fail('TRACK_ANALYSIS_RAPIDAPI_KEY not set in env.');

    // --- Live cap math: ask Supabase how many IDs are already cached now,
    // then use that to compute actual remaining. Avoids tripping the cap on
    // a stale plan after partial-batch runs. ---
    // When retryErrors is set we still fetch everything but filter out
    // status='error' rows from the "already cached" set so they get re-attempted.
    log(`live-checking Supabase for already-cached IDs (for accurate cap math)...`);
    const preExisting = await pgrSelectIn('track_analyses', 'spotify_id', plan.unique_track_ids, { select: 'spotify_id,status' });
    const cachedRows = retryErrors
        ? preExisting.filter((r) => r.status !== 'error')
        : preExisting;
    const liveCachedCount = cachedRows.length;
    const actualRemaining = plan.unique_track_ids.length - liveCachedCount;
    log(`  already cached (live): ${liveCachedCount}${retryErrors ? ` (excluded ${preExisting.length - cachedRows.length} status=error rows for retry)` : ''}`);
    log(`  actual remaining:      ${actualRemaining}`);

    const monthSoFar = readCurrentMonthCount();
    log(`  current month counter: ${monthSoFar}`);
    if (monthSoFar + actualRemaining > cap) {
        fail(`Current month already has ${monthSoFar} RapidAPI calls; ${actualRemaining} remaining would exceed --max-rapidapi-calls=${cap}. Raise the cap (within hardcoded ceiling ${HARDCODED_CEILING}) or wait until next month.`);
    }

    // --- Phase 1: upsert provenance tables (cheap, no API) ---
    log(`upserting biztype_genres (${plan.biztype_genres.length} rows)...`);
    await upsertWithRetries('biztype_genres', plan.biztype_genres, 'biztype_genres');

    log(`upserting playlist_genres (${plan.playlist_genres.length} rows)...`);
    await upsertWithRetries('playlist_genres', plan.playlist_genres, 'playlist_genres');

    // Build playlist_tracks rows, deduped by (playlist_id, spotify_id).
    // Spotify occasionally returns the same track twice in a playlist; the
    // first occurrence wins for `position`. PK conflict in a single upsert
    // would otherwise fail with "ON CONFLICT cannot affect row a second time".
    const playlistTracksRows = [];
    const seenPlaylistTrack = new Set();
    let withinPlaylistDups  = 0;
    for (const [playlistId, ids] of Object.entries(plan.playlist_tracks)) {
        ids.forEach((sid, i) => {
            const key = `${playlistId}\0${sid}`;
            if (seenPlaylistTrack.has(key)) { withinPlaylistDups++; return; }
            seenPlaylistTrack.add(key);
            playlistTracksRows.push({
                playlist_id: playlistId,
                spotify_id:  sid,
                position:    i,
            });
        });
    }
    log(`upserting playlist_tracks (${playlistTracksRows.length} unique rows; dropped ${withinPlaylistDups} duplicates)...`);
    // Chunked to avoid sending one giant POST body.
    const CHUNK = 1000;
    for (let i = 0; i < playlistTracksRows.length; i += CHUNK) {
        await upsertWithRetries('playlist_tracks', playlistTracksRows.slice(i, i + CHUNK), `playlist_tracks chunk ${i}`);
    }

    // --- Phase 2: which IDs still need analysis? Reuse the live count we
    // already fetched above for the cap math.
    const alreadyCachedSet = new Set(cachedRows.map((r) => r.spotify_id));
    log(`  already cached: ${alreadyCachedSet.size}`);

    const progress = readProgress();
    const doneSet = new Set(progress.done);
    const erroredSet = new Set(progress.errored.map((x) => x.id));

    // When retrying errors, the progress.json `done` set still contains the
    // IDs we want to re-attempt (they were successfully upserted as 'error',
    // which counted as done). Bypass the progress checks and let the live
    // alreadyCachedSet (which excludes status='error' in retry mode) decide.
    const toAnalyze = retryErrors
        ? plan.unique_track_ids.filter((id) => !alreadyCachedSet.has(id))
        : plan.unique_track_ids.filter((id) =>
              !alreadyCachedSet.has(id) && !doneSet.has(id) && !erroredSet.has(id)
          );
    log(`  to analyze this run: ${toAnalyze.length}`);

    if (toAnalyze.length === 0) {
        log('Nothing to do. Exiting.');
        return;
    }

    // --- Phase 3: per-id RapidAPI calls (rate-limited, retried, persisted) ---
    log(`starting RapidAPI phase...`);
    const t0 = Date.now();
    let analyzed = 0;
    let notFound = 0;
    let errored  = 0;
    let aborted  = false;

    // Worker pool: N workers, each pulls from a shared queue and processes
    // sequentially. The number of in-flight RapidAPI calls is therefore
    // exactly equal to the number of workers (caps load on the upstream).
    let idx = 0;

    // Write progress to disk every PROGRESS_WRITE_EVERY successful calls
    // (and immediately on any error/terminal). Reduces I/O from ~10K writes
    // to ~400 over the full batch.
    const PROGRESS_WRITE_EVERY = 25;
    let dirtyDoneSinceLastWrite = 0;
    function maybeWriteProgress({ force = false } = {}) {
        if (force || dirtyDoneSinceLastWrite >= PROGRESS_WRITE_EVERY) {
            dirtyDoneSinceLastWrite = 0;
            queueProgressWrite(progress);
        }
    }

    async function processOne(spotifyId) {
        const t1 = Date.now();
        const result = await callWithRetries(spotifyId, apiKey, cap);
        const ms = Date.now() - t1;

        if (result.kind === 'aborted_by_cap') {
            aborted = true;
            log(`ABORT: cap would be exceeded (${result.projected} > ${result.cap}) on ${spotifyId}`);
            queueProgressWrite(progress);  // force a write on abort
            return;
        }
        if (result.kind === 'ok') {
            const row = buildAnalysisRow(spotifyId, result.data);
            try {
                await upsertWithRetries('track_analyses', row, `ok ${spotifyId}`);
                analyzed++;
                progress.done.push(spotifyId);
                dirtyDoneSinceLastWrite++;
                log(`ok ${spotifyId} ${ms}ms (analyzed=${analyzed})`);
                maybeWriteProgress();
            } catch (err) {
                errored++;
                progress.errored.push({ id: spotifyId, reason: 'upsert: ' + err.message });
                warn(`upsert failed ${spotifyId} after retries: ${err.message}`);
                maybeWriteProgress({ force: true });
            }
        } else if (result.kind === 'not_found') {
            try {
                await upsertWithRetries('track_analyses', {
                    spotify_id:   spotifyId,
                    raw_analysis: null,
                    status:       'not_found',
                    analyzed_at:  new Date().toISOString(),
                }, `not_found ${spotifyId}`);
                notFound++;
                progress.done.push(spotifyId);
                dirtyDoneSinceLastWrite++;
                log(`not_found ${spotifyId} ${ms}ms`);
                maybeWriteProgress();
            } catch (err) {
                errored++;
                progress.errored.push({ id: spotifyId, reason: 'upsert not_found: ' + err.message });
                warn(`upsert (not_found) failed ${spotifyId} after retries: ${err.message}`);
                maybeWriteProgress({ force: true });
            }
        } else {
            errored++;
            const reason = result.reason || result.kind;
            progress.errored.push({ id: spotifyId, reason });
            try {
                await upsertWithRetries('track_analyses', {
                    spotify_id:   spotifyId,
                    raw_analysis: { error: reason },
                    status:       'error',
                    analyzed_at:  new Date().toISOString(),
                }, `error ${spotifyId}`);
            } catch (err) {
                warn(`upsert (error) failed ${spotifyId} after retries: ${err.message}`);
            }
            warn(`terminal ${spotifyId}: ${reason}`);
            maybeWriteProgress({ force: true });
        }
    }

    async function worker() {
        while (idx < toAnalyze.length && !aborted) {
            const spotifyId = toAnalyze[idx++];
            await processOne(spotifyId);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    queueProgressWrite(progress);   // final force-write to capture the last <25 done IDs
    await progressWriteQueue;

    const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
    const monthAfter = readCurrentMonthCount();
    log(`=== batch end ===`);
    log(`analyzed=${analyzed}  not_found=${notFound}  errored=${errored}`);
    log(`monthly counter after run: ${monthAfter} (cap=${cap})`);
    log(`elapsed: ${elapsedMin} min`);
    if (aborted) log('Run was aborted by cost cap. Re-run with a higher --max-rapidapi-calls to continue (will resume from where it stopped).');

    logStream.end();
}

main().catch((err) => {
    warn('UNCAUGHT: ' + (err.stack || err.message || err));
    logStream.end();
    process.exit(1);
});
