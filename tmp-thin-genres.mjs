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

console.log('Fetching sheet Tab 2 + DB playlist_genres...');
const [t, pg] = await Promise.all([
  fetch('https://docs.google.com/spreadsheets/d/1AkMEsptNZFavFDpjbWnbAomhND9Ub004MFD7cICeXr8/export?format=csv&gid=1199564828', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text()),
  paged('playlist_genres?select=playlist_id,genre'),
]);

const lines = t.split('\n');
const sheetGenres = [];
for (let i = 6; i < lines.length; i++) {
  const cells = parseCSVLine(lines[i]);
  const g = (cells[0] || '').trim();
  if (!g) continue;
  sheetGenres.push({ name: g, normalized: g.toLowerCase() });
}

const pgByGenre = new Map();
for (const r of pg) {
  if (!pgByGenre.has(r.genre)) pgByGenre.set(r.genre, new Set());
  pgByGenre.get(r.genre).add(r.playlist_id);
}

console.log('');
console.log('genre'.padEnd(30) + 'digested playlists');
console.log('-'.repeat(52));
const thin = sheetGenres
  .map(g => ({ ...g, count: (pgByGenre.get(g.normalized) || new Set()).size }))
  .filter(g => g.count < 2)
  .sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
for (const g of thin) console.log(g.name.padEnd(30) + String(g.count).padStart(6));
console.log('-'.repeat(52));
console.log('Genres with < 2 digested playlists:', thin.length);
