// One-off dry-run: build a plan of ONLY status='error' tracks, ordered by
// each track's genre error count ASCENDING. Tracks in multiple genres are
// deduped and assigned to their lowest-error-count genre for ordering.
//
// MAX_GENRE_ERROR_COUNT caps the tail — any genre with more errors than this
// gets excluded entirely. Set below to keep the run in the "transient blip"
// bucket where 6-retry recovery has high yield.
//
// Pair with:
//   node v4/precompute/batch.mjs --max-rapidapi-calls=1000000 --retry-errors
//
// Full 6-step backoff ladder (default, since no --max-error-retries is passed).
// Storm abort stays ON (default) so a genuinely dead upstream trips out. Add
// --no-storm-abort if you want the run to plow through regardless.

import fs from 'node:fs';
import path from 'node:path';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function paged(url) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const r = await fetch(`${SB}/rest/v1/${url}`, {
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

console.log('Fetching playlist_genres, playlist_tracks, track_analyses(status=error)...');
const [pg, pt, taErr] = await Promise.all([
  paged('playlist_genres?select=playlist_id,genre'),
  paged('playlist_tracks?select=playlist_id,spotify_id'),
  paged('track_analyses?status=eq.error&select=spotify_id'),
]);
const errorIds = new Set(taErr.map(r => r.spotify_id));
console.log(`  playlist_genres: ${pg.length}, playlist_tracks: ${pt.length}, error tracks: ${errorIds.size}`);

// spotify_id → Set(genre) via playlist_tracks + playlist_genres
const genresByPlaylist = new Map();
for (const r of pg) {
  if (!genresByPlaylist.has(r.playlist_id)) genresByPlaylist.set(r.playlist_id, new Set());
  genresByPlaylist.get(r.playlist_id).add(r.genre);
}
const genresByTrack = new Map();
for (const r of pt) {
  if (!errorIds.has(r.spotify_id)) continue;
  if (!genresByTrack.has(r.spotify_id)) genresByTrack.set(r.spotify_id, new Set());
  for (const g of (genresByPlaylist.get(r.playlist_id) || [])) {
    genresByTrack.get(r.spotify_id).add(g);
  }
}

// Per-genre error track count (a multi-genre error track counts for each genre)
const errorsByGenre = new Map();
for (const [sid, gs] of genresByTrack) {
  for (const g of gs) errorsByGenre.set(g, (errorsByGenre.get(g) || 0) + 1);
}

// Sort genres ASC by error count, filter by cutoff
const MAX_GENRE_ERROR_COUNT = 100;
const allGenresSorted = [...errorsByGenre.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
const genresSorted = allGenresSorted.filter(([, n]) => n <= MAX_GENRE_ERROR_COUNT);
const skipped     = allGenresSorted.filter(([, n]) => n >  MAX_GENRE_ERROR_COUNT);
console.log(`\nGenres INCLUDED (error count <= ${MAX_GENRE_ERROR_COUNT}, ASC — processing order):`);
for (const [g, n] of genresSorted) console.log(`  ${g.padEnd(30)} ${n}`);
console.log(`\nGenres SKIPPED (error count > ${MAX_GENRE_ERROR_COUNT}):`);
for (const [g, n] of skipped) console.log(`  ${g.padEnd(30)} ${n}`);

// Assign each error track to its LOWEST-error genre so it lands early in the queue
const genreRank = new Map(genresSorted.map(([g], i) => [g, i]));
const trackAssignedGenre = new Map();  // spotify_id → chosen genre
for (const [sid, gs] of genresByTrack) {
  let bestG = null, bestRank = Infinity;
  for (const g of gs) {
    const r = genreRank.get(g);
    if (r != null && r < bestRank) { bestRank = r; bestG = g; }
  }
  if (bestG) trackAssignedGenre.set(sid, bestG);
}

// Bucket track IDs by their assigned genre, in sorted order
const orderedIds = [];
for (const [g] of genresSorted) {
  const bucket = [];
  for (const [sid, chosen] of trackAssignedGenre) {
    if (chosen === g) bucket.push(sid);
  }
  bucket.sort();  // stable order within a genre
  orderedIds.push(...bucket);
}

// Sanity: how many error tracks did we exclude via the cutoff?
const inQueue = new Set(orderedIds);
const excluded = [...errorIds].filter(id => !inQueue.has(id));
console.log(`\nQueue length: ${orderedIds.length} (of ${errorIds.size} total error tracks; ${excluded.length} excluded via cutoff or missing genre linkage)`);

const plan = {
  generated_at:          new Date().toISOString(),
  source:                'tmp-plan-errors-asc.mjs (status=error tracks, per-genre error-count ASC)',
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
const OUT = path.join('d:/Projects/algorithm/sonic-brand/v4/precompute/state', 'dry-run.json');
fs.writeFileSync(OUT, JSON.stringify(plan));
console.log(`Plan written: ${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log('Now run:');
console.log('  node v4/precompute/batch.mjs --max-rapidapi-calls=1000000 --retry-errors');
