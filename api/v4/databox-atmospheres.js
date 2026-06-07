/* /api/v4/databox-atmospheres.js
   Fetches the atmosphere parameter sheet (separate from the Data Box).
   Returns one row per atmosphere with parsed range tuples per parameter.

   Sheet layout (rows 2-18 are data; row 1 is header):
     A atmosphere  | B mode (reserved, ignored) | C energy
     D danceability | E happiness | F popularity
     G speechiness  | H instrumentalness

   Range cells look like "70-100" or "0-50". Dashed cells ("--", "---", "----")
   or anything that doesn't parse as N-M means "no constraint on this parameter".
*/

let cache = null;
let cacheTime = 0;
const CACHE_MS = 30 * 60 * 1000;

const SHEET_ID = '1Ujk7Mb-i1i1LCfQZ31W27pDF66CGobrt9jifRqc0d28';
const GID      = '0';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

const START_ROW = 2;   // 1-based; row 1 is header
const END_ROW   = 50;  // safety cap

const PARAMS = ['energy', 'danceability', 'happiness', 'popularity', 'speechiness', 'instrumentalness'];
const PARAM_COL_OFFSET = 2; // column C (index 2) is the first param

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

// Returns [low, high] for "L-R" cells, or null for dashed/blank/unparseable cells.
function parseRange(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const lo = parseInt(m[1], 10);
  const hi = parseInt(m[2], 10);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function parseRow(cells, rowNumber) {
  const atmosphere = (cells[0] || '').trim();
  if (!atmosphere) return null;
  const ranges = {};
  for (let i = 0; i < PARAMS.length; i++) {
    ranges[PARAMS[i]] = parseRange(cells[PARAM_COL_OFFSET + i]);
  }
  return { row: rowNumber, atmosphere, ranges };
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
      headers: { 'User-Agent': 'SonicBrand-Rubin/1.0' },
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
