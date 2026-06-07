// One-off: pull every track from a Spotify playlist, run each through the
// track-analysis API, and write the merged data to a JSON file.
//
// Uses the existing proxies on vercel dev:
//   /api/new/spotify         (action: get_playlist_tracks — Michael's CC token)
//   /api/new/track-analysis  (action: analyze_track       — RapidAPI key)
//
// Run:
//   vercel dev                          (one terminal — serves /api/new/*)
//   node .test-playlist-analysis.mjs    (another terminal)
//
// Optional CLI args:
//   --playlist=<id_or_url>     override the default playlist
//   --out=<path>               override the default output path (.playlist-analysis.json)

const DEV_BASE = process.env.DEV_BASE || 'http://localhost:3000';

const DEFAULT_PLAYLIST = 'https://open.spotify.com/playlist/6uPitnclbILW7YrAN4cvmd?si=vUSZ59G1TPe2bWGjlXUHvQ';
const DEFAULT_OUT      = '.playlist-analysis.json';

const PAGE_LIMIT            = 100;  // Spotify max per page
const ANALYSIS_CONCURRENCY  = 4;
const ANALYSIS_RATE_PER_SEC = 4;

function arg(name, fallback) {
  const m = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : fallback;
}

function extractPlaylistId(input) {
  if (!input) return null;
  if (/^[A-Za-z0-9]{10,30}$/.test(input)) return input;
  const m = String(input).match(/playlist\/([A-Za-z0-9]{10,30})/);
  return m ? m[1] : null;
}

async function fetchAllPlaylistTracks(playlistId) {
  const all = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${DEV_BASE}/api/new/spotify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'get_playlist_tracks',
        playlist_id: playlistId,
        offset,
        limit: PAGE_LIMIT,
        fields: 'items(track(id,name,artists(name),album(name),duration_ms,popularity,external_urls)),total',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`get_playlist_tracks ${r.status}: ${data?.error?.message || data?.error || r.statusText}`);
    }
    const items = Array.isArray(data.items) ? data.items : [];
    for (const it of items) {
      const t = it?.track;
      if (!t || !t.id) continue;
      all.push({
        id: t.id,
        name: t.name || '',
        artists: (t.artists || []).map(a => a.name).filter(Boolean),
        album: t.album?.name || '',
        duration_ms: t.duration_ms ?? null,
        popularity: t.popularity ?? null,
        url: t.external_urls?.spotify || '',
      });
    }
    if (items.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
  return all;
}

async function analyzeOne(spotifyId) {
  const r = await fetch(`${DEV_BASE}/api/new/track-analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'analyze_track', spotify_id: spotifyId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data?.error || r.statusText, status: r.status };
  if (data.found === false) return { ok: false, error: 'not_found', status: 200 };
  // Strip the wrapper field so the analysis object stands on its own in output.
  const { found, ...analysis } = data;
  return { ok: true, analysis };
}

async function runWithRateLimit(tasks, { concurrency, perSecond }) {
  const results = new Array(tasks.length);
  const intervalMs = 1000 / perSecond;
  let nextIdx = 0;
  let nextLaunchAt = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= tasks.length) return;
      const wait = Math.max(0, nextLaunchAt - Date.now());
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      nextLaunchAt = Math.max(Date.now(), nextLaunchAt) + intervalMs;
      results[i] = await tasks[i]();
    }
  }
  const n = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ---------- main ----------

const playlistArg = arg('playlist', DEFAULT_PLAYLIST);
const outPath     = arg('out',      DEFAULT_OUT);
const playlistId  = extractPlaylistId(playlistArg);
if (!playlistId) {
  console.error(`Could not parse a playlist id from "${playlistArg}"`);
  process.exit(1);
}

console.log(`playlist:  ${playlistId}`);
console.log(`output:    ${outPath}`);
console.log(`dev base:  ${DEV_BASE}`);

console.log(`\n=== fetching playlist tracks ===`);
const tFetch0 = Date.now();
let tracks;
try {
  tracks = await fetchAllPlaylistTracks(playlistId);
} catch (err) {
  console.error(`playlist fetch failed: ${err.message}`);
  process.exit(1);
}
console.log(`got ${tracks.length} tracks in ${Date.now() - tFetch0}ms`);

console.log(`\n=== analyzing tracks (concurrency=${ANALYSIS_CONCURRENCY}, ${ANALYSIS_RATE_PER_SEC}/sec) ===`);
const tAnalyze0 = Date.now();
let done = 0; let okCount = 0; let failCount = 0;
const tasks = tracks.map((t, i) => async () => {
  const res = await analyzeOne(t.id);
  done++;
  if (res.ok) okCount++; else failCount++;
  const tag = res.ok ? 'OK ' : 'ERR';
  const detail = res.ok ? '' : `  (${res.error})`;
  console.log(`[${String(done).padStart(3)}/${tracks.length}] ${tag}  ${t.id}  ${t.artists.join(', ')} — ${t.name}${detail}`);
  return { ...t, analysis: res.ok ? res.analysis : null, analysis_error: res.ok ? null : res.error };
});
const merged = await runWithRateLimit(tasks, {
  concurrency: ANALYSIS_CONCURRENCY,
  perSecond:   ANALYSIS_RATE_PER_SEC,
});
console.log(`analysis done in ${Date.now() - tAnalyze0}ms  —  ${okCount} ok, ${failCount} failed`);

const output = {
  playlist_id: playlistId,
  fetched_at:  new Date().toISOString(),
  total_tracks: merged.length,
  analyzed_ok: okCount,
  analyzed_failed: failCount,
  tracks: merged,
};

const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`\nwrote ${outPath}`);
