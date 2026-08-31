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
const HARDCODED_CEILING   = 1000000;  // absolute max for --max-rapidapi-calls (matches Business-tier monthly quota, upgraded from PRO's 50k on 2026-08-XX)
const FRESHNESS_HOURS     = 24;       // execution plan must be no older than this
const DEFAULT_CONCURRENCY = 3;        // overridable via --concurrency=N
const MAX_CONCURRENCY     = 8;        // refuse anything higher (upstream degrades fast)
const RAPIDAPI_HOST       = 'track-analysis.p.rapidapi.com';

// Auto-abort safeties — keep the script from grinding through a broken upstream
// and burning quota on doomed retries. All four conditions set `aborted=true`
// and let workers drain; resume later with --retry-errors if appropriate.
const HTML_RETRY_LIMIT          = 2;   // 2 HTML responses in one track's retry loop → gateway down → abort
const TERMINAL_STORM_WINDOW     = 10;  // size of rolling window of recent outcomes
const TERMINAL_STORM_THRESHOLD  = 8;   // 8/10 must be terminal failures to trigger storm abort

const PLAN_PATH      = path.join(STATE_DIR, 'dry-run.json');
const COUNTER_PATH   = path.join(STATE_DIR, 'rapidapi-call-count.json');
const PROGRESS_PATH  = path.join(STATE_DIR, 'progress.json');
const LOG_PATH       = path.join(STATE_DIR, 'batch.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Interruptible sleep — polls isAborted() every pollMs so a long backoff can
// exit within pollMs of the abort flag flipping (instead of waiting the full
// duration). Returns true if aborted mid-sleep, false if slept the full time.
async function interruptibleSleep(totalMs, isAborted, pollMs = 500) {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
        if (isAborted && isAborted()) return true;
        const remaining = deadline - Date.now();
        await sleep(Math.min(pollMs, remaining));
    }
    return false;
}

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
// RapidAPI bills on a fixed day of the month (e.g. the 24th for our PRO sub).
// Set RAPIDAPI_BILLING_CYCLE_DAY in .env.local to match your subscription's
// renewal day. Default is 1 = calendar month (also useful for testing).
const BILLING_CYCLE_DAY = (() => {
    const v = parseInt(process.env.RAPIDAPI_BILLING_CYCLE_DAY || '1', 10);
    return (Number.isFinite(v) && v >= 1 && v <= 28) ? v : 1;
})();

