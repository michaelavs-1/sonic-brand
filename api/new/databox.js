/* /api/new/databox.js
   Fetches the live Data Box Google Sheet and returns RAW rows for the new pipeline.
   No grouping, no row-dropping. Rows 8–100 in spreadsheet order.
   Cached in memory for 30 minutes between warm Vercel invocations.
*/

let cache = null;
let cacheTime = 0;
const CACHE_MS = 30 * 60 * 1000;

const SHEET_ID = '1b-0rsKBvTSqE0ju7EfGRnpOQiVESZR8hsJBsuITns_E';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

const START_ROW = 8;     // 1-based spreadsheet row
const END_ROW   = 100;   // 1-based inclusive

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

// Column layout from the live sheet header (row 5):
// 0 Type Of business | 1 Key Words | 2 Energy level | 3 Atmospheres
// 4 known/unkown     | 5 Hebrew/Foreign | 6 Style/Genres
// 7–21 Example 1 … Example 15 | 22 Purpose
function parseRow(cells, rowNumber) {
  const playlists = [];
  for (let i = 7; i <= 21; i++) {
    const url = (cells[i] || '').trim();
    if (!url) continue;
    playlists.push({ url, id: extractPlaylistId(url) });
  }
  return {
    row: rowNumber,
    bizType:     (cells[0]  || '').trim(),
    keywords:    (cells[1]  || '').split(',').map(s => s.trim()).filter(Boolean),
    energy:      (cells[2]  || '').trim(),
    atmospheres: (cells[3]  || '').split(',').map(s => s.trim()).filter(Boolean),
    knownLevel:  (cells[4]  || '').trim(),
    hebrewLevel: (cells[5]  || '').trim(),
    genres:      (cells[6]  || '').trim(),
    playlists,
    purpose:     (cells[22] || '').trim(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cache && Date.now() - cacheTime < CACHE_MS) {
    return res.status(200).json(cache);
  }

  try {
    const r = await fetch(CSV_URL, {
      headers: { 'User-Agent': 'SonicBrand-Robin/1.0' }
    });
    if (!r.ok) throw new Error(`Sheet fetch failed: ${r.status}`);
    const text = await r.text();
    const lines = text.split('\n');

    const rows = [];
    for (let lineIdx = START_ROW - 1; lineIdx <= END_ROW - 1 && lineIdx < lines.length; lineIdx++) {
      const cells = parseCSVLine(lines[lineIdx]);
      rows.push(parseRow(cells, lineIdx + 1));
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
