// v4/precompute/deepen-genres.mjs
//
// Expand the cache by deepening playlist coverage for every biz type's
// genres. Round-robin order: for each round R, walk through all the
// genres in canonical (sheet) order and pull the R-th playlist for that
// genre. R starts at 3 by default (positions 1 and 2 are already cached
// from the initial pass via dry-run.mjs + batch.mjs).
//
// Scope: every biz type in Tab 1 with column H populated (same rule as
// dry-run.mjs and populate-biztype-genres.mjs).
//
// Each playlist is processed fully (fetch from Spotify → upsert
// playlist_genres + playlist_tracks → analyze any new tracks) before the
// next one starts, so the order in the log mirrors the round-robin pattern
// exactly. Within a single playlist, analysis uses the worker-pool concurrency
// from --concurrency.
//
// Resumable: any (playlist_id, genre) already in playlist_genres is skipped.
// Stops cleanly when the monthly RapidAPI cap would be exceeded or when no
// more playlists exist at the current round for any genre.
//
// Required CLI args:
//   --max-rapidapi-calls=<N>   total monthly cap (same semantics as batch.mjs)
//
// Optional CLI args:
//   --start-round=<N>          start at position N (default 3)
//   --max-round=<N>            stop after round N (default 15 — Tab 2 max)
//   --concurrency=<N>          analyses in parallel within a playlist (default 3)
//
// Prereqs: vercel dev running on :3000 (for the databox/spotify proxies).
//
// Example:
//   node v4/precompute/deepen-genres.mjs --max-rapidapi-calls=40000

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

const { pgrSelect, pgrSelectIn, pgrUpsert } = await import('../../api/v4/supabase-client.js');

const HARDCODED_CEILING = 50000;
const RAPIDAPI_HOST     = 'track-analysis.p.rapidapi.com';
const COUNTER_PATH      = path.join(STATE_DIR, 'rapidapi-call-count.json');
const LOG_PATH          = path.join(STATE_DIR, 'batch.log');
const BASE              = process.env.DEV_BASE || 'http://localhost:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm  = (s) => String(s || '').trim().toLowerCase();

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

// ---------- counter / quota cap (same as batch.mjs) ----------
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
        if (r.status === 404) { warn(`playlist ${playlistId} returned 404 — dead link`); return ids; }
        if (!r.ok) { warn(`Spotify ${r.status} on playlist ${playlistId}`); return ids; }
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

// ---------- RapidAPI (same shape detection as batch.mjs) ----------
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

