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
function parseCSVLine(line) {
  const r = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { r.push(cur); cur = ''; }
    else if (c !== '\r') cur += c;
  }
  r.push(cur);
  return r;
}
function extractId(u) {
  if (!u) return null;
  const c = u.replace(/\\/g, '').replace(/\n/g, '').split('?')[0];
  const m = c.match(/playlist\/([A-Za-z0-9]{10,30})/);
  return m ? m[1] : null;
}
function isEditorial(id) { return typeof id === 'string' && id.startsWith('37i9dQZF1D'); }

console.log('Fetching Supabase tables...');
const pg = await fetchAllLean('playlist_genres', 'playlist_id,genre', 'genre');
const pt = await fetchAllLean('playlist_tracks', 'playlist_id,spotify_id');
const ta = await fetchAllLean('track_analyses', 'spotify_id,status');
const okSet = new Set(ta.filter(r => r.status === 'ok').map(r => r.spotify_id));
const dbPlaylistTracksSet = new Set(pt.map(r => r.playlist_id));

console.log('Fetching sheet Tab 2...');
const t = await fetch('https://docs.google.com/spreadsheets/d/1AkMEsptNZFavFDpjbWnbAomhND9Ub004MFD7cICeXr8/export?format=csv&gid=1199564828', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
const lines = t.split('\n');
const sheetGenres = [];  // { normalized, name, row, undigestedUsable, undigestedEditorial }
for (let i = 6; i < lines.length; i++) {
  const cells = parseCSVLine(lines[i]);
  const g = (cells[0] || '').trim();
  if (!g) continue;
  const norm = g.toLowerCase();
  let undigestedUsable = 0;
  let undigestedEditorial = 0;
  for (let j = 2; j <= 16; j++) {
    const u = (cells[j] || '').trim();
    if (!u) continue;
    const id = extractId(u);
    if (!id) continue;
    if (dbPlaylistTracksSet.has(id)) continue;
    if (isEditorial(id)) undigestedEditorial++;
    else undigestedUsable++;
  }
  sheetGenres.push({ normalized: norm, name: g, row: i + 1, undigestedUsable, undigestedEditorial });
}

// Per-genre OK counts
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
const okCountByGenre = new Map();
for (const [genre, pids] of playlistsByGenre) {
  const okTracks = new Set();
  for (const pid of pids) {
    for (const sid of (tracksByPlaylist.get(pid) || [])) {
      if (okSet.has(sid)) okTracks.add(sid);
    }
  }
  okCountByGenre.set(genre, okTracks.size);
}

// Rows in sheet order
console.log('');
console.log('genre'.padEnd(30) + 'ok tracks   undigested (usable+editorial)');
console.log('-'.repeat(70));
for (const g of sheetGenres) {
  const ok = okCountByGenre.get(g.normalized) || 0;
  const uStr = String(g.undigestedUsable).padStart(3) + (g.undigestedEditorial ? ` (+${g.undigestedEditorial} edit.)` : '');
  console.log(g.name.padEnd(30) + String(ok).padStart(7) + '     ' + uStr);
}
console.log('-'.repeat(70));
console.log('Total sheet genres:', sheetGenres.length);
console.log('Total OK tracks (distinct):', okSet.size);
console.log('Total undigested usable:', sheetGenres.reduce((s, g) => s + g.undigestedUsable, 0));
console.log('Total undigested editorial (unfetchable):', sheetGenres.reduce((s, g) => s + g.undigestedEditorial, 0));

// Also list any DB genres not in current sheet (stale)
const sheetSet = new Set(sheetGenres.map(g => g.normalized));
const stale = [...playlistsByGenre.keys()].filter(g => !sheetSet.has(g));
if (stale.length) {
  console.log('');
  console.log('DB genres NOT in current sheet (stale):');
  for (const g of stale) console.log(`  ${g}  (ok tracks: ${okCountByGenre.get(g) || 0})`);
}
