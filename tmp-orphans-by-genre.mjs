import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function paged(path) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok && r.status !== 206) throw new Error(`${path} ${r.status}: ${await r.text()}`);
    const chunk = await r.json();
    if (chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < PAGE) break;
    from += chunk.length;
  }
  return out;
}

console.log('Fetching playlist_tracks, track_analyses, playlist_genres...');
const [pt, ta, pg] = await Promise.all([
  paged('playlist_tracks?select=playlist_id,spotify_id'),
  paged('track_analyses?select=spotify_id'),
  paged('playlist_genres?select=playlist_id,genre'),
]);
console.log(`  playlist_tracks: ${pt.length}`);
console.log(`  track_analyses:  ${ta.length}`);
console.log(`  playlist_genres: ${pg.length}`);

const analyzed = new Set(ta.map(r => r.spotify_id));
const playlistGenres = new Map();
for (const r of pg) {
  if (!playlistGenres.has(r.playlist_id)) playlistGenres.set(r.playlist_id, []);
  playlistGenres.get(r.playlist_id).push(r.genre);
}

// Distinct orphan spotify_ids per genre (a track in >1 genre counts for each)
const orphansByGenre = new Map();
const orphansTrackedByGenre = new Map(); // dedupe per genre
let unlinkedOrphans = 0;
let totalOrphans = 0;
const seenAllOrphans = new Set();
for (const r of pt) {
  if (analyzed.has(r.spotify_id)) continue;
  if (!seenAllOrphans.has(r.spotify_id)) {
    seenAllOrphans.add(r.spotify_id);
    totalOrphans++;
  }
  const genres = playlistGenres.get(r.playlist_id);
  if (!genres || genres.length === 0) {
    unlinkedOrphans++;
    continue;
  }
  for (const g of genres) {
    if (!orphansTrackedByGenre.has(g)) orphansTrackedByGenre.set(g, new Set());
    orphansTrackedByGenre.get(g).add(r.spotify_id);
  }
}
for (const [g, s] of orphansTrackedByGenre) orphansByGenre.set(g, s.size);

const rows = [...orphansByGenre.entries()]
  .filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1]);

console.log('');
console.log('genre'.padEnd(30) + 'orphan tracks');
console.log('-'.repeat(45));
for (const [g, n] of rows) console.log(g.padEnd(30) + String(n).padStart(7));
console.log('-'.repeat(45));
console.log(`Total genres with orphans: ${rows.length}`);
console.log(`Distinct orphan spotify_ids across DB: ${totalOrphans}`);
if (unlinkedOrphans) console.log(`Orphan rows in playlists with no genre link: ${unlinkedOrphans}`);
