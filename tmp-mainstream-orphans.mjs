// Find a mainstream playlist with a decent number of orphans (unanalyzed
// tracks in playlist_tracks). Prefer Modern Pop / Hip Hop / Rock — the
// genres where the provider historically hits >95% OK rate.

import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAINSTREAM = ['modern pop', 'hip hop', 'rock', 'indie rock', 'trap', 'alternative pop', 'electro pop'];

async function fetchAllLean(table, cols = 'spotify_id', orderCol = 'spotify_id') {
  const out = [];
  let from = 0;
  const PAGE = 500;
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
async function pgrIn(table, col, values, cols) {
  const out = [];
  const CHUNK = 200;
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    const filter = `in.(${slice.map(v => `"${v}"`).join(',')})`;
    const r = await fetch(`${SB}/rest/v1/${table}?${new URLSearchParams({ select: cols, [col]: filter })}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    out.push(...(await r.json()));
  }
  return out;
}

console.log('Loading track_analyses (lean)...');
const taRows = await fetchAllLean('track_analyses');
const taSet = new Set(taRows.map(r => r.spotify_id));
console.log(`  ${taSet.size} analyzed spotify_ids`);
console.log('');

const candidates = []; // { genre, playlist_id, orphan_count }
for (const genre of MAINSTREAM) {
  const pg = await pgrIn('playlist_genres', 'genre', [genre], 'playlist_id,position_in_genre');
  for (const r of pg) {
    const pt = await pgrIn('playlist_tracks', 'playlist_id', [r.playlist_id], 'spotify_id');
    const tracks = pt.map(x => x.spotify_id);
    const orphans = tracks.filter(id => !taSet.has(id));
    if (orphans.length > 0) {
      candidates.push({ genre, playlist_id: r.playlist_id, pos: r.position_in_genre, total: tracks.length, orphans: orphans.length });
    }
  }
}

candidates.sort((a, b) => b.orphans - a.orphans);
console.log('Mainstream playlists with orphans (top 20):');
console.log('genre'.padEnd(18) + 'pos  playlist_id             tracks  orphans');
console.log('-'.repeat(70));
for (const c of candidates.slice(0, 20)) {
  console.log(c.genre.padEnd(18) + String(c.pos).padStart(3) + '  ' + c.playlist_id + '  ' + String(c.total).padStart(6) + '  ' + String(c.orphans).padStart(7));
}
console.log('');
console.log(`Total mainstream playlists with orphans: ${candidates.length}`);
console.log(`Total mainstream orphan tracks: ${candidates.reduce((s, c) => s + c.orphans, 0)}`);
