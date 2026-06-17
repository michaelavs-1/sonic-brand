// v4/precompute/add-playlist.mjs
//
// One-shot: link a single Spotify playlist to a Data Box genre, fetch its
// tracks, and analyze any tracks not already in track_analyses. Reuses the
// batch's retry/cap logic but scoped to a single playlist (small N, fast run).
//
// Use case: a playlist URL in the Data Box went 404 and you've found a
// replacement. Run this to slot the new playlist into the cache without
// re-running the full dry-run/batch.
//
// Required CLI args:
//   --playlist-id=<spotify_id>      the new playlist to add
//   --genre=<canonical-name>        Tab-2 genre name (case insensitive)
//   --max-rapidapi-calls=<N>        cap, same semantics as batch.mjs
//
// Optional CLI args:
//   --position=<1|2|...>            position_in_genre (default: 1)
//   --replace=<old_spotify_id>      delete the old playlist's rows first
//                                   (playlist_genres + playlist_tracks for it)
//   --concurrency=<N>               default 3
//
// Example (Modern Pop replacement):
//   node v4/precompute/add-playlist.mjs \
//     --playlist-id=2UK0SjIwJrb7aTzIol1Bak \
//     --genre="modern pop" \
//     --position=1 \
//     --replace=3ql2VqJSJT5HE5WLoTPf0e \
//     --max-rapidapi-calls=40000

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

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

const { pgrUpsert, pgrSelectIn, pgrDelete } = await import('../../api/v4/supabase-client.js');

const HARDCODED_CEILING = 50000;
const RAPIDAPI_HOST     = 'track-analysis.p.rapidapi.com';
const COUNTER_PATH      = path.join(STATE_DIR, 'rapidapi-call-count.json');
const LOG_PATH          = path.join(STATE_DIR, 'batch.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
    const args = {};
    for (const a of process.argv.slice(2)) {
        const m = a.match(/^--([a-z0-9-]+)(?:=(.+))?$/);
        if (m) args[m[1]] = m[2] ?? true;
    }
    return args;
}

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
    console.error(`[${new Date().toISOString()}] FATAL ${msg}`);
    logStream.write(`[${new Date().toISOString()}] FATAL ${msg}\n`);
    process.exit(1);
}

// ---------- monthly counter (same as batch.mjs) ----------
function readCounter() {
    if (!fs.existsSync(COUNTER_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf-8')); }
    catch { return {}; }
}
function currentYearMonth() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function bumpCounter(by = 1) {
    const counter = readCounter();
    const key = currentYearMonth();
    counter[key] = (counter[key] || 0) + by;
    for (let attempt = 0; attempt < 5; attempt++) {
        try { fs.writeFileSync(COUNTER_PATH, JSON.stringify(counter)); return counter[key]; }
        catch { const until = Date.now() + 50; while (Date.now() < until) { /* spin */ } }
    }
    return counter[key];
}
function readCurrentMonthCount() { return readCounter()[currentYearMonth()] || 0; }

// ---------- Spotify Client Credentials (mirrors api/v4/spotify.js) ----------
let ccToken = null, ccExpiry = 0;
async function getSpotifyToken() {
    if (ccToken && Date.now() < ccExpiry) return ccToken;
    const id = process.env.SPOTIFY_CLIENT_ID;
    const secret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!id || !secret) fail('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
        method:  'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    'grant_type=client_credentials',
    });
    if (!r.ok) fail(`Spotify token fetch failed: ${r.status}`);
    const data = await r.json();
    ccToken = data.access_token;
    ccExpiry = Date.now() + (data.expires_in * 1000) - 60000;
    return ccToken;
}

async function fetchPlaylistTracks(playlistId) {
    const ids = [];
    let offset = 0;
    while (true) {
        const token = await getSpotifyToken();
        const qs = new URLSearchParams({
            offset: String(offset),
            limit:  '100',
            market: 'IL',
            fields: 'items(track(id,is_playable))',
        }).toString();
        const r = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 404) { warn(`playlist ${playlistId} returned 404 (not found)`); return ids; }
        if (!r.ok) fail(`Spotify ${r.status} on playlist ${playlistId}: ${await r.text().catch(() => '')}`);
        const data = await r.json();
        const items = Array.isArray(data.items) ? data.items : [];
        for (const it of items) {
            const t = it?.track;
            if (t?.id && t.is_playable !== false) ids.push(t.id);
        }
        if (items.length < 100) break;
        offset += 100;
    }
    return ids;
}

