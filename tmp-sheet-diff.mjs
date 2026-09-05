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

function isEditorial(id) {
  return typeof id === 'string' && id.startsWith('37i9dQZF1D');
}

console.log('Fetching sheet Tab 2 + DB tables...');
const [sheetText, pg, pt] = await Promise.all([
  fetch('https://docs.google.com/spreadsheets/d/1AkMEsptNZFavFDpjbWnbAomhND9Ub004MFD7cICeXr8/export?format=csv&gid=1199564828', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text()),
  paged('playlist_genres?select=playlist_id,genre'),
  paged('playlist_tracks?select=playlist_id'),
]);

const lines = sheetText.split('\n');
const sheetGenres = [];  // [{ name, normalized, playlists: [{ id, position, isEditorial }] }]
for (let i = 6; i < lines.length; i++) {
  const cells = parseCSVLine(lines[i]);
  const g = (cells[0] || '').trim();
  if (!g) continue;
  const norm = g.toLowerCase();
  const playlists = [];
  for (let j = 2; j <= 20; j++) {
    const u = (cells[j] || '').trim();
    if (!u) continue;
    const id = extractId(u);
    if (!id) continue;
    playlists.push({ id, position: j - 1, isEditorial: isEditorial(id) });
  }
  sheetGenres.push({ name: g, normalized: norm, playlists });
}

const dbGenres = new Set(pg.map(r => r.genre));
const dbPlaylistIds = new Set(pt.map(r => r.playlist_id));

// New genres in sheet not in DB at all
const newGenres = sheetGenres.filter(g => !dbGenres.has(g.normalized));

// Per-genre: playlists in sheet that aren't in playlist_tracks (undigested)
const newPlaylistsByGenre = new Map();
let totalNewUsable = 0;
let totalNewEditorial = 0;
for (const g of sheetGenres) {
  const missing = g.playlists.filter(p => !dbPlaylistIds.has(p.id));
  if (missing.length === 0) continue;
  newPlaylistsByGenre.set(g.name, missing);
  for (const p of missing) {
    if (p.isEditorial) totalNewEditorial++;
    else totalNewUsable++;
  }
}

console.log('');
console.log('=== NEW GENRES IN SHEET NOT IN DB ===');
if (newGenres.length === 0) console.log('  (none — every sheet genre has at least one DB entry)');
for (const g of newGenres) {
  console.log(`  ${g.name} (${g.playlists.length} sheet playlists, ${g.playlists.filter(p => p.isEditorial).length} editorial)`);
}

console.log('');
console.log('=== NEW SHEET PLAYLISTS NOT YET IN playlist_tracks (per genre) ===');
if (newPlaylistsByGenre.size === 0) console.log('  (none — every sheet playlist is already ingested)');
const rows = [...newPlaylistsByGenre.entries()]
  .map(([g, list]) => ({ g, usable: list.filter(p => !p.isEditorial).length, editorial: list.filter(p => p.isEditorial).length }))
  .sort((a, b) => (b.usable + b.editorial) - (a.usable + a.editorial));
console.log('genre'.padEnd(30) + 'usable   editorial');
console.log('-'.repeat(52));
for (const r of rows) console.log(r.g.padEnd(30) + String(r.usable).padStart(6) + String(r.editorial).padStart(12));
console.log('-'.repeat(52));
console.log(`Totals: ${totalNewUsable} usable + ${totalNewEditorial} editorial across ${newPlaylistsByGenre.size} genres`);

// DB genres not in sheet (stale)
const sheetSet = new Set(sheetGenres.map(g => g.normalized));
const staleDbGenres = [...dbGenres].filter(g => !sheetSet.has(g));
if (staleDbGenres.length) {
  console.log('');
  console.log('=== DB GENRES NOT IN CURRENT SHEET ===');
  for (const g of staleDbGenres) console.log(`  ${g}`);
}
