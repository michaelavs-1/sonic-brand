/* /api/databox.js
   Fetches the live Data Box Google Sheet and returns parsed entries.
   Cached in memory for 30 minutes between warm Vercel invocations.
*/

let cache = null;
let cacheTime = 0;
const CACHE_MS = 30 * 60 * 1000; // 30 min

const SHEET_ID = '1b-0rsKBvTSqE0ju7EfGRnpOQiVESZR8hsJBsuITns_E';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

/* ── CSV helpers ─────────────────────────────────────── */
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else if (c !== '\r') cur += c;
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] || '').trim(); });
    return row;
  });
}

/* ── Playlist ID extractor ───────────────────────────── */
function extractId(url) {
  if (!url || typeof url !== 'string') return null;
  // Strip escapes and query params
  const clean = url.replace(/\\\\/g, '').replace(/\\n/g, '').split('?')[0];
  const m = clean.match(/playlist\/([A-Za-z0-9]{10,30})/);
  return m ? m[1] : null;
}

/* ── Row → entries ───────────────────────────────────── */
function buildEntries(rows) {
  const map = {};

  for (const row of rows) {
    const bizType    = (row['Type Of business'] || '').trim();
    const energyRaw  = (row['Energy level']     || '').trim();
    if (!bizType) continue;

    // Parse energy level — accept "1", "2", "1+2", "1 (calm)", etc.
    let levels = [];
    if (/^1\+2/.test(energyRaw) || energyRaw === '1+2') levels = [1, 2];
    else if (/^1/.test(energyRaw)) levels = [1];
    else if (/^2/.test(energyRaw)) levels = [2];
    else continue; // skip category headers or incomplete rows

    // Collect playlist IDs
    const playlists = [];
    for (let i = 1; i <= 15; i++) {
      const id = extractId(row[`Example ${i}`]);
      if (id) playlists.push(id);
    }
    if (!playlists.length) continue;

    // Other metadata
    const keywords   = (row['Key Words']        || '').split(',').map(s => s.trim()).filter(Boolean);
    const atmospheres= (row['Atmospheres']       || '').split(',').map(s => s.trim()).filter(Boolean);
    const genres     = (row['Style / Genres']    || '').trim();
    const knownLevel = parseInt((row['known / unkown']  || '3').match(/^(\d)/)?.[1] || '3');
    const hebrewLevel= parseInt((row['Hebrew / Foreign']|| '3').match(/^(\d)/)?.[1] || '3');

    if (!map[bizType]) {
      map[bizType] = { label: bizType, keywords, atmospheres, knownLevel, hebrewLevel, energy: {} };
    }

    for (const lv of levels) {
      map[bizType].energy[lv] = { playlists, genres, atmospheres };
    }
  }

  return Object.values(map).filter(e => Object.keys(e.energy).length > 0);
}

/* ── Handler ─────────────────────────────────────────── */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Serve from cache if fresh
  if (cache && Date.now() - cacheTime < CACHE_MS) {
    return res.status(200).json(cache);
  }

  try {
    const r = await fetch(CSV_URL, {
      headers: { 'User-Agent': 'SonicBrand-Robin/1.0' }
    });
    if (!r.ok) throw new Error(`Sheet fetch failed: ${r.status}`);
    const text = await r.text();
    const rows = parseCSV(text);
    const entries = buildEntries(rows);
    if (!entries.length) throw new Error('Parsed 0 entries — check sheet access');

    cache = { entries, fetchedAt: new Date().toISOString() };
    cacheTime = Date.now();
    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.status(200).json(cache);

  } catch(e) {
    // Stale cache is better than nothing
    if (cache) return res.status(200).json({ ...cache, stale: true });
    return res.status(503).json({ error: e.message, entries: [] });
  }
}