// ---------- RapidAPI call (same shape detection as batch.mjs) ----------
async function callRapidApiOnce(spotifyId, apiKey) {
    const r = await fetch(`https://${RAPIDAPI_HOST}/pktx/spotify/${encodeURIComponent(spotifyId)}`, {
        method:  'GET',
        headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': RAPIDAPI_HOST },
    });
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
    if (data.error) return { kind: 'server_error', status: 200, body: `error payload: ${String(data.error).slice(0, 200)}` };
    const hasAtmospheric = data.energy != null || data.danceability != null || data.popularity != null;
    if (!hasAtmospheric) return { kind: 'not_found' };
    return { kind: 'ok', data };
}

const RETRY_429_BACKOFF_MS = [10000, 30000, 60000, 120000, 300000];
const RETRY_5XX_BACKOFF_MS = [5000, 15000, 45000, 120000, 300000, 600000];

async function callWithRetries(spotifyId, apiKey, cap) {
    let r429 = 0, r5xx = 0;
    while (true) {
        if (readCurrentMonthCount() + 1 > cap) return { kind: 'aborted_by_cap' };
        bumpCounter(1);
        let result;
        try { result = await callRapidApiOnce(spotifyId, apiKey); }
        catch (err) { result = { kind: 'network_error', message: err.message }; }
        if (result.kind === 'ok' || result.kind === 'not_found') return result;
        if (result.kind === 'rate_limited') {
            if (r429 >= RETRY_429_BACKOFF_MS.length) return { kind: 'terminal', reason: '429 retries exhausted' };
            await sleep(result.retryAfter > 0 ? Math.min(result.retryAfter * 1000, RETRY_429_BACKOFF_MS[r429]) : RETRY_429_BACKOFF_MS[r429]);
            r429++;
            continue;
        }
        if (r5xx >= RETRY_5XX_BACKOFF_MS.length) return { kind: 'terminal', reason: `${result.kind} retries exhausted` };
        warn(`${result.kind} on ${spotifyId}: ${result.status || ''} ${result.body || result.message || ''}; backoff ${RETRY_5XX_BACKOFF_MS[r5xx]}ms (attempt ${r5xx + 1}/${RETRY_5XX_BACKOFF_MS.length})`);
        await sleep(RETRY_5XX_BACKOFF_MS[r5xx]);
        r5xx++;
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

// ---------- main ----------
async function main() {
    const args = parseArgs();
    const playlistId = args['playlist-id'];
    const genreRaw   = args['genre'];
    if (!playlistId) fail('--playlist-id=<spotify_id> required');
    if (!genreRaw)   fail('--genre=<canonical-name> required');
    const cap = parseInt(args['max-rapidapi-calls'], 10);
    if (!Number.isFinite(cap) || cap <= 0) fail('--max-rapidapi-calls=N required, positive integer');
    if (cap > HARDCODED_CEILING) fail(`--max-rapidapi-calls=${cap} exceeds hardcoded ceiling ${HARDCODED_CEILING}.`);
    const position = args['position'] ? parseInt(args['position'], 10) : 1;
    const replace = args['replace'] || null;
    const genre = String(genreRaw).trim().toLowerCase();

    const apiKey = process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;
    if (!apiKey) fail('TRACK_ANALYSIS_RAPIDAPI_KEY not set in env');

    log(`=== add-playlist start ===`);
    log(`  playlist_id : ${playlistId}`);
    log(`  genre       : "${genre}"`);
    log(`  position    : ${position}`);
    log(`  replace     : ${replace || '(none)'}`);
    log(`  cap         : ${cap} (current month counter: ${readCurrentMonthCount()})`);

    // 1. (Optional) Remove the replaced playlist's links + tracks.
    if (replace) {
        log(`Removing old playlist ${replace}...`);
        try {
            await pgrDelete('playlist_genres', { playlist_id: `eq.${replace}`, genre: `eq.${genre}` });
            log(`  deleted playlist_genres row(s) for old playlist`);
        } catch (e) { warn(`  playlist_genres delete failed: ${e.message}`); }
        try {
            await pgrDelete('playlist_tracks', { playlist_id: `eq.${replace}` });
            log(`  deleted playlist_tracks row(s) for old playlist`);
        } catch (e) { warn(`  playlist_tracks delete failed: ${e.message}`); }
    }

    // 2. Fetch tracks for the new playlist.
    log(`Fetching tracks for playlist ${playlistId} from Spotify...`);
    const t0 = Date.now();
    const trackIds = await fetchPlaylistTracks(playlistId);
    log(`  ${trackIds.length} playable tracks fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (trackIds.length === 0) fail('Playlist returned 0 tracks. Aborting — nothing to add.');

    // 3. Upsert playlist_genres + playlist_tracks (deduped within the playlist).
    log(`Upserting playlist_genres row (playlist=${playlistId}, genre="${genre}", pos=${position})...`);
    await pgrUpsert('playlist_genres', [{ playlist_id: playlistId, genre, position_in_genre: position }]);

    const ptRows = [];
    const seen = new Set();
    let dropped = 0;
    trackIds.forEach((sid, i) => {
        const key = `${playlistId}|${sid}`;
        if (seen.has(key)) { dropped++; return; }
        seen.add(key);
        ptRows.push({ playlist_id: playlistId, spotify_id: sid, position: i });
    });
    log(`Upserting playlist_tracks (${ptRows.length} unique rows; dropped ${dropped} duplicates)...`);
    const CHUNK = 1000;
    for (let i = 0; i < ptRows.length; i += CHUNK) {
        await pgrUpsert('playlist_tracks', ptRows.slice(i, i + CHUNK));
    }

    // 4. Identify which spotify_ids still need analysis.
    log(`Live-checking which tracks are already analyzed...`);
    const existing = await pgrSelectIn('track_analyses', 'spotify_id', trackIds, { select: 'spotify_id' });
    const cachedSet = new Set(existing.map((r) => r.spotify_id));
    const toAnalyze = trackIds.filter((id) => !cachedSet.has(id));
    log(`  already cached: ${cachedSet.size}`);
    log(`  to analyze:     ${toAnalyze.length}`);

    if (toAnalyze.length === 0) {
        log('Nothing to analyze. All tracks already cached.');
        log('=== add-playlist end ===');
        logStream.end();
        return;
    }

    if (readCurrentMonthCount() + toAnalyze.length > cap) {
        fail(`Current month counter (${readCurrentMonthCount()}) + ${toAnalyze.length} would exceed --max-rapidapi-calls=${cap}.`);
    }

    // 5. RapidAPI phase. Worker pool of `concurrency`.
    const concurrency = args['concurrency'] ? parseInt(args['concurrency'], 10) : 3;
    log(`Starting RapidAPI phase (concurrency=${concurrency})...`);
    let analyzed = 0, notFound = 0, errored = 0, aborted = false;
    let idx = 0;

    async function processOne(spotifyId) {
        const t1 = Date.now();
        const result = await callWithRetries(spotifyId, apiKey, cap);
        const ms = Date.now() - t1;
        if (result.kind === 'aborted_by_cap') { aborted = true; log(`ABORT on ${spotifyId}: cap exceeded`); return; }
        if (result.kind === 'ok') {
            try { await pgrUpsert('track_analyses', buildAnalysisRow(spotifyId, result.data)); analyzed++; log(`ok ${spotifyId} ${ms}ms (analyzed=${analyzed})`); }
            catch (err) { errored++; warn(`upsert failed ${spotifyId}: ${err.message}`); }
        } else if (result.kind === 'not_found') {
            try { await pgrUpsert('track_analyses', { spotify_id: spotifyId, raw_analysis: null, status: 'not_found', analyzed_at: new Date().toISOString() }); notFound++; log(`not_found ${spotifyId} ${ms}ms`); }
            catch (err) { errored++; warn(`upsert not_found failed ${spotifyId}: ${err.message}`); }
        } else {
            errored++;
            try { await pgrUpsert('track_analyses', { spotify_id: spotifyId, raw_analysis: { error: result.reason || result.kind }, status: 'error', analyzed_at: new Date().toISOString() }); }
            catch (err) { warn(`upsert error failed ${spotifyId}: ${err.message}`); }
            warn(`terminal ${spotifyId}: ${result.reason || result.kind}`);
        }
    }

    async function worker() {
        while (idx < toAnalyze.length && !aborted) {
            const id = toAnalyze[idx++];
            await processOne(id);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    log(`=== add-playlist end ===`);
    log(`  analyzed=${analyzed}  not_found=${notFound}  errored=${errored}`);
    log(`  monthly counter after run: ${readCurrentMonthCount()}`);
    logStream.end();
}

main().catch((err) => {
    warn('UNCAUGHT: ' + (err.stack || err.message || err));
    logStream.end();
    process.exit(1);
});
