/* /api/v4/databox-atmospheres.js
   Runtime source of atmosphere parameter ranges.

   Reads from the Supabase `atmospheres` table (the source of truth once Ami
   has scanned). If the DB table is empty (fresh install, or before Ami's
   first atmosphere scan), falls back to fetching the sheet directly — so
   the runtime pipeline never sees a hole. Response shape is unchanged from
   the previous sheet-only version:

     { rows: [{ row, atmosphere, ranges: { energy: [lo, hi] | null, ... } }] }

   Sheet layout (kept here for the fallback and for the scan endpoint's parser):
     A atmosphere  | B mode (reserved, ignored) | C energy
     D danceability | E happiness | F popularity
     G speechiness  | H instrumentalness | I bpm  ← new column

   Range cells look like "70-100" or "0-50". Dashed cells ("--", "---", "----"),
   blank cells, and the token "all" all mean "no constraint" → null.
*/

import { pgrSelect } from './supabase-client.js';

let cache = null;
let cacheTime = 0;
const CACHE_MS = 30 * 60 * 1000;

const SHEET_ID = '1Ujk7Mb-i1i1LCfQZ31W27pDF66CGobrt9jifRqc0d28';
const GID      = '0';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

const START_ROW = 2;   // 1-based; row 1 is header
const END_ROW   = 50;  // safety cap

// Order matches the sheet columns C..I. Do not reorder without also updating
// PARAM_COL_OFFSET below.
export const PARAMS = ['energy', 'danceability', 'happiness', 'popularity', 'speechiness', 'instrumentalness', 'bpm'];
const PARAM_COL_OFFSET = 2; // column C (index 2) is the first param

// ---- parsers (exported so ami-atmospheres-scan can reuse) -------------------

export function parseCSVLine(line) {
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

// Returns [low, high] for "L-R" cells, or null for dashed / blank / "all" /
// unparseable cells.
export function parseRange(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const lo = parseInt(m[1], 10);
  const hi = parseInt(m[2], 10);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

export function parseRow(cells, rowNumber) {
  const atmosphere = (cells[0] || '').trim();
  if (!atmosphere) return null;
  const ranges = {};
  for (let i = 0; i < PARAMS.length; i++) {
    ranges[PARAMS[i]] = parseRange(cells[PARAM_COL_OFFSET + i]);
  }
  return { row: rowNumber, atmosphere, ranges };
}

// Fetch + parse the sheet directly. Used by (a) the fallback path here when
// the DB is empty, and (b) the scan endpoint when computing the diff.
export async function fetchAtmospheresFromSheet() {
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
  return rows;
}

// ---- handler ----------------------------------------------------------------

async function loadFromSupabase() {
  const rows = await pgrSelect('atmospheres', {}, {
    select: 'name,ranges,row_in_sheet',
    order:  'row_in_sheet.asc',
  });
  return rows.map((r) => ({
    row:        r.row_in_sheet,
    atmosphere: r.name,
    ranges:     r.ranges || {},
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const fresh = req.query?.fresh === '1' || req.query?.fresh === 'true';
  if (!fresh && cache && Date.now() - cacheTime < CACHE_MS) {
    return res.status(200).json(cache);
  }

  // fresh=1 must NOT be cached at Vercel's edge — same fix we applied to
  // databox.js and databox-genres.js.
  if (fresh) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=1800');
  }

  try {
    // 1. Prefer Supabase (source of truth once Ami has scanned).
    let rows = [];
    try {
      rows = await loadFromSupabase();
    } catch (e) {
      // Supabase unreachable — fall back to sheet so the runtime doesn't hard-fail.
      console.warn('[databox-atmospheres] Supabase read failed, falling back to sheet:', e.message);
    }
    // 2. Empty DB (pre-first-scan) → seed the response from the sheet so the
    //    runtime pipeline keeps working before Ami's first scan.
    if (rows.length === 0) {
      rows = await fetchAtmospheresFromSheet();
    }

    cache = { rows, fetchedAt: new Date().toISOString() };
    cacheTime = Date.now();
    return res.status(200).json(cache);
  } catch (e) {
    if (cache) return res.status(200).json({ ...cache, stale: true });
    return res.status(503).json({ error: e.message, rows: [] });
  }
}
