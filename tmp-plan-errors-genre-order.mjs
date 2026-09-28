// One-off dry-run: build a plan of status='error' tracks belonging to a
// hand-picked ordered list of genres. Tracks are deduped and assigned to
// their EARLIEST-in-the-list genre so the bucket order matches user intent.
//
// Pair with:
//   node v4/precompute/batch.mjs --max-rapidapi-calls=50000 --retry-errors --no-storm-abort
//
// Full 6-step backoff ladder (no --max-error-retries). No storm abort so
// the run completes even on genres with high failure rates.

import fs from 'node:fs';
import path from 'node:path';

const envText = fs.readFileSync('D:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// USER-SPECIFIED ORDER — bottom to top as requested.
const GENRE_ORDER = [
  'italian folk',
  'surf rock',
  'electronic r&b',
  'mo town',
  'doo-wop',
  'french touch',
  'soft pop hits',
];
const genreRank = new Map(GENRE_ORDER.map((g, i) => [g, i]));
const GENRE_SET = new Set(GENRE_ORDER);

async function paged(url, orderCol) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  const sep = url.includes('?') ? '&' : '?';
  while (true) {
    const r = await fetch(`${SB}/rest/v1/${url}${sep}order=${orderCol}.asc`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok && r.status !== 206) throw new Error(`${url} ${r.status}: ${await r.text()}`);
    const chunk = await r.json();
    if (chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < PAGE) break;
    from += chunk.length;
  }
  return out;
}

console.log('Fetching playlist_genres, playlist_tracks, error track_analyses…');
const [pg, pt, taErr] = await Promise.all([
  paged('playlist_genres?select=playlist_id,genre', 'playlist_id'),
  paged('playlist_tracks?select=playlist_id,spotify_id', 'spotify_id'),
  paged('track_analyses?status=eq.error&select=spotify_id', 'spotify_id'),
]);

const errorIds = new Set(taErr.map(r => r.spotify_id));
console.log(`  playlist_genres: ${pg.length}, playlist_tracks: ${pt.length}, error tracks (DB-wide): ${errorIds.size}`);

// playlist_id → Set(genre) — filter to only the 7 target genres
const genresByPlaylist = new Map();
for (const r of pg) {
  const g = r.genre.toLowerCase();
  if (!GENRE_SET.has(g)) continue;
  if (!genresByPlaylist.has(r.playlist_id)) genresByPlaylist.set(r.playlist_id, new Set());
  genresByPlaylist.get(r.playlist_id).add(g);
}

// spotify_id → Set(genre) via playlist_tracks, filtered to target genres
const genresByTrack = new Map();
for (const r of pt) {
  if (!errorIds.has(r.spotify_id)) continue;
  const gs = genresByPlaylist.get(r.playlist_id);
  if (!gs) continue;
  if (!genresByTrack.has(r.spotify_id)) genresByTrack.set(r.spotify_id, new Set());
  for (const g of gs) genresByTrack.get(r.spotify_id).add(g);
}

// Assign each track to its EARLIEST (lowest-index) genre in user's order
const trackAssignedGenre = new Map();
for (const [sid, gs] of genresByTrack) {
  let bestG = null, bestRank = Infinity;
  for (const g of gs) {
    const r = genreRank.get(g);
    if (r != null && r < bestRank) { bestRank = r; bestG = g; }
  }
  if (bestG) trackAssignedGenre.set(sid, bestG);
}

// Bucket by assigned genre, in the user's specified order
const orderedIds = [];
console.log('\nProcessing order + per-bucket error counts:');
for (const g of GENRE_ORDER) {
  const bucket = [];
  for (const [sid, chosen] of trackAssignedGenre) {
    if (chosen === g) bucket.push(sid);
  }
  bucket.sort();
  orderedIds.push(...bucket);
  console.log(`  ${g.padEnd(22)} ${bucket.length}`);
}

console.log(`\nQueue length: ${orderedIds.length} error tracks across ${GENRE_ORDER.length} genres`);

const plan = {
  generated_at:          new Date().toISOString(),
  source:                'tmp-plan-errors-genre-order.mjs (7 target genres, user-specified order)',
  target_biz_types:      [],
  playlists_per_genre:   0,
  biztype_genres:        [],
  playlist_genres:       [],
  playlist_tracks:       {},
  unique_track_ids:      orderedIds,
  unique_track_count:    orderedIds.length,
  already_cached_count:  0,
  expected_new_calls:    orderedIds.length,
};
const OUT = path.join('D:/Projects/algorithm/sonic-brand/v4/precompute/state', 'dry-run.json');
fs.writeFileSync(OUT, JSON.stringify(plan));
console.log(`\nPlan written: ${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log('\nNow run:');
console.log('  node v4/precompute/batch.mjs --max-rapidapi-calls=50000 --retry-errors --no-storm-abort');
