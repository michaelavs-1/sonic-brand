/* /api/v4/ami-cron-tick.js
   POST /api/v4/ami-cron-tick

   Vercel Cron target. Fires every minute (see vercel.json crons). Drives one
   scan_jobs row from pending -> fetching_tracks -> analyzing -> done. Runs a
   pool of 3 concurrent RapidAPI calls per invocation for the analyzing stage.
   maxDuration = 300s (Vercel Pro).

   Invariants:
     - Vercel Cron does not fire concurrently, so at most one instance of this
       endpoint runs at a time under normal operation.
     - `locked_at` protects against process crashes: a lock older than 10 min
       is treated as stale and the job becomes re-acquirable.
     - RapidAPI monthly cap is enforced via the `rapidapi_usage` table and the
       `increment_rapidapi_usage` RPC. If the projected call count would exceed
       SAFETY_THRESHOLD, all active jobs are set to 'paused' and the tick exits.

   Not a queue in the strict sense: only one playlist is worked per invocation.
   The next tick picks up the next playlist. This keeps each invocation small
   and each playlist's progress atomically visible in the dashboard.
*/

import { pgrSelect, pgrSelectIn, pgrUpsert, pgrInsert, pgrPatch, pgrRpc, pgrCount } from './supabase-client.js';

// Push a single line to scan_logs. Fire-and-forget style — we swallow errors
// so a hiccup in the log write can't crash the whole cron tick. The dashboard
// polls this table every ~2s to render the terminal panel.
async function pushLog(fields) {
    try {
        await pgrInsert('scan_logs', [fields]);
    } catch (err) {
        console.error('[cron] pushLog failed:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Constants (mirrored from ami-status.js — keep in sync).
// ---------------------------------------------------------------------------
const MONTHLY_CAP      = 50_000;
const SAFETY_THRESHOLD = 48_000;

const INVOCATION_BUDGET_MS = 270_000;   // leave 30s headroom under Vercel's 300s cap
const RAPIDAPI_CONCURRENCY = 3;
const STALE_LOCK_MINUTES   = 10;

// Simplified retry schedule vs. batch.mjs — a 300s function can't afford the
// huge back-offs the local runner uses. If a call fails after these, mark the
// job errored so the next tick moves on.
const RETRY_429_BACKOFF_MS = [3000, 8000];
const RETRY_5XX_BACKOFF_MS = [2000, 5000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function currentMonthUtc() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sameOriginUrl(req, pathname) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${proto}://${host}${pathname}`;
}

// ---------------------------------------------------------------------------
// Job selection: SELECT candidate, then optimistic UPDATE with a WHERE clause
// that would fail (returning zero rows) if someone else grabbed it first.
// ---------------------------------------------------------------------------

async function acquireNextJob() {
    const staleCutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60_000).toISOString();
    // PostgREST OR filter: locked_at IS NULL OR locked_at < staleCutoff
    const candidates = await pgrSelect('scan_jobs', {
        status: 'in.(pending,fetching_tracks,analyzing)',
        or:     `(locked_at.is.null,locked_at.lt.${staleCutoff})`,
    }, {
        select: 'playlist_id,playlist_title,playlist_url,genre,position_in_genre,business_types,status,tracks_total,tracks_analyzed,locked_at',
        order:  'priority.asc,created_at.asc',
        limit:  1,
    });
    if (!candidates.length) return null;
    const job = candidates[0];

    // Acquire lock: UPDATE only if locked_at is still what we saw. If someone
    // else raced us to the same job, this returns 0 rows and we try again next
    // tick — no big deal.
    const nowIso = new Date().toISOString();
    const wantOldLock = job.locked_at || null;
    const updated = await pgrRpc('acquire_scan_job_lock', {
        p_playlist_id:   job.playlist_id,
        p_expected_lock: wantOldLock,
        p_new_lock:      nowIso,
    }, { useService: true });
    // updated is a boolean or int per RPC design; if 0/false, someone raced us.
    if (!updated) return null;

    return { ...job, locked_at: nowIso };
}

async function releaseLock(playlistId, patch = {}) {
    // Use PATCH so we can never fall into an INSERT path — PostgREST's upsert
    // with partial payloads occasionally slipped into INSERT and violated
    // scan_jobs' NOT NULL constraints (playlist_title, playlist_url, etc.).
    // PATCH is a pure UPDATE. If the row doesn't exist, PATCH is a no-op
    // rather than a crash.
    //
    // Callers that want to preserve a possibly-changed status (e.g. because the
    // user hit STOP mid-flight and we don't want to overwrite 'stopped' with
    // 'analyzing' or 'done') simply omit `status` from `patch`.
    await pgrPatch('scan_jobs',
        { playlist_id: `eq.${playlistId}` },
        { locked_at: null, updated_at: new Date().toISOString(), ...patch },
    );
}

// Read the current status of a scan_job. Used mid-invocation to detect a
// user-initiated STOP (which sets status='stopped' while we hold the lock).
async function readJobStatus(playlistId) {
    const rows = await pgrSelect('scan_jobs',
        { playlist_id: `eq.${playlistId}` },
        { select: 'status', limit: 1 },
    );
    return rows[0]?.status || null;
}

// ---------------------------------------------------------------------------
// Stage 1: fetch tracks for a pending playlist.
// ---------------------------------------------------------------------------

async function fetchAllPlaylistTracks(req, playlistId) {
    // Spotify paginates at 100 per page for /playlists/{id}/tracks. Sonic-brand
    // playlists rarely exceed a few hundred tracks, so we cap at 500 (5 pages).
    const collected = [];
    for (let offset = 0; offset < 500; offset += 100) {
        const r = await fetch(sameOriginUrl(req, '/api/v4/spotify'), {
            method:  'POST',
            headers: {
                'Content-Type':     'application/json',
                'x-sonic-internal': process.env.INTERNAL_API_KEY || '',
            },
            body:    JSON.stringify({
                action:      'get_playlist_tracks',
                playlist_id: playlistId,
                offset,
                limit:       100,
                fields:      'items(track(id,name,artists(name)))',
            }),
        });
        if (!r.ok) throw new Error(`Spotify get_playlist_tracks -> ${r.status}`);
        const data = await r.json();
        const items = data?.items || [];
        for (const it of items) {
            const id = it?.track?.id;
            if (id) collected.push(id);
        }
        if (items.length < 100) break;
    }
    return collected;
}

async function transitionPendingToAnalyzing(req, job) {
    const spotifyIds = await fetchAllPlaylistTracks(req, job.playlist_id);
    const uniqueIds  = [...new Set(spotifyIds)];

    // Upsert playlist_tracks with position preserved (order returned by API).
    if (uniqueIds.length) {
        const rows = uniqueIds.map((sid, i) => ({
            playlist_id: job.playlist_id,
            spotify_id:  sid,
            position:    i + 1,
        }));
        // Chunk to keep payload sane.
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
            await pgrUpsert('playlist_tracks', rows.slice(i, i + CHUNK));
        }
    }

    // Insert playlist_genres so the runtime pipeline knows about this playlist.
    // (For legitimately new playlists, this row didn't exist yet. If it did —
    // rare edge case, e.g. Ami retried an old job — the upsert is a no-op.)
    await pgrUpsert('playlist_genres', [{
        playlist_id:       job.playlist_id,
        genre:             job.genre,
        position_in_genre: job.position_in_genre,
    }]);

    return { tracksTotal: uniqueIds.length };
}

// ---------------------------------------------------------------------------
// Stage 2: analyze remaining tracks via a pool of 3 concurrent RapidAPI calls.
// ---------------------------------------------------------------------------

async function callTrackAnalysisWithRetries(req, spotifyId, playlistCtx = {}) {
    let rate429Idx = 0;
    let serr5xxIdx = 0;

    while (true) {
        const r = await fetch(sameOriginUrl(req, '/api/v4/track-analysis'), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ action: 'analyze_track', spotify_id: spotifyId }),
        });

        // The proxy already handles a single 429; a second-tier 429 leaks
        // through as HTTP 429 or 502. Retry a bit here, then give up.
        if (r.status === 429) {
            if (rate429Idx >= RETRY_429_BACKOFF_MS.length) {
                return { kind: 'terminal', reason: '429 retries exhausted' };
            }
            const backoff = RETRY_429_BACKOFF_MS[rate429Idx];
            await pushLog({
                ...playlistCtx,
                spotify_id: spotifyId,
                level:      'warn',
                kind:       'retry',
                message:    `429 ${spotifyId} — backoff ${backoff}ms attempt ${rate429Idx + 1}/${RETRY_429_BACKOFF_MS.length}`,
            });
            await sleep(backoff);
            rate429Idx++;
            continue;
        }
        if (r.status === 502 || r.status === 503 || r.status === 504) {
            if (serr5xxIdx >= RETRY_5XX_BACKOFF_MS.length) {
                return { kind: 'terminal', reason: `${r.status} retries exhausted` };
            }
            const backoff = RETRY_5XX_BACKOFF_MS[serr5xxIdx];
            await pushLog({
                ...playlistCtx,
                spotify_id: spotifyId,
                level:      'warn',
                kind:       'retry',
                message:    `${r.status} ${spotifyId} — backoff ${backoff}ms attempt ${serr5xxIdx + 1}/${RETRY_5XX_BACKOFF_MS.length}`,
            });
            await sleep(backoff);
            serr5xxIdx++;
            continue;
        }

        const data = await r.json().catch(() => ({}));
        // Extract the proxy's passed-through RapidAPI usage so analyzeOne can
        // sync the Supabase counter to RapidAPI's authoritative value.
        const usage = data?._rapidapi_usage || null;

        if (!r.ok) return { kind: 'terminal', reason: data?.error || `HTTP ${r.status}`, usage };
        if (data.found === false) return { kind: 'not_found', usage };
        return { kind: 'ok', data, usage };
    }
}

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

