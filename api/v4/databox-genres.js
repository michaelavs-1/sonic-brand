/* /api/v4/databox-genres.js
   Fetches Data Box Tab 2 (genre → playlists mapping). Cached 30 minutes.

   Tab 2 column layout from sheet (header row 4):
     0 Genre | 1 Known/Unkown (ignored) | 2–16 Example 1..15 (playlist URLs)
     17 Purpose (ignored)
   Data rows start at row 7. Genre name is matched against Tab 1 genres1/genres2
   case-insensitively and trim-normalized — see v4/generation/preview-builder.js.
*/

let cache = null;
let cacheTime = 0;
const CACHE_MS = 30 * 60 * 1000;

const SHEET_ID = '1b-0rsKBvTSqE0ju7EfGRnpOQiVESZR8hsJBsuITns_E';
const GID      = '1199564828';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

const START_ROW = 7;
const END_ROW   = 50;

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else if (c !== '\r') cur += c;
  }
  result.push(cur);
  return result;
}

function extractPlaylistId(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.replace(/\\\\/g, '').replace(/\\n/g, '').split('?')[0];
  const m = clean.match(/playlist\/([A-Za-z0-9]{10,30})/);
  return m ? m[1] : null;
}

function parseRow(cells, rowNumber) {
  const genre = (cells[0] || '').trim();
  if (!genre) return null;
  const playlists = [];
  for (let i = 2; i <= 16; i++) {
    const url = (cells[i] || '').trim();
    if (!url) continue;
    const id = extractPlaylistId(url);
    if (!id) continue;
    playlists.push({ url, id });
  }
  return { row: rowNumber, genre, playlists };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const fresh = req.query?.fresh === '1' || req.query?.fresh === 'true';
  if (!fresh && cache && Date.now() - cacheTime < CACHE_MS) {
    return res.status(200).json(cache);
  }

  try {
    const r = await fetch(CSV_URL, {
      headers: { 'User-Agent': 'SonicBrand-Rubin/1.0' }
    });
    if (!r.ok) throw new Error(`Sheet fetch failed: ${r.status}`);
    const text = await r.text();
    const lines = text.split('\n');

    const rows = [];
    for (let lineIdx = START_ROW - 1; lineIdx <= END_ROW - 1 && lineIdx < lines.length; lineIdx++) {
      const cells = parseCSVLine(lines[lineIdx]);
      const parsed = parseRow(cells, lineIdx + 1);
      if (parsed) rows.push(parsed);
    }

    cache = { rows, fetchedAt: new Date().toISOString() };
    cacheTime = Date.now();
    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.status(200).json(cache);

  } catch (e) {
    if (cache) return res.status(200).json({ ...cache, stale: true });
    return res.status(503).json({ error: e.message, rows: [] });
  }
}
