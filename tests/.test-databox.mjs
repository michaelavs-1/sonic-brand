// One-off script: exercises the same logic as api/new/databox.js against the live sheet,
// then runs the GPT-based matcher against several inputs.
//
// Run, in two terminals:
//   1) vercel dev                     (serves api/new/openai on localhost:3000, resolves key via Supabase)
//   2) node .test-databox.mjs         (this script)
//
// The matcher does `fetch('/api/new/openai')` (a relative URL). Node can't resolve
// relative URLs, so we patch globalThis.fetch to rewrite that path to localhost.

const SHEET_ID = '1b-0rsKBvTSqE0ju7EfGRnpOQiVESZR8hsJBsuITns_E';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const START_ROW = 8;
const END_ROW   = 100;

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
  if (!url) return null;
  const clean = url.replace(/\\\\/g, '').replace(/\\n/g, '').split('?')[0];
  const m = clean.match(/playlist\/([A-Za-z0-9]{10,30})/);
  return m ? m[1] : null;
}

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

const t0 = Date.now();
const r = await fetch(CSV_URL, { headers: { 'User-Agent': 'SonicBrand-Robin/1.0' } });
console.log(`fetch: ${r.status} ${r.statusText} in ${Date.now() - t0}ms`);
if (!r.ok) { console.error('Sheet fetch failed'); process.exit(1); }

const text = await r.text();
const lines = text.split('\n');
console.log(`csv: ${text.length} bytes, ${lines.length} lines`);

const rows = [];
for (let i = START_ROW - 1; i <= END_ROW - 1 && i < lines.length; i++) {
  rows.push(parseRow(parseCSVLine(lines[i]), i + 1));
}

const withType    = rows.filter(r => r.bizType);
const withoutType = rows.filter(r => !r.bizType);
const noEnergy    = rows.filter(r => r.bizType && !r.energy);
const withPlaylists = rows.filter(r => r.playlists.length > 0);

console.log();
console.log('=== summary ===');
console.log('total parsed rows         :', rows.length);
console.log('rows with bizType         :', withType.length);
console.log('rows without bizType      :', withoutType.length, '(section headers / spacers)');
console.log('rows with bizType, NO energy:', noEnergy.length, '(would be dropped by old endpoint)');
console.log('rows with at least 1 playlist:', withPlaylists.length);

console.log();
console.log('=== first 3 typed rows ===');
withType.slice(0, 3).forEach(r => {
  console.log(`row ${r.row}: bizType="${r.bizType}" energy="${r.energy}" kw=${r.keywords.length} pls=${r.playlists.length} kw[0]="${r.keywords[0] || ''}"`);
});

console.log();
console.log('=== rows with bizType but no energy (the ones the old endpoint silently drops) ===');
noEnergy.slice(0, 10).forEach(r => {
  console.log(`row ${r.row}: bizType="${r.bizType}" energy="${r.energy}" kw=${r.keywords.length} pls=${r.playlists.length}`);
});

console.log();
console.log('=== sample playlist IDs from row 8 (בר שכונתי, energy 1) ===');
const r8 = rows.find(r => r.row === 8);
if (r8) {
  console.log(`row ${r8.row}: ${r8.bizType}`);
  r8.playlists.slice(0, 3).forEach(p => console.log(`  - id=${p.id} url=${p.url.slice(0, 60)}...`));
} else {
  console.log('(no row 8 found)');
}

console.log();
console.log('=== matcher end-to-end ===');

// fetch shim: rewrite the matcher's relative /api/new/openai to the local vercel dev server.
// The proxy at localhost:3000 resolves the OpenAI key (env var → Supabase fallback) on its own.
const DEV_BASE = process.env.DEV_BASE || 'http://localhost:3000';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('/api/new/openai')) {
    return realFetch(DEV_BASE + url, opts);
  }
  return realFetch(url, opts);
};

const { matchBusinessType } = await import('../v3/generation/new/matcher.js');
const { assignEnergyRows } = await import('../v3/generation/new/row-energy-assignment.js');

// Varied batch — each case probes a different concern. Comments mark expected behavior.
const tests = [
  // === Pass 1 false-positive resistance (should refuse Pass 1, fall through) ===
  'פתחתי חנות נעליים יוקרתית',                            // shoe store ≠ clothing store
  'אני פותח גלידריה משפחתית',                              // ice cream ≠ bakery / café
  'אני פותח מסעדת בשרים בסגנון אמריקאי',                  // steakhouse — Pass 1 should resist matching to chef-restaurant
  // === Pass 2 quality (atmosphere is the only signal) ===
  'מקום צבעוני וכיפי לילדים עם פעילויות',                 // vibe: שמח, צעיר, משפחתי
  'סטודיו ליוגה ומיינדפולנס',                              // vibe: רגוע, מינימליסטי
  'פותחת מקום שכל הצעירים מבלים בו ביום שישי בערב',      // vibe-heavy, no type stated
  // === No-match honesty (should refuse both passes) ===
  'פותחת חברת סטארטאפ לטכנולוגיה',                       // not a brick-and-mortar venue
  'אני פותח מפעל לייצור פלסטיק',                          // industrial
  // === Robustness / weird input ===
  'בר',                                                    // single word, very vague
  "I'm opening a wine bar in downtown Tel Aviv",            // English-only
  '',                                                       // empty — should short-circuit without calling GPT
];
for (const t of tests) {
  const tStart = Date.now();
  const res = await matchBusinessType(t, rows);
  const ms = Date.now() - tStart;
  const tag = res.matched
    ? (res.fallback ? `MATCH via ${res.fallback}` : 'MATCH')
    : 'NO MATCH';
  console.log(`"${t}"  (${ms}ms)`);
  if (res.matched) {
    console.log(`  → ${tag}: "${res.bizType}"  rows=${res.rows.length}  reasoning: ${res.reasoning}`);
    const energy = assignEnergyRows(res.rows);
    const calm = `row ${energy.calm.row}(energy="${energy.calm.energy || '-'}",pls=${energy.calm.playlists.length})`;
    const enr  = `row ${energy.energetic.row}(energy="${energy.energetic.energy || '-'}",pls=${energy.energetic.playlists.length})`;
    console.log(`     energy[sameRow=${energy.isCalmAndEnergeticFromSameRow}]  calm=${calm}  energetic=${enr}`);
  } else {
    console.log(`  → ${tag}  reasoning: ${res.reasoning}`);
  }
}
