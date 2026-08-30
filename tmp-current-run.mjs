import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Slice the log to only the current run (last === batch start ===).
const log = fs.readFileSync('d:/Projects/algorithm/sonic-brand/v4/precompute/state/batch.log', 'utf8');
const lines = log.split(/\r?\n/);
let startIdx = -1;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('=== batch start ===')) { startIdx = i; break; }
}
if (startIdx === -1) { console.error('no start marker'); process.exit(1); }
const runLines = lines.slice(startIdx);
const startTsMatch = lines[startIdx].match(/\[([^\]]+)\]/);
const startTs = startTsMatch ? startTsMatch[1] : null;
console.log(`Run start: ${startTs}`);
console.log(`Log lines in run: ${runLines.length}`);

const okIds = [];
const terminalIds = [];
const notFoundIds = [];
const retryCounts = new Map();  // spotify_id -> in-flight attempt count
for (const ln of runLines) {
  let m;
  if ((m = ln.match(/ ok ([A-Za-z0-9]{22}) /))) okIds.push(m[1]);
  else if ((m = ln.match(/WARN terminal ([A-Za-z0-9]{22}): /))) terminalIds.push(m[1]);
  else if ((m = ln.match(/ not_found ([A-Za-z0-9]{22}) /))) notFoundIds.push(m[1]);
  else if ((m = ln.match(/WARN [a-z_]+ on ([A-Za-z0-9]{22}): .*attempt (\d)\/6/))) {
    const attempt = parseInt(m[2], 10);
    retryCounts.set(m[1], Math.max(retryCounts.get(m[1]) || 0, attempt));
  }
}
console.log(`\nOK: ${okIds.length}`);
console.log(`Terminal errors: ${terminalIds.length}`);
console.log(`Not found: ${notFoundIds.length}`);

// In-flight (has retry warnings but no ok/terminal yet)
const settledSet = new Set([...okIds, ...terminalIds, ...notFoundIds]);
const inFlight = [...retryCounts.entries()].filter(([id]) => !settledSet.has(id));
console.log(`In-flight retries (not yet resolved): ${inFlight.length}`);

const allIds = [...new Set([...okIds, ...terminalIds, ...notFoundIds])];
if (allIds.length === 0) { console.log('nothing settled yet'); process.exit(0); }

async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function chunkedIn(table, col, ids, otherParams) {
  const out = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const inList = slice.map(x => `"${x}"`).join(',');
    const params = new URLSearchParams({ [col]: `in.(${inList})`, ...otherParams });
    const rows = await get(`${table}?${params}`);
    out.push(...rows);
  }
  return out;
}

console.log('\nLoading genre mappings...');
const pt = await chunkedIn('playlist_tracks', 'spotify_id', allIds, { select: 'spotify_id,playlist_id' });
const playlistIds = [...new Set(pt.map(r => r.playlist_id))];
const pg = await chunkedIn('playlist_genres', 'playlist_id', playlistIds, { select: 'playlist_id,genre' });

const genresByPlaylist = new Map();
for (const r of pg) {
  if (!genresByPlaylist.has(r.playlist_id)) genresByPlaylist.set(r.playlist_id, new Set());
  genresByPlaylist.get(r.playlist_id).add(r.genre);
}
const genresByTrack = new Map();  // spotify_id -> Set(genre)
for (const r of pt) {
  if (!genresByTrack.has(r.spotify_id)) genresByTrack.set(r.spotify_id, new Set());
  for (const g of genresByPlaylist.get(r.playlist_id) || []) {
    genresByTrack.get(r.spotify_id).add(g);
  }
}

// Per-genre bucketing (a track in >1 genre counts toward each)
const okByGenre = new Map();
const termByGenre = new Map();
const nfByGenre = new Map();
const noGenre = { ok: 0, term: 0, nf: 0 };
for (const [ids, bucket, unlinkedKey] of [
  [okIds, okByGenre, 'ok'],
  [terminalIds, termByGenre, 'term'],
  [notFoundIds, nfByGenre, 'nf'],
]) {
  for (const id of ids) {
    const gs = genresByTrack.get(id);
    if (!gs || gs.size === 0) { noGenre[unlinkedKey]++; continue; }
    for (const g of gs) bucket.set(g, (bucket.get(g) || 0) + 1);
  }
}

const allGenres = new Set([...okByGenre.keys(), ...termByGenre.keys(), ...nfByGenre.keys()]);
const rows = [...allGenres].map(g => ({
  genre: g,
  ok:   okByGenre.get(g)   || 0,
  term: termByGenre.get(g) || 0,
  nf:   nfByGenre.get(g)   || 0,
})).sort((a, b) => (b.ok + b.term + b.nf) - (a.ok + a.term + a.nf));

console.log('\n=== Per-genre results (unique track counts; a track in N genres counts for each) ===');
console.log('genre'.padEnd(30) + 'ok'.padStart(6) + 'terminal'.padStart(10) + 'not_found'.padStart(11) + '   err_rate');
console.log('-'.repeat(72));
for (const r of rows) {
  const total = r.ok + r.term + r.nf;
  const errRate = total ? ((r.term / total) * 100).toFixed(1) + '%' : '-';
  console.log(r.genre.padEnd(30) + String(r.ok).padStart(6) + String(r.term).padStart(10) + String(r.nf).padStart(11) + '   ' + errRate);
}
if (noGenre.ok + noGenre.term + noGenre.nf) {
  console.log('<unlinked>'.padEnd(30) + String(noGenre.ok).padStart(6) + String(noGenre.term).padStart(10) + String(noGenre.nf).padStart(11));
}
console.log('-'.repeat(72));
console.log('TOTAL'.padEnd(30) + String(okIds.length).padStart(6) + String(terminalIds.length).padStart(10) + String(notFoundIds.length).padStart(11));
const overall = okIds.length + terminalIds.length + notFoundIds.length;
console.log(`\nOverall error rate: ${overall ? ((terminalIds.length / overall) * 100).toFixed(1) : 0}%`);
console.log(`Overall success rate: ${overall ? ((okIds.length / overall) * 100).toFixed(1) : 0}%`);
