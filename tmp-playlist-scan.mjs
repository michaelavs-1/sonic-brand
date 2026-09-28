// One-off: fetch every track in a Spotify playlist and run each through
// RapidAPI's track-analysis endpoint. Writes results to JSON. Does NOT touch
// Supabase — no reads from track_analyses, no writes anywhere.
//
// Full 6-step backoff ladder (matches batch.mjs's healthy-run behavior).
// Concurrency = 3 workers (batch.mjs default; RapidAPI degrades sharply above).
//
// Prereqs:
//   1) vercel dev running on :3000 (needed for /api/v4/spotify to fetch the playlist)
//   2) .env.local with TRACK_ANALYSIS_RAPIDAPI_KEY + INTERNAL_API_KEY
//
// Run:
//   node tmp-playlist-scan.mjs
//
// Output: tmp-playlist-<playlistId>-analysis.json in the project root.

import fs from 'node:fs';
import path from 'node:path';

const PLAYLIST_IDS = [
  '29SaYsxL1o4Teehwm80M9J',
  '7fPGDifn0p5oumYr4PF66G',
];
const CONCURRENCY = 3;
const RAPIDAPI_HOST = 'track-analysis.p.rapidapi.com';
const DEV_BASE = process.env.DEV_BASE || 'http://localhost:3000';
const outPathFor = (playlistId) => path.join('d:/Projects/algorithm/sonic-brand', `tmp-playlist-${playlistId}-analysis.json`);

// --- Load .env.local ---
(function loadDotEnv() {
  const p = 'd:/Projects/algorithm/sonic-brand/.env.local';
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
})();

const RAPIDAPI_KEY = process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';
if (!RAPIDAPI_KEY) { console.error('TRACK_ANALYSIS_RAPIDAPI_KEY missing from .env.local'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Fetch the playlist's track IDs via vercel dev ---
async function fetchPlaylistTrackIds(playlistId) {
  const ids = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${DEV_BASE}/api/v4/spotify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_KEY ? { 'x-sonic-internal': INTERNAL_KEY } : {}),
      },
      body: JSON.stringify({
        action: 'get_playlist_tracks',
        playlist_id: playlistId,
        offset, limit: 100,
        fields: 'items(track(id,name,artists(name),is_playable))',
        market: 'IL',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`Playlist fetch failed at offset=${offset}: HTTP ${r.status}`, data);
      process.exit(1);
    }
    const items = Array.isArray(data.items) ? data.items : [];
    for (const it of items) {
      const t = it?.track;
      if (t?.id && t.is_playable !== false) {
        ids.push({
          spotify_id: t.id,
          name: t.name,
          artist: (t.artists || []).map((a) => a.name).join(', '),
        });
      }
    }
    if (items.length < 100) break;
    offset += 100;
  }
  return ids;
}

// --- RapidAPI call with 6-retry ladder (mirrors batch.mjs semantics) ---
const RETRY_5XX_BACKOFF_MS = [5000, 15000, 45000, 120000, 300000, 600000];
const RETRY_429_BACKOFF_MS = [10000, 30000, 60000, 120000, 300000];

