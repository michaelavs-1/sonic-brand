import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORM_IDS = [
  '0nycmBIHxjPnwQRtM16Umu',
  '2gwZ6ZmwlmNQyRgnP8hpO8',
  '4UP3YkqXmT8EphR0ui94Iv',
  '5jZs79KOjXHJaEKDvSCt6W',
  '1DF9XPespiTUJKh5MRRStG',
  '1ogAili0640WOpshIjvrYM',
  '13wN7GbvGRZcLmxwUXQ0pp',
  '6pjwnJolD5z41UhLdrPLjw',
  '08w99wWwHyMN1sACJgjGpt',
];

async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

const inList = STORM_IDS.map(id => `"${id}"`).join(',');
const pt = await get(`playlist_tracks?spotify_id=in.(${inList})&select=spotify_id,playlist_id`);

const playlistIds = [...new Set(pt.map(r => r.playlist_id))];
const pgInList = playlistIds.map(id => `"${id}"`).join(',');
const pg = await get(`playlist_genres?playlist_id=in.(${pgInList})&select=playlist_id,genre,position_in_genre`);

const genresByPlaylist = new Map();
for (const r of pg) {
  if (!genresByPlaylist.has(r.playlist_id)) genresByPlaylist.set(r.playlist_id, []);
  genresByPlaylist.get(r.playlist_id).push(`${r.genre} (pos ${r.position_in_genre})`);
}

console.log('\n=== Storm track → playlist → genre map ===');
for (const sid of STORM_IDS) {
  const pids = pt.filter(r => r.spotify_id === sid).map(r => r.playlist_id);
  console.log(`\n${sid}`);
  for (const pid of pids) {
    const gs = genresByPlaylist.get(pid) || ['(no genre linkage)'];
    console.log(`  playlist ${pid} → ${gs.join(' | ')}`);
  }
}

const genreHits = new Map();
for (const sid of STORM_IDS) {
  const pids = pt.filter(r => r.spotify_id === sid).map(r => r.playlist_id);
  const seenGenres = new Set();
  for (const pid of pids) {
    for (const gs of genresByPlaylist.get(pid) || []) {
      const g = gs.split(' (pos ')[0];
      if (seenGenres.has(g)) continue;
      seenGenres.add(g);
      genreHits.set(g, (genreHits.get(g) || 0) + 1);
    }
  }
}
console.log('\n=== Genre frequency across storm tracks ===');
const sorted = [...genreHits.entries()].sort((a, b) => b[1] - a[1]);
for (const [g, n] of sorted) console.log(`  ${g}: ${n} storm tracks`);