async function analyzeOne(req, playlistId, playlistTitle, spotifyId) {
    const t0 = Date.now();
    const ctx = { playlist_id: playlistId, playlist_title: playlistTitle };
    console.log(`[cron] → analyze ${spotifyId} (start)`);
    // Reserve quota via a pre-call increment. Prevents runaway concurrent
    // spending if headers are missing. When the response returns, we prefer
    // RapidAPI's authoritative header value and OVERWRITE the counter to that.
    const preIncCount = await pgrRpc('increment_rapidapi_usage',
        { p_month: currentMonthUtc(), p_delta: 1 },
        { useService: true },
    );

    const result = await callTrackAnalysisWithRetries(req, spotifyId, ctx);
    const elapsedMs = Date.now() - t0;
    console.log(`[cron] ← analyze ${spotifyId} (${result.kind}, ${elapsedMs}ms)`);

    // Prefer RapidAPI's authoritative count when the proxy passed it through.
    let newCount = preIncCount;
    if (result.usage && Number.isFinite(result.usage.used)) {
        await pgrRpc('sync_rapidapi_usage',
            { p_month: currentMonthUtc(), p_calls: result.usage.used },
            { useService: true },
        );
        newCount = result.usage.used;
    }

    if (result.kind === 'ok') {
        await pgrUpsert('track_analyses', [buildAnalysisRow(spotifyId, result.data)]);
        await pushLog({
            ...ctx,
            spotify_id:  spotifyId,
            level:       'success',
            kind:        'track_ok',
            message:     `ok ${spotifyId} (${elapsedMs}ms)`,
            duration_ms: elapsedMs,
        });
        return { spotifyId, ok: true, newCount };
    }
    if (result.kind === 'not_found') {
        await pgrUpsert('track_analyses', [{
            spotify_id:  spotifyId,
            status:      'not_found',
            analyzed_at: new Date().toISOString(),
        }]);
        await pushLog({
            ...ctx,
            spotify_id:  spotifyId,
            level:       'info',
            kind:        'track_not_found',
            message:     `not_found ${spotifyId} (${elapsedMs}ms)`,
            duration_ms: elapsedMs,
        });
        return { spotifyId, ok: true, newCount };
    }
    // terminal — record but don't crash the whole job.
    await pgrUpsert('track_analyses', [{
        spotify_id:   spotifyId,
        status:       'error',
        raw_analysis: { reason: result.reason },
        analyzed_at:  new Date().toISOString(),
    }]);
    await pushLog({
        ...ctx,
        spotify_id:  spotifyId,
        level:       'error',
        kind:        'terminal',
        message:     `error ${spotifyId} — ${result.reason} (${elapsedMs}ms)`,
        duration_ms: elapsedMs,
    });
    return { spotifyId, ok: false, error: result.reason, newCount };
}

