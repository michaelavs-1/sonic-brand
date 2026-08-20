// v4/precompute/check-genre-health.mjs
//
// Per-genre RapidAPI health probe. For each genre in playlist_genres, samples
// N random spotify_ids from its playlists and hits the track-analysis API
// directly. Aggregates per-genre: OK rate, average OK latency, TIMEOUT rate,
// other failure modes. Ranks genres by trouble score to isolate which ones
// are dragging down batch throughput.
//
// Prereqs:
//   .env.local with TRACK_ANALYSIS_RAPIDAPI_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   (no vercel dev needed — direct RapidAPI + Supabase)
//
// CLI:
//   --per-genre=N       tracks to test per genre (default 3, max 10)
//   --timeout-ms=N      per-call timeout (default 20000 = 20s; past that a
//                       call is treated as a trouble signal)
//   --concurrency=N     parallel workers (default 5, max 10)
//   --genres="a,b,c"    optional allowlist (case-insensitive). Default = all.
//
// Run:
//   node v4/precompute/check-genre-health.mjs
//   node v4/precompute/check-genre-health.mjs --per-genre=5 --concurrency=8

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

function parseArgs() {
    const a = {};
    for (const s of process.argv.slice(2)) {
        const m = s.match(/^--([a-z0-9-]+)(?:=(.+))?$/);
        if (m) a[m[1]] = m[2] ?? true;
    }
    return a;
}
const args = parseArgs();
const PER_GENRE   = Math.max(1, Math.min(10, parseInt(args['per-genre'] ?? '3', 10) || 3));
const TIMEOUT_MS  = parseInt(args['timeout-ms'] ?? '20000', 10);
const CONCURRENCY = Math.max(1, Math.min(10, parseInt(args['concurrency'] ?? '5', 10) || 5));
const norm = (s) => String(s || '').trim().toLowerCase();
const GENRE_FILTER = args['genres']
    ? new Set(String(args['genres']).split(',').map(norm).filter(Boolean))
    : null;

const KEY = process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;
const SB  = process.env.SUPABASE_URL;
const SBK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('TRACK_ANALYSIS_RAPIDAPI_KEY missing'); process.exit(1); }
if (!SB || !SBK) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }

const HOST = 'track-analysis.p.rapidapi.com';

function looksLikeHtml(s) {
    if (!s) return false;
    const h = s.trimStart().slice(0, 200).toLowerCase();
    return h.startsWith('<') && (h.includes('<html') || h.includes('<!doctype') || h.includes('<head'));
}

// Lean paginated fetch (avoids PostgREST byte-cap truncation on wide tables).
async function fetchAllLean(table, extraQuery = {}, cols = 'spotify_id', orderCol = 'spotify_id') {
    const out = [];
    let from = 0;
    const PAGE = 500;
    const params = { select: cols, order: `${orderCol}.asc`, ...extraQuery };
    while (true) {
        const url = `${SB}/rest/v1/${table}?${new URLSearchParams(params)}`;
        const r = await fetch(url, {
            headers: { apikey: SBK, Authorization: `Bearer ${SBK}`, Range: `${from}-${from + PAGE - 1}` },
        });
        if (!r.ok && r.status !== 206) throw new Error(`${table} ${r.status}: ${await r.text()}`);
        const chunk = await r.json();
        if (chunk.length === 0) break;
        out.push(...chunk);
        if (chunk.length < PAGE) break;
        from += chunk.length;
    }
    return out;
}

console.log(`Config: per-genre=${PER_GENRE} timeout=${TIMEOUT_MS}ms concurrency=${CONCURRENCY}`);
if (GENRE_FILTER) console.log(`Genre filter: ${[...GENRE_FILTER].join(', ')}`);
console.log('');

// 1. All (playlist_id, genre)
console.log('Loading playlist_genres...');
const pg = await fetchAllLean('playlist_genres', {}, 'playlist_id,genre', 'genre');
const pidsByGenre = new Map();
for (const r of pg) {
    if (GENRE_FILTER && !GENRE_FILTER.has(r.genre)) continue;
    if (!pidsByGenre.has(r.genre)) pidsByGenre.set(r.genre, new Set());
    pidsByGenre.get(r.genre).add(r.playlist_id);
}
console.log(`  genres to test: ${pidsByGenre.size}`);

// 2. All (playlist_id, spotify_id) for the playlists in scope
const relevantPids = [...new Set([].concat(...[...pidsByGenre.values()].map(s => [...s])))];
console.log(`Loading playlist_tracks for ${relevantPids.length} playlists...`);
const trackByPlaylist = new Map();
const CHUNK = 100;
for (let i = 0; i < relevantPids.length; i += CHUNK) {
    const slice = relevantPids.slice(i, i + CHUNK);
    const filter = `in.(${slice.map(v => `"${v}"`).join(',')})`;
    const rows = await fetchAllLean('playlist_tracks', { playlist_id: filter }, 'playlist_id,spotify_id');
    for (const r of rows) {
        if (!trackByPlaylist.has(r.playlist_id)) trackByPlaylist.set(r.playlist_id, []);
        trackByPlaylist.get(r.playlist_id).push(r.spotify_id);
    }
}

