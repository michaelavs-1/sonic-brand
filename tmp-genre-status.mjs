import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchAllLean(table, cols, orderCol = cols.split(',')[0]) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const params = new URLSearchParams({ select: cols, order: `${orderCol}.asc` });
    const r = await fetch(`${SB}/rest/v1/${table}?${params}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + PAGE - 1}` },
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

console.log('Fetching playlist_genres, playlist_tracks, track_analyses...');
const pg = await fetchAllLean('playlist_genres', 'playlist_id,genre', 'genre');
const pt = await fetchAllLean('playlist_tracks', 'playlist_id,spotify_id');
const ta = await fetchAllLean('track_analyses', 'spotify_id,status');

const okSet = new Set(ta.filter(r => r.status === 'ok').map(r => r.spotify_id));
const tracksByPlaylist = new Map();
for (const r of pt) {
  if (!tracksByPlaylist.has(r.playlist_id)) tracksByPlaylist.set(r.playlist_id, new Set());
  tracksByPlaylist.get(r.playlist_id).add(r.spotify_id);
}
const playlistsByGenre = new Map();
for (const r of pg) {
  if (!playlistsByGenre.has(r.genre)) playlistsByGenre.set(r.genre, new Set());
  playlistsByGenre.get(r.genre).add(r.playlist_id);
}

const rows = [];
for (const [genre, pids] of playlistsByGenre) {
  const okTracks = new Set();
  for (const pid of pids) {
    for (const sid of (tracksByPlaylist.get(pid) || [])) {
      if (okSet.has(sid)) okTracks.add(sid);
    }
  }
  rows.push({ genre, count: okTracks.size });
}
rows.sort((a, b) => a.genre.localeCompare(b.genre));

console.log('');
console.log('genre'.padEnd(30) + 'ok tracks');
console.log('-'.repeat(45));
for (const r of rows) console.log(r.genre.padEnd(30) + String(r.count).padStart(7));
console.log('-'.repeat(45));
console.log('Total DB genres:', rows.length);