// Small worker pool of `n` concurrent workers pulling from a shared iterator.
// After each call, one worker also polls scan_jobs.status to detect a user-
// initiated STOP. Once `stopped` flips true, all workers exit as soon as they
// finish their in-flight call, so progress up to that call is preserved.
async function analyzePool(req, playlistId, playlistTitle, spotifyIds, n, deadline, onProgress) {
    let idx = 0;
    let paused = false;
    let stopped = false;
    async function worker() {
        while (idx < spotifyIds.length) {
            if (Date.now() > deadline) return;
            if (paused || stopped) return;
            const sid = spotifyIds[idx++];
            const result = await analyzeOne(req, playlistId, playlistTitle, sid);
            if (result.newCount >= SAFETY_THRESHOLD) paused = true;
            await onProgress(result);
            const currentStatus = await readJobStatus(playlistId);
            if (currentStatus === 'stopped') stopped = true;
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, spotifyIds.length) }, worker));
    return { paused, stopped };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
    // Vercel Cron sends POST from the platform. Also accept GET for manual
    // curl testing during local dev.
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const startedAt = Date.now();
    const deadline  = startedAt + INVOCATION_BUDGET_MS;
    console.log(`[cron] tick started at ${new Date(startedAt).toISOString()} (${req.method})`);

    try {
        // ---- Pre-flight: is the batch active? ----
        // batch_control.is_active is Ami's explicit Go/No-go. If false, cron
        // no-ops immediately — no work happens until he hits Start batch.
        console.log('[cron] checking batch_control.is_active...');
        const control = await pgrSelect('batch_control', { id: 'eq.1' }, { select: 'is_active', limit: 1 });
        const isActive = control?.[0]?.is_active === true;
        console.log(`[cron] batch_control.is_active = ${isActive}`);
        if (!isActive) {
            console.log('[cron] batch not active — exiting');
            return res.status(200).json({ ok: true, idle: true, reason: 'batch_control.is_active is false' });
        }

        // ---- Pre-flight cap check ----
        console.log('[cron] checking RapidAPI monthly usage...');
        const usageRows = await pgrSelect('rapidapi_usage', { month: `eq.${currentMonthUtc()}` }, { select: 'calls' });
        const monthlyCalls = usageRows?.[0]?.calls ?? 0;
        console.log(`[cron] monthly calls = ${monthlyCalls} / threshold ${SAFETY_THRESHOLD}`);
        if (monthlyCalls >= SAFETY_THRESHOLD) {
            console.log('[cron] cap reached — pausing all active jobs');
            // Pause any active jobs; they'll auto-resume next month when the
            // dashboard scan re-flags them or an admin does it manually.
            await pgrRpc('pause_active_scan_jobs', {}, { useService: true });
            return res.status(200).json({
                ok:     true,
                paused: true,
                reason: `Monthly cap reached: ${monthlyCalls} >= ${SAFETY_THRESHOLD}`,
            });
        }

        // ---- Acquire one job ----
        console.log('[cron] acquireNextJob...');
        const job = await acquireNextJob();
        if (!job) {
            console.log('[cron] no eligible job (all locked or none exist)');
            // acquireNextJob() only sees jobs that are NOT locked (or whose
            // lock is > 10 min stale). If it returned null, either:
            //   (a) there's genuinely no more runnable work — flip is_active off
            //       so the Start button reappears; OR
            //   (b) all runnable jobs are locked from a still-in-flight or
            //       recently-crashed previous invocation — leave is_active
            //       alone and wait for the lock to stale out.
            // We tell the two apart by counting jobs in runnable statuses
            // ignoring locks.
            const runnableCount = await pgrCount('scan_jobs', {
                status: 'in.(pending,fetching_tracks,analyzing)',
            });
            console.log(`[cron] runnable count (ignoring locks) = ${runnableCount}`);
            if (runnableCount === 0) {
                console.log('[cron] no runnable work at all — flipping is_active=false');
                await pgrRpc('set_batch_active', { p_active: false }, { useService: true });
                return res.status(200).json({ ok: true, idle: true, batchDrained: true });
            }
            console.log('[cron] runnable jobs exist but are locked — waiting');
            return res.status(200).json({
                ok: true,
                idle: true,
                waitingForLocksToExpire: runnableCount,
            });
        }
        console.log(`[cron] acquired job: ${job.playlist_id} "${job.playlist_title}" status=${job.status} tracks_total=${job.tracks_total} tracks_analyzed=${job.tracks_analyzed}`);

        // ---- Stage 1: pending -> analyzing (fetch tracks) ----
        if (job.status === 'pending') {
            console.log('[cron] stage=pending — fetching playlist tracks');
            try {
                const { tracksTotal } = await transitionPendingToAnalyzing(req, job);
                console.log(`[cron] fetched ${tracksTotal} tracks for ${job.playlist_id}`);
                // User may have hit STOP during the fetch. Don't overwrite the
                // 'stopped' status they set. Progress (playlist_tracks upserts)
                // is preserved; the next scan will revive this job to 'analyzing'.
                const currentStatus = await readJobStatus(job.playlist_id);
                if (currentStatus === 'stopped') {
                    await releaseLock(job.playlist_id, { tracks_total: tracksTotal });
                    return res.status(200).json({ ok: true, stopped: true, playlistId: job.playlist_id });
                }
                await releaseLock(job.playlist_id, {
                    status:       'analyzing',
                    tracks_total: tracksTotal,
                });
                job.status       = 'analyzing';
                job.tracks_total = tracksTotal;
            } catch (err) {
                console.error(`[cron] fetch_tracks FAILED for ${job.playlist_id}:`, err.message);
                await releaseLock(job.playlist_id, {
                    status: 'error',
                    error:  `fetch_tracks failed: ${err.message || String(err)}`,
                });
                return res.status(200).json({ ok: true, jobErrored: job.playlist_id, error: err.message });
            }
        }

        // ---- Stage 2: analyzing loop ----
        if (job.status === 'analyzing') {
            console.log('[cron] stage=analyzing — computing remaining tracks');
            // Fetch remaining spotify_ids for this playlist (not yet in track_analyses).
            const allTracks = await pgrSelect('playlist_tracks', {
                playlist_id: `eq.${job.playlist_id}`,
            }, { select: 'spotify_id,position', order: 'position.asc', limit: 500 });
            const trackIds = allTracks.map((r) => r.spotify_id);
            console.log(`[cron] playlist has ${trackIds.length} total tracks in playlist_tracks`);

            // If playlist_tracks is empty but scan_jobs.tracks_total suggests
            // there should be tracks, the fetch step was interrupted (or a
            // previous orphan cleanup wiped playlist_tracks without dropping
            // the scan_jobs row). Reset to 'pending' so the next tick re-runs
            // the fetch stage. Don't loop forever — if Spotify legitimately
            // returns 0 tracks, tracks_total will be 0 on the next visit and
            // this branch won't fire.
            if (trackIds.length === 0 && (job.tracks_total || 0) > 0) {
                console.log('[cron] playlist_tracks empty but tracks_total > 0 — resetting to pending for re-fetch');
                await releaseLock(job.playlist_id, {
                    status:       'pending',
                    tracks_total: 0,
                });
                return res.status(200).json({ ok: true, resetToPending: job.playlist_id });
            }

            const alreadyAnalyzed = trackIds.length
                ? await pgrSelectIn('track_analyses', 'spotify_id', trackIds, { select: 'spotify_id' })
                : [];
            const analyzedSet = new Set(alreadyAnalyzed.map((r) => r.spotify_id));
            const remaining = trackIds.filter((sid) => !analyzedSet.has(sid));
            console.log(`[cron] already analyzed: ${analyzedSet.size}, remaining: ${remaining.length}`);

            if (remaining.length === 0) {
                console.log('[cron] nothing remaining — marking done');
                await releaseLock(job.playlist_id, {
                    status:          'done',
                    tracks_analyzed: trackIds.length,
                });
                return res.status(200).json({ ok: true, jobDone: job.playlist_id, tracks: trackIds.length });
            }
            console.log(`[cron] beginning analyze pool (concurrency=${RAPIDAPI_CONCURRENCY})...`);
            await pushLog({
                playlist_id:    job.playlist_id,
                playlist_title: job.playlist_title,
                level:          'info',
                kind:           'job_start',
                message:        `▸ ${job.playlist_title} — ${remaining.length} tracks to analyze (${analyzedSet.size} already cached)`,
                tracks_total:   trackIds.length,
                tracks_analyzed: analyzedSet.size,
            });

            // Track how many we complete so we can bump tracks_analyzed.
            let completed = 0;
            const { paused, stopped } = await analyzePool(req, job.playlist_id, job.playlist_title, remaining, RAPIDAPI_CONCURRENCY, deadline, async () => {
                completed++;
                // Live-update tracks_analyzed so the dashboard progress bar moves
                // during the invocation. PATCH keeps this a pure UPDATE — no
                // risk of INSERT-with-nulls falling out of a partial upsert.
                await pgrPatch('scan_jobs',
                    { playlist_id: `eq.${job.playlist_id}` },
                    { tracks_analyzed: analyzedSet.size + completed, updated_at: new Date().toISOString() },
                );
            });

            console.log(`[cron] pool finished — completed=${completed}, paused=${paused}, stopped=${stopped}, elapsed=${Date.now() - startedAt}ms`);

            // Decide final status: stopped > paused > analyzing (more to go) > done.
            const stillRemaining = remaining.length - completed;
            if (stopped) {
                console.log('[cron] user hit STOP — releasing without status change');
                await pushLog({
                    playlist_id: job.playlist_id, playlist_title: job.playlist_title,
                    level: 'warn', kind: 'note',
                    message: `⏸ ${job.playlist_title} — user hit STOP (${completed} tracks in this tick)`,
                });
                await releaseLock(job.playlist_id, {
                    tracks_analyzed: analyzedSet.size + completed,
                });
                return res.status(200).json({ ok: true, stopped: true, playlistId: job.playlist_id, completed });
            }
            if (paused) {
                console.log('[cron] cap reached mid-pool — pausing');
                await pushLog({
                    playlist_id: job.playlist_id, playlist_title: job.playlist_title,
                    level: 'error', kind: 'note',
                    message: `⏸ RapidAPI monthly cap reached — batch paused`,
                });
                await releaseLock(job.playlist_id, { status: 'paused' });
                await pgrRpc('pause_active_scan_jobs', {}, { useService: true });
                return res.status(200).json({ ok: true, paused: true, playlistId: job.playlist_id, completed });
            }
            if (stillRemaining > 0) {
                console.log(`[cron] ${stillRemaining} tracks remaining — keeping status=analyzing for next tick`);
                await pushLog({
                    playlist_id: job.playlist_id, playlist_title: job.playlist_title,
                    level: 'info', kind: 'note',
                    message: `… ${job.playlist_title} — tick ended, ${stillRemaining} tracks remaining for next tick`,
                });
                await releaseLock(job.playlist_id, { status: 'analyzing' });
                return res.status(200).json({ ok: true, playlistId: job.playlist_id, completed, remaining: stillRemaining });
            }
            console.log('[cron] all tracks analyzed — marking done');
            await pushLog({
                playlist_id: job.playlist_id, playlist_title: job.playlist_title,
                level: 'success', kind: 'job_done',
                message: `✓ ${job.playlist_title} — ${trackIds.length} tracks done`,
                tracks_total: trackIds.length, tracks_analyzed: trackIds.length,
            });
            await releaseLock(job.playlist_id, {
                status:          'done',
                tracks_analyzed: analyzedSet.size + completed,
            });
            return res.status(200).json({ ok: true, jobDone: job.playlist_id, completed });
        }

        // Shouldn't reach here, but be defensive.
        console.warn(`[cron] unhandled job status: ${job.status}`);
        await releaseLock(job.playlist_id);
        return res.status(200).json({ ok: true, note: `unhandled status: ${job.status}` });
    } catch (err) {
        console.error('[cron] FAILED with error:', err.message, err.stack);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