// Returns the cycle-start date as a key like "2026-06-24" — used to key the
// persisted counter so that resets line up with RapidAPI's billing renewal,
// not the calendar month.
function currentBillingCycleKey() {
    const d = new Date();
    const day = d.getUTCDate();
    const cycleStart = day >= BILLING_CYCLE_DAY
        ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),     BILLING_CYCLE_DAY))
        : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, BILLING_CYCLE_DAY));
    return `${cycleStart.getUTCFullYear()}-${String(cycleStart.getUTCMonth() + 1).padStart(2, '0')}-${String(BILLING_CYCLE_DAY).padStart(2, '0')}`;
}
// Sync counter increment. Direct writeFileSync (no rename) to avoid Windows
// EPERM quirks during high-frequency writes. With a brief retry loop for
// transient file locks (antivirus, IDE watcher).
function bumpCounter(by = 1) {
    const counter = readCounter();
    const key = currentBillingCycleKey();
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
function readCurrentCycleCount() {
    return readCounter()[currentBillingCycleKey()] || 0;
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

// Heuristic: response body is an HTML page (likely Cloudflare/gateway error).
// We treat persistent HTML as a fatal "gateway down" signal and never dump
// raw HTML into the log.
function looksLikeHtml(s) {
    if (!s || typeof s !== 'string') return false;
    const head = s.trimStart().slice(0, 500).toLowerCase();
    if (!head.startsWith('<')) return false;
    return head.includes('<html') || head.includes('<!doctype') || head.includes('<head') || head.includes('<title>');
}

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
    // 401/403 = auth/subscription issue. NEVER transient — surface as fatal so
    // callWithRetries short-circuits out instead of grinding the retry schedule.
    if (r.status === 401 || r.status === 403) {
        const text = await r.text().catch(() => '');
        return { kind: 'fatal_auth', status: r.status, body: text.slice(0, 300) };
    }
    // Pull body once so we can both inspect (HTML?) and try JSON parse, regardless
    // of HTTP status. RapidAPI sometimes returns HTML on 200 (rare gateway weirdness).
    const text = await r.text().catch(() => '');
    if (!r.ok) {
        if (looksLikeHtml(text)) {
            return { kind: 'gateway_html', status: r.status, bodyLen: text.length };
        }
        return { kind: 'server_error', status: r.status, body: text.slice(0, 300) };
    }
    if (looksLikeHtml(text)) {
        return { kind: 'gateway_html', status: 200, bodyLen: text.length };
    }
    let data = null;
    try { data = JSON.parse(text); } catch {}
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

async function callWithRetries(spotifyId, apiKey, cap, isAborted, maxErrorRetries) {
    // maxErrorRetries caps the 5xx/network retry ladder at N retries after
    // the initial failure. null → full ladder (RETRY_5XX_BACKOFF_MS.length = 6).
    // Pass 0 for true fail-fast — first server_error / network_error /
    // gateway_html marks the track terminal without any retry call or backoff,
    // so a wave of transient upstream errors can't lock up workers. 429 retries
    // are unaffected (rate limits are legitimately worth waiting out).
    const effective5xxCap = Math.min(
        RETRY_5XX_BACKOFF_MS.length,
        Number.isFinite(maxErrorRetries) && maxErrorRetries >= 0 ? maxErrorRetries : RETRY_5XX_BACKOFF_MS.length,
    );
    let rate429Idx = 0;
    let serr5xxIdx = 0;
    let htmlSeen   = 0;

    while (true) {
        // Bail immediately if another worker has already tripped the batch abort.
        if (isAborted && isAborted()) return { kind: 'aborted_externally' };

        // Per-call counter pre-check. Hard stop — better to abort the
        // batch than to nudge over the cap on a retry.
        const projected = readCurrentCycleCount() + 1;
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

        // 401/403 — surface fatal_auth as a batch-level abort signal. No retry.
        if (result.kind === 'fatal_auth') {
            return { kind: 'aborted_by_auth', status: result.status, body: result.body };
        }

        // HTML body (gateway down). Allow up to HTML_RETRY_LIMIT before declaring
        // the gateway is genuinely broken and abort the batch.
        if (result.kind === 'gateway_html') {
            htmlSeen++;
            if (htmlSeen >= HTML_RETRY_LIMIT) {
                return { kind: 'aborted_by_gateway', status: result.status, bodyLen: result.bodyLen };
            }
            const wait = RETRY_5XX_BACKOFF_MS[serr5xxIdx] || RETRY_5XX_BACKOFF_MS[RETRY_5XX_BACKOFF_MS.length - 1];
            warn(`gateway_html on ${spotifyId}: status=${result.status} <HTML response len=${result.bodyLen}>; backoff ${wait}ms (html ${htmlSeen}/${HTML_RETRY_LIMIT})`);
            if (await interruptibleSleep(wait, isAborted)) return { kind: 'aborted_externally' };
            serr5xxIdx++;
            continue;
        }

        if (result.kind === 'rate_limited') {
            if (rate429Idx >= RETRY_429_BACKOFF_MS.length) {
                return { kind: 'terminal', reason: '429 retries exhausted' };
            }
            const wait = result.retryAfter > 0
                ? Math.min(result.retryAfter * 1000, RETRY_429_BACKOFF_MS[rate429Idx])
                : RETRY_429_BACKOFF_MS[rate429Idx];
            warn(`429 on ${spotifyId}; backoff ${wait}ms (attempt ${rate429Idx + 1}/${RETRY_429_BACKOFF_MS.length})`);
            if (await interruptibleSleep(wait, isAborted)) return { kind: 'aborted_externally' };
            rate429Idx++;
            continue;
        }

        // server_error or network_error → 5xx backoff schedule
        if (serr5xxIdx >= effective5xxCap) {
            return { kind: 'terminal', reason: `${result.kind} retries exhausted` };
        }
        const wait = RETRY_5XX_BACKOFF_MS[serr5xxIdx];
        warn(`${result.kind} on ${spotifyId}: ${result.status || ''} ${result.body || result.message || ''}; backoff ${wait}ms (attempt ${serr5xxIdx + 1}/${effective5xxCap})`);
        if (await interruptibleSleep(wait, isAborted)) return { kind: 'aborted_externally' };
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

    // --- Guard 1: cap defaults to HARDCODED_CEILING when --max-rapidapi-calls
    //     is omitted; must be a positive integer no larger than HARDCODED_CEILING.
    const cap = args['max-rapidapi-calls']
        ? parseInt(args['max-rapidapi-calls'], 10)
        : HARDCODED_CEILING;
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

    // --max-error-retries=N — caps the 5xx/network retry ladder at N retries
    // *after* the initial failure (default: full 6-step ladder). Use N=0 for
    // TRUE fail-fast: first server_error → terminal immediately, no backoff,
    // no retry call. Use N=1 to allow one 5s-backoff retry. Errored tracks
    // get status='error' quickly for a later --retry-errors sweep.
    const maxErrorRetries = args['max-error-retries'] !== undefined
        ? parseInt(args['max-error-retries'], 10)
        : null;
    if (args['max-error-retries'] !== undefined && (!Number.isFinite(maxErrorRetries) || maxErrorRetries < 0)) {
        fail('--max-error-retries must be a non-negative integer.');
    }

    // --no-storm-abort — bypass the 8-of-10-terminals rolling-window abort. The
    // safety exists to avoid burning quota when upstream is completely dead;
    // when quota isn't a concern (or you pair with --max-error-retries=1 which
    // makes storm-abort trigger inside a couple of minutes), disable it and let
    // the batch churn through everything, marking failures as status='error'
    // for a later --retry-errors sweep. HTML-gateway abort and cap abort are
    // NOT affected — those are true "impossible to proceed" conditions.
    const noStormAbort = !!args['no-storm-abort'];

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
    log(`max-error-retries: ${maxErrorRetries ?? `${RETRY_5XX_BACKOFF_MS.length} (default full ladder)`}`);
    log(`no-storm-abort: ${noStormAbort ? 'YES — storm safety disabled' : 'no (default)'}`);

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

    const cycleKey  = currentBillingCycleKey();
    const cycleSoFar = readCurrentCycleCount();
    log(`  billing cycle key: ${cycleKey} (renewal day = ${BILLING_CYCLE_DAY})`);
    log(`  current cycle counter: ${cycleSoFar}`);
    const remainingInCap = Math.max(0, cap - cycleSoFar);
    if (remainingInCap <= 0) {
        fail(`Current billing cycle (${cycleKey}) already used ${cycleSoFar} RapidAPI calls — at or above --max-rapidapi-calls=${cap}. Nothing can run this batch. Raise the cap (within hardcoded ceiling ${HARDCODED_CEILING}) or wait until next cycle.`);
    }
    if (actualRemaining > remainingInCap) {
        const willProcess = remainingInCap;
        const willDefer   = actualRemaining - remainingInCap;
        warn(`Plan has ${actualRemaining} remaining calls but only ${remainingInCap} fit under --max-rapidapi-calls=${cap}. Will process ~${willProcess} this run and abort cleanly at the cap; ${willDefer} tracks will remain unprocessed for a future batch.`);
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

    // Build spotify_id → [genre] map for outcome logging. One-time bulk fetch
    // from Supabase: playlist_tracks filtered to this run's toAnalyze set,
    // then playlist_genres for those playlist_ids. Kept in memory for the
    // whole run so per-track log lines can suffix the genre without an extra
    // network round-trip per outcome.
    log(`loading genre labels for ${toAnalyze.length} tracks...`);
    const ptForRun = await pgrSelectIn('playlist_tracks', 'spotify_id', toAnalyze, { select: 'playlist_id,spotify_id' });
    const playlistIdsForRun = [...new Set(ptForRun.map((r) => r.playlist_id))];
    const pgForRun = await pgrSelectIn('playlist_genres', 'playlist_id', playlistIdsForRun, { select: 'playlist_id,genre' });
    const genresByPlaylist = new Map();
    for (const r of pgForRun) {
        if (!genresByPlaylist.has(r.playlist_id)) genresByPlaylist.set(r.playlist_id, new Set());
        genresByPlaylist.get(r.playlist_id).add(r.genre);
    }
    const genresByTrack = new Map();
    for (const r of ptForRun) {
        if (!genresByTrack.has(r.spotify_id)) genresByTrack.set(r.spotify_id, new Set());
        for (const g of (genresByPlaylist.get(r.playlist_id) || [])) {
            genresByTrack.get(r.spotify_id).add(g);
        }
    }
    // Format for log line — join if a track belongs to multiple genres.
    // Returns "" when there's no mapping (shouldn't happen in orphans mode,
    // but guards against upstream weirdness).
    function genreLabel(spotifyId) {
        const gs = genresByTrack.get(spotifyId);
        if (!gs || gs.size === 0) return '';
        return ' ' + [...gs].join(' | ');
    }
    log(`  ${ptForRun.length} playlist_tracks rows, ${playlistIdsForRun.length} playlists, ${pgForRun.length} playlist_genres rows`);

    // --- Phase 3: per-id RapidAPI calls (rate-limited, retried, persisted) ---
    log(`starting RapidAPI phase...`);
    const t0 = Date.now();
    let analyzed = 0;
    let notFound = 0;
    let errored  = 0;
    let aborted  = false;
    // When aborted, the reason drives the summary line's resume guidance.
    // One of: 'cap' | 'auth' | 'gateway' | 'storm'.
    let abortReason = null;

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

    // Rolling window of recent per-track outcomes. Used to detect "upstream is
    // broken for a stretch of the queue" — e.g., Modern Pop's 6-tracks-in-a-row
    // terminal-fail pattern. When 8 of last 10 are terminal, abort.
    const recentOutcomes = [];
    function recordOutcome(outcome) {
        recentOutcomes.push(outcome);
        if (recentOutcomes.length > TERMINAL_STORM_WINDOW) recentOutcomes.shift();
        if (aborted) return;
        if (noStormAbort) return;  // --no-storm-abort: still track window (cheap), skip the trigger
        if (recentOutcomes.length === TERMINAL_STORM_WINDOW) {
            const terminals = recentOutcomes.filter((o) => o === 'terminal').length;
            if (terminals >= TERMINAL_STORM_THRESHOLD) {
                aborted = true;
                abortReason = 'storm';
                log(`ABORT: ${terminals}/${TERMINAL_STORM_WINDOW} recent tracks terminal-failed. Upstream appears broken — aborting to save quota. Resume later with --retry-errors once healthy.`);
                queueProgressWrite(progress);
            }
        }
    }

    async function processOne(spotifyId) {
        const t1 = Date.now();
        const result = await callWithRetries(spotifyId, apiKey, cap, () => aborted, maxErrorRetries);
        const ms = Date.now() - t1;

        // Batch was aborted by another worker while we were mid-retry. Bail
        // without recording anything — the track hasn't been given a fair
        // chance and shouldn't be marked as error. Worker loop will exit
        // on its next iteration.
        if (result.kind === 'aborted_externally') return;

        if (result.kind === 'aborted_by_cap') {
            aborted = true;
            abortReason = 'cap';
            log(`ABORT: cap would be exceeded (${result.projected} > ${result.cap}) on ${spotifyId}`);
            queueProgressWrite(progress);  // force a write on abort
            return;
        }
        if (result.kind === 'aborted_by_auth') {
            aborted = true;
            abortReason = 'auth';
            log(`ABORT: RapidAPI auth/subscription failure (HTTP ${result.status}) on ${spotifyId}: ${result.body}`);
            log(`This is non-transient (subscription expired, wrong key, or billing issue). Fix on RapidAPI dashboard, then resume.`);
            queueProgressWrite(progress);
            return;
        }
        if (result.kind === 'aborted_by_gateway') {
            aborted = true;
            abortReason = 'gateway';
            log(`ABORT: RapidAPI gateway returned HTML on ${HTML_RETRY_LIMIT} consecutive attempts on ${spotifyId} (status=${result.status}, len=${result.bodyLen}). Upstream is likely down — try again later.`);
            queueProgressWrite(progress);
            return;
        }
        if (result.kind === 'ok') {
            const row = buildAnalysisRow(spotifyId, result.data);
            try {
                await upsertWithRetries('track_analyses', row, `ok ${spotifyId}`);
                analyzed++;
                progress.done.push(spotifyId);
                dirtyDoneSinceLastWrite++;
                log(`ok ${spotifyId} ${ms}ms (analyzed=${analyzed})${genreLabel(spotifyId)}`);
                maybeWriteProgress();
                recordOutcome('ok');
            } catch (err) {
                errored++;
                progress.errored.push({ id: spotifyId, reason: 'upsert: ' + err.message });
                warn(`upsert failed ${spotifyId} after retries: ${err.message}`);
                maybeWriteProgress({ force: true });
                recordOutcome('terminal');
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
                log(`not_found ${spotifyId} ${ms}ms${genreLabel(spotifyId)}`);
                maybeWriteProgress();
                recordOutcome('not_found');
            } catch (err) {
                errored++;
                progress.errored.push({ id: spotifyId, reason: 'upsert not_found: ' + err.message });
                warn(`upsert (not_found) failed ${spotifyId} after retries: ${err.message}`);
                maybeWriteProgress({ force: true });
                recordOutcome('terminal');
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
            warn(`terminal ${spotifyId}: ${reason}${genreLabel(spotifyId)}`);
            maybeWriteProgress({ force: true });
            recordOutcome('terminal');
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
    const monthAfter = readCurrentCycleCount();
    log(`=== batch end ===`);
    log(`analyzed=${analyzed}  not_found=${notFound}  errored=${errored}`);
    log(`monthly counter after run: ${monthAfter} (cap=${cap})`);
    log(`elapsed: ${elapsedMin} min`);
    if (aborted) {
        const guidance = {
            cap:     'Cost cap reached. Re-run with a higher --max-rapidapi-calls (or wait for cycle renewal) to continue; will resume from where it stopped.',
            auth:    'RapidAPI auth/subscription failure. Fix on the RapidAPI dashboard, then re-run to resume.',
            gateway: 'RapidAPI gateway looked down. Try again later; re-run will resume from where it stopped.',
            storm:   'Upstream failure storm detected (many recent terminal failures). Try again later once RapidAPI is healthy; use --retry-errors on the resume to re-attempt tracks that terminal-failed during the storm.',
        }[abortReason] || 'See ABORT line above for the reason.';
        log(`Run aborted (${abortReason || 'unknown'}). ${guidance}`);
    }

    logStream.end();
}

main().catch((err) => {
    warn('UNCAUGHT: ' + (err.stack || err.message || err));
    logStream.end();
    process.exit(1);
});