async function getJSON(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GET ${url} ${r.status}`);
    return data;
}

// ---------- Process a single playlist: fetch + upsert + analyze ----------
async function processPlaylist({ genre, position, playlist_id, apiKey, cap, concurrency }) {
    log(`--- ${genre} pos ${position} — playlist ${playlist_id} ---`);

    // Skip if already linked
    const existingLink = await pgrSelect('playlist_genres', { playlist_id: `eq.${playlist_id}`, genre: `eq.${genre}` }, { select: 'playlist_id' });
    if (existingLink.length > 0) {
        log(`  already in playlist_genres, skipping`);
        return { skipped: true };
    }

    const trackIds = await fetchPlaylistTracks(playlist_id);
    log(`  ${trackIds.length} playable tracks fetched`);
    if (trackIds.length === 0) {
        log(`  empty playlist (or 404), skipping`);
        return { skipped: true };
    }

    await pgrUpsert('playlist_genres', [{ playlist_id, genre, position_in_genre: position }]);
    const ptRows = [];
    const seen = new Set();
    let dropped = 0;
    trackIds.forEach((sid, i) => {
        const k = `${playlist_id}|${sid}`;
        if (seen.has(k)) { dropped++; return; }
        seen.add(k);
        ptRows.push({ playlist_id, spotify_id: sid, position: i });
    });
    const CHUNK = 1000;
    for (let i = 0; i < ptRows.length; i += CHUNK) {
        await pgrUpsert('playlist_tracks', ptRows.slice(i, i + CHUNK));
    }

    const existing = await pgrSelectIn('track_analyses', 'spotify_id', trackIds, { select: 'spotify_id' });
    const cachedSet = new Set(existing.map((r) => r.spotify_id));
    const toAnalyze = trackIds.filter((id) => !cachedSet.has(id));
    log(`  already cached: ${cachedSet.size}, to analyze: ${toAnalyze.length}`);

    if (toAnalyze.length === 0) return { skipped: false, analyzed: 0, aborted: false };

    let analyzed = 0, notFound = 0, errored = 0, aborted = false;
    let idx = 0;

    async function processOne(spotifyId) {
        const t1 = Date.now();
        const result = await callWithRetries(spotifyId, apiKey, cap);
        const ms = Date.now() - t1;
        if (result.kind === 'aborted_by_cap') { aborted = true; return; }
        if (result.kind === 'ok') {
            try { await pgrUpsert('track_analyses', buildAnalysisRow(spotifyId, result.data)); analyzed++; log(`  ok ${spotifyId} ${ms}ms`); }
            catch (err) { errored++; warn(`upsert failed ${spotifyId}: ${err.message}`); }
        } else if (result.kind === 'not_found') {
            try { await pgrUpsert('track_analyses', { spotify_id: spotifyId, raw_analysis: null, status: 'not_found', analyzed_at: new Date().toISOString() }); notFound++; log(`  not_found ${spotifyId} ${ms}ms`); }
            catch (err) { errored++; warn(`upsert not_found failed: ${err.message}`); }
        } else {
            errored++;
            try { await pgrUpsert('track_analyses', { spotify_id: spotifyId, raw_analysis: { error: result.reason || result.kind }, status: 'error', analyzed_at: new Date().toISOString() }); }
            catch {}
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

    log(`  playlist done: analyzed=${analyzed} not_found=${notFound} errored=${errored} aborted=${aborted}`);
    return { skipped: false, analyzed, notFound, errored, aborted };
}

// ---------- main ----------
async function main() {
    const args = parseArgs();
    const cap = parseInt(args['max-rapidapi-calls'], 10);
    if (!Number.isFinite(cap) || cap <= 0) fail('--max-rapidapi-calls=<N> required');
    if (cap > HARDCODED_CEILING) fail(`--max-rapidapi-calls=${cap} exceeds ceiling ${HARDCODED_CEILING}`);
    const concurrency = args['concurrency'] ? parseInt(args['concurrency'], 10) : 3;
    const startRound = args['start-round'] ? parseInt(args['start-round'], 10) : 3;
    const maxRound = args['max-round'] ? parseInt(args['max-round'], 10) : 15;
    const apiKey = process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;
    if (!apiKey) fail('TRACK_ANALYSIS_RAPIDAPI_KEY not set');

    log(`=== deepen-genres start ===`);
    log(`  cap              : ${cap} (current month counter: ${readCurrentMonthCount()})`);
    log(`  rounds           : ${startRound} → ${maxRound}`);
    log(`  concurrency      : ${concurrency}`);

    // 1. Fetch Tab 1, pick the H-populated row for every biz type
    const tab1 = await getJSON(`${BASE}/api/v4/databox?fresh=1`);
    const tab1Rows = tab1.rows || [];
    const chosenRows = [];
    const seenBizType = new Set();
    for (const r of tab1Rows) {
        if (!r.bizType || seenBizType.has(r.bizType)) continue;
        const withH = tab1Rows.find((x) => x.bizType === r.bizType && Array.isArray(x.genres2) && x.genres2.length > 0);
        if (!withH) continue;
        seenBizType.add(r.bizType);
        chosenRows.push(withH);
    }
    if (chosenRows.length === 0) fail('No biz types with column H populated found in Tab 1');
    log(`  biz types        : ${chosenRows.length} (${chosenRows.map((r) => r.bizType).join(', ')})`);

    // 2. Extract genres in sheet order, deduped across biz types
    const genreOrder = [];
    const seenGenre = new Set();
    for (const row of chosenRows) {
        for (const cell of [...(row.genres1 || []), ...(row.genres2 || [])]) {
            const tokens = String(cell).split(/\s*[\/,]\s*/);
            for (const t of tokens) {
                const n = norm(t);
                if (n && !seenGenre.has(n)) {
                    seenGenre.add(n);
                    genreOrder.push(n);
                }
            }
        }
    }
    log(`  unique genres (${genreOrder.length}): ${genreOrder.join(', ')}`);

    // 3. Fetch Tab 2, index by normalized genre name
    const tab2 = await getJSON(`${BASE}/api/v4/databox-genres?fresh=1`);
    const tab2ByGenre = new Map();
    for (const row of tab2.rows || []) tab2ByGenre.set(norm(row.genre), row);
    const missing = genreOrder.filter((g) => !tab2ByGenre.has(g));
    if (missing.length) warn(`Genres not found in Tab 2 (will be skipped): ${missing.join(', ')}`);

    // 4. Round-robin loop
    let totalAnalyzed = 0, totalProcessed = 0, totalSkipped = 0;
    let aborted = false;
    outer: for (let round = startRound; round <= maxRound; round++) {
        log(`\n=== ROUND ${round} ===`);
        let didWorkThisRound = false;
        for (const g of genreOrder) {
            if (aborted) break outer;
            if (readCurrentMonthCount() >= cap) { log('Cap reached, stopping.'); aborted = true; break outer; }
            const tab2Row = tab2ByGenre.get(g);
            if (!tab2Row) continue;
            const playlists = tab2Row.playlists || [];
            if (round > playlists.length) continue;  // no playlist at this position for this genre
            const pl = playlists[round - 1];
            if (!pl?.id) continue;
            didWorkThisRound = true;
            const r = await processPlaylist({ genre: g, position: round, playlist_id: pl.id, apiKey, cap, concurrency });
            totalProcessed++;
            if (r.skipped) totalSkipped++;
            if (r.analyzed) totalAnalyzed += r.analyzed;
            if (r.aborted) { aborted = true; break outer; }
        }
        if (!didWorkThisRound) { log(`No genre had a playlist at position ${round}; stopping.`); break; }
    }

    log(`\n=== deepen-genres end ===`);
    log(`  total playlists processed : ${totalProcessed}`);
    log(`  skipped (already linked / empty / 404) : ${totalSkipped}`);
    log(`  total analyzed            : ${totalAnalyzed}`);
    log(`  monthly counter after run : ${readCurrentMonthCount()}`);
    if (aborted) log(`  Run aborted (cap reached or worker abort). Re-run to continue.`);
    logStream.end();
}

main().catch((err) => {
    warn('UNCAUGHT: ' + (err.stack || err.message || err));
    logStream.end();
    process.exit(1);
});