// 3. Sample N per genre
const jobs = []; // [{ genre, spotify_id }]
for (const [genre, pidSet] of pidsByGenre) {
    const pool = new Set();
    for (const pid of pidSet) {
        for (const sid of (trackByPlaylist.get(pid) || [])) pool.add(sid);
    }
    const arr = [...pool];
    // shuffle
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const picked = arr.slice(0, PER_GENRE);
    for (const sid of picked) jobs.push({ genre, spotify_id: sid });
}
console.log(`Total probes: ${jobs.length}  (~${(jobs.length * TIMEOUT_MS / CONCURRENCY / 60000).toFixed(1)} min worst-case)`);
console.log('');

// 4. Probe with concurrency
const results = new Array(jobs.length);
let nextIdx = 0;
let doneCount = 0;
async function probeWorker() {
    while (true) {
        const idx = nextIdx++;
        if (idx >= jobs.length) return;
        const { genre, spotify_id } = jobs[idx];
        const t0 = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        let verdict = 'OK', latency_ms = 0, http = '-', body = '';
        try {
            const r = await fetch(`https://${HOST}/pktx/spotify/${encodeURIComponent(spotify_id)}`, {
                method: 'GET',
                headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST },
                signal: ctrl.signal,
            });
            latency_ms = Date.now() - t0;
            http = r.status;
            body = await r.text().catch(() => '');
            clearTimeout(timer);
            if (looksLikeHtml(body)) verdict = 'HTML';
            else if (r.status === 401 || r.status === 403) verdict = 'AUTH';
            else if (r.status === 429) verdict = 'RATE-LIMIT';
            else if (!r.ok) verdict = 'HTTP-ERR';
            else {
                let json = null;
                try { json = JSON.parse(body); } catch {}
                if (!json || json.error) verdict = 'ERR-PAYLOAD';
                else if (json.energy == null && json.danceability == null && json.popularity == null) verdict = 'STUB';
                else verdict = 'OK';
            }
        } catch (e) {
            clearTimeout(timer);
            latency_ms = Date.now() - t0;
            verdict = e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK-ERR';
        }
        results[idx] = { genre, spotify_id, verdict, latency_ms, http };
        doneCount++;
        if (doneCount % 20 === 0 || doneCount === jobs.length) {
            process.stdout.write(`\r  progress: ${doneCount}/${jobs.length}`);
        }
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => probeWorker()));
console.log('\n');

// 5. Aggregate per genre
const perGenre = new Map();
for (const r of results) {
    if (!perGenre.has(r.genre)) perGenre.set(r.genre, { ok: 0, timeout: 0, other: 0, ok_latencies: [], sample: [] });
    const g = perGenre.get(r.genre);
    if (r.verdict === 'OK') { g.ok++; g.ok_latencies.push(r.latency_ms); }
    else if (r.verdict === 'TIMEOUT') g.timeout++;
    else g.other++;
    g.sample.push(`${r.verdict}(${(r.latency_ms/1000).toFixed(1)}s)`);
}

// Score: primary = ok/total ascending, tiebreaker = avg ok latency descending
const rows = [...perGenre.entries()].map(([genre, g]) => {
    const total = g.ok + g.timeout + g.other;
    const okRate = total > 0 ? g.ok / total : 0;
    const avgOkLat = g.ok_latencies.length ? g.ok_latencies.reduce((a, b) => a + b, 0) / g.ok_latencies.length : null;
    return { genre, total, ok: g.ok, timeout: g.timeout, other: g.other, okRate, avgOkLat, sample: g.sample };
});
rows.sort((a, b) => {
    if (a.okRate !== b.okRate) return a.okRate - b.okRate;
    return (b.avgOkLat ?? Infinity) - (a.avgOkLat ?? Infinity);
});

// 6. Print
console.log('=== Per-genre RapidAPI health (worst first) ===');
console.log('genre'.padEnd(30) + 'ok/n   timeout  other  avg_ok_latency  sample outcomes');
console.log('-'.repeat(100));
for (const r of rows) {
    const okStr = `${r.ok}/${r.total}`;
    const latStr = r.avgOkLat != null ? `${(r.avgOkLat / 1000).toFixed(1)}s` : '—';
    console.log(
        r.genre.padEnd(30) +
        okStr.padEnd(7) +
        String(r.timeout).padStart(4).padEnd(10) +
        String(r.other).padStart(4).padEnd(7) +
        latStr.padEnd(16) +
        r.sample.join(' ')
    );
}
console.log('');

// 7. Buckets
const trouble = rows.filter(r => r.okRate === 0);
const flaky   = rows.filter(r => r.okRate > 0 && r.okRate < 1);
const healthy = rows.filter(r => r.okRate === 1);
console.log('=== Summary ===');
console.log(`  Trouble genres (0/${PER_GENRE} succeeded)   : ${trouble.length}${trouble.length ? ' → ' + trouble.map(t => t.genre).join(', ') : ''}`);
console.log(`  Flaky genres   (partial success)  : ${flaky.length}${flaky.length ? ' → ' + flaky.map(t => t.genre).join(', ') : ''}`);
console.log(`  Healthy genres (${PER_GENRE}/${PER_GENRE} succeeded)   : ${healthy.length}`);