async function callTrackAnalysis(spotifyId) {
  let rate429Idx = 0;
  let serr5xxIdx = 0;
  const started = Date.now();

  while (true) {
    let r, bodyText, data;
    try {
      r = await fetch(`https://${RAPIDAPI_HOST}/pktx/spotify/${encodeURIComponent(spotifyId)}`, {
        headers: {
          'x-rapidapi-key':  RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_HOST,
        },
      });
      bodyText = await r.text();
      try { data = JSON.parse(bodyText); } catch { data = null; }
    } catch (err) {
      // Network error — treat as 5xx
      if (serr5xxIdx >= RETRY_5XX_BACKOFF_MS.length) {
        return { kind: 'terminal', reason: `network_error: ${err.message}`, ms: Date.now() - started };
      }
      const wait = RETRY_5XX_BACKOFF_MS[serr5xxIdx];
      console.warn(`  network_error on ${spotifyId}: ${err.message}; backoff ${wait}ms (attempt ${serr5xxIdx + 1}/6)`);
      await sleep(wait);
      serr5xxIdx++;
      continue;
    }

    // 401/403 → fatal auth
    if (r.status === 401 || r.status === 403) {
      return { kind: 'fatal_auth', status: r.status, body: bodyText.slice(0, 500), ms: Date.now() - started };
    }

    // 429 rate limit
    if (r.status === 429) {
      if (rate429Idx >= RETRY_429_BACKOFF_MS.length) {
        return { kind: 'terminal', reason: '429 retries exhausted', ms: Date.now() - started };
      }
      const retryAfterHdr = r.headers.get('retry-after');
      const retryAfterSec = retryAfterHdr ? parseInt(retryAfterHdr, 10) : 0;
      const wait = retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, RETRY_429_BACKOFF_MS[rate429Idx])
        : RETRY_429_BACKOFF_MS[rate429Idx];
      console.warn(`  429 on ${spotifyId}; backoff ${wait}ms (attempt ${rate429Idx + 1}/5)`);
      await sleep(wait);
      rate429Idx++;
      continue;
    }

    // 200 with error payload (RapidAPI's soft-fail shape)
    const softError =
      r.status === 200 && data && (data.error || data.message === 'Failed to pull track data');
    // 5xx or 200-with-error → backoff
    if (r.status >= 500 || softError) {
      if (serr5xxIdx >= RETRY_5XX_BACKOFF_MS.length) {
        return { kind: 'terminal', reason: softError ? '200 error payload retries exhausted' : `${r.status} retries exhausted`, status: r.status, body: bodyText.slice(0, 500), ms: Date.now() - started };
      }
      const wait = RETRY_5XX_BACKOFF_MS[serr5xxIdx];
      console.warn(`  ${softError ? '200 error payload' : `${r.status}`} on ${spotifyId}: ${bodyText.slice(0, 100)}; backoff ${wait}ms (attempt ${serr5xxIdx + 1}/6)`);
      await sleep(wait);
      serr5xxIdx++;
      continue;
    }

    // Other 4xx → terminal, no retry
    if (r.status >= 400) {
      return { kind: 'terminal', reason: `${r.status} client error`, status: r.status, body: bodyText.slice(0, 500), ms: Date.now() - started };
    }

    // 200 with actual analysis data
    if (r.status === 200 && data) {
      // Same "stub row" check as batch.mjs — no atmospheric fields = not_found
      const hasFields = data.energy != null || data.danceability != null || data.popularity != null;
      if (!hasFields) return { kind: 'not_found', ms: Date.now() - started };
      return { kind: 'ok', data, ms: Date.now() - started };
    }

    // Shouldn't reach here
    return { kind: 'terminal', reason: `unexpected: status=${r.status}`, ms: Date.now() - started };
  }
}

// --- Scan one playlist ---
async function scanPlaylist(playlistId) {
  const OUT_PATH = outPathFor(playlistId);
  console.log(`\n=== Playlist ${playlistId} ===`);
  console.log(`Fetching tracks…`);
  const tracks = await fetchPlaylistTrackIds(playlistId);
  console.log(`  ${tracks.length} playable tracks`);

  if (tracks.length === 0) {
    console.log('Nothing to scan for this playlist.');
    return;
  }

  console.log(`Starting RapidAPI phase — ${CONCURRENCY} workers, 6-retry ladder…\n`);
  const results = new Array(tracks.length);
  let ok = 0, notFound = 0, terminal = 0, done = 0;
  const startAll = Date.now();

  let idx = 0;
  async function worker() {
    while (idx < tracks.length) {
      const i = idx++;
      const t = tracks[i];
      const result = await callTrackAnalysis(t.spotify_id);
      results[i] = { ...t, result };
      done++;
      if (result.kind === 'ok') { ok++; console.log(`[${done}/${tracks.length}] ok        ${t.spotify_id} ${result.ms}ms — ${t.name} · ${t.artist}`); }
      else if (result.kind === 'not_found') { notFound++; console.log(`[${done}/${tracks.length}] not_found ${t.spotify_id} ${result.ms}ms — ${t.name} · ${t.artist}`); }
      else { terminal++; console.log(`[${done}/${tracks.length}] TERMINAL  ${t.spotify_id} ${result.ms}ms — ${t.name} · ${t.artist} — ${result.reason || result.kind}`); }
      // Persist incrementally so a Ctrl-C doesn't lose progress
      if (done % 10 === 0 || done === tracks.length) {
        fs.writeFileSync(OUT_PATH, JSON.stringify({
          playlist_id: playlistId,
          generated_at: new Date().toISOString(),
          total_tracks: tracks.length,
          completed: done,
          summary: { ok, not_found: notFound, terminal },
          results: results.filter(Boolean),
        }, null, 2));
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsedMin = ((Date.now() - startAll) / 60000).toFixed(1);
  console.log(`Done. ${ok} ok · ${notFound} not_found · ${terminal} terminal · ${elapsedMin} min`);
  console.log(`Results written to: ${OUT_PATH}`);
}

// --- Main: sequentially scan every playlist ---
for (const pid of PLAYLIST_IDS) {
  try {
    await scanPlaylist(pid);
  } catch (err) {
    console.error(`Playlist ${pid} failed to scan:`, err);
  }
}
console.log('\nAll playlists processed.');
