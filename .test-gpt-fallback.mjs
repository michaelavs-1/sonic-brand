// End-to-end test for the GPT fallback flow.
//
// Requires:
//   - vercel dev running on localhost:3000 (serves /api/new/*)
//   - OPENAI_API_KEY (or Supabase app_settings row), SPOTIFY_CLIENT_ID/SECRET,
//     RUBIN_REFRESH_TOKEN + RUBIN_SPOTIFY_CLIENT_ID/SECRET, TRACK_ANALYSIS_RAPIDAPI_KEY
//     in .env.local
//
// Modes:
//   --unit   : only the shouldFallback unit cases (no API calls, free)
//   --smoke  : unit + ONE cheap not_public_facing live case (one OpenAI call, ~$0.001,
//              no RapidAPI quota, no playlists). Run this first to shake out dumb
//              infrastructure issues before burning real quota.
//   (no flag): unit + all 5 live cases including 2 matched cases that burn ~240 RapidAPI
//              requests and create 4 Spotify playlists on Rubin's account.

const DEV_BASE  = process.env.DEV_BASE || 'http://localhost:3000';
const UNIT_ONLY = process.argv.includes('--unit');
const SMOKE     = process.argv.includes('--smoke');

// fetch shim: rewrite relative /api/new/* to localhost vercel dev
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('/api/new/')) return realFetch(DEV_BASE + url, opts);
  return realFetch(url, opts);
};

const { generateFromGPT, shouldFallback } = await import('./v3/generation/new/gpt-fallback.js');

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  PASS  ${label}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); };

// ---------- shouldFallback unit cases ----------
console.log('\n=== shouldFallback ===');

const unitCases = [
  { name: 'matched:false → true',
    input: { matched: false, reasoning: 'no match' },
    expected: true },
  { name: 'matched:true with playable row → false',
    input: { matched: true, rows: [{ playlists: [{ id: 'x' }] }] },
    expected: false },
  { name: 'matched:true with all empty rows → true',
    input: { matched: true, rows: [{ playlists: [] }, { playlists: [] }] },
    expected: true },
  { name: 'matched:true with mixed rows (one playable) → false',
    input: { matched: true, rows: [{ playlists: [] }, { playlists: [{ id: 'x' }] }] },
    expected: false },
  { name: 'matched:true with empty rows array → true',
    input: { matched: true, rows: [] },
    expected: true },
  { name: 'matched:true with rows undefined → true',
    input: { matched: true },
    expected: true },
];

for (const c of unitCases) {
  const got = shouldFallback(c.input);
  if (got === c.expected) ok(c.name);
  else                    bad(c.name, `expected=${c.expected} got=${got}`);
}

if (UNIT_ONLY) {
  console.log(`\n=== ${pass} pass, ${fail} fail (unit only) ===`);
  process.exit(fail ? 1 : 0);
}

// ---------- live end-to-end cases ----------
console.log('\n=== fetching databox rows for mix guideline ===');
const dboxRes = await realFetch(`${DEV_BASE}/api/new/databox`);
if (!dboxRes.ok) {
  console.error(`databox fetch failed: ${dboxRes.status} ${dboxRes.statusText}`);
  process.exit(1);
}
const { rows } = await dboxRes.json();
console.log(`got ${rows.length} rows`);

const allLiveCases = [
  { input: 'חברת סטארטאפ לטכנולוגיה',      expect: 'not_public_facing', note: 'startup — smoke-test case, cheapest' },
  { input: 'מפעל לייצור פלסטיק',            expect: 'not_public_facing', note: 'industrial' },
  { input: 'סטודיו ליוגה ומיינדפולנס',      expect: 'not_public_facing', note: 'yoga — matches matcher policy' },
  { input: 'חנות אופניים שכונתית',          expect: 'matched',           note: 'bike shop — public, likely not in Data Box' },
  { input: 'מספרה לחיות מחמד',             expect: 'matched',           note: 'pet grooming — unusual specialty' },
];

// In smoke mode, only the first (cheapest) case runs.
const liveCases = SMOKE ? allLiveCases.slice(0, 1) : allLiveCases;

console.log(`\n=== generateFromGPT (live${SMOKE ? ' — smoke mode, 1 case only' : ''}) ===`);
for (const c of liveCases) {
  const t0  = Date.now();
  const res = await generateFromGPT(c.input, rows);
  const ms  = Date.now() - t0;

  const success =
    (c.expect === 'matched'           && res.matched === true) ||
    (c.expect === 'not_public_facing' && res.reason  === 'not_public_facing');

  if (success) ok(`"${c.input}"  (${ms}ms, ${c.note})`);
  else         bad(`"${c.input}"  (${ms}ms, ${c.note})`,
                   `expect=${c.expect} matched=${res.matched} reason=${res.reason || '-'}`);

  if (res.matched) {
    console.log(`        atmosphere : "${res.atmosphere}"`);
    console.log(`        calm       : ${res.calm      ? `${res.calm.url} (${res.calm.trackCount} tracks)`           : '(none — no calm tracks resolved)'}`);
    console.log(`        energetic  : ${res.energetic ? `${res.energetic.url} (${res.energetic.trackCount} tracks)` : '(none — no energetic tracks resolved)'}`);
    console.log(`        stats      : ${JSON.stringify(res.stats)}`);
  } else {
    console.log(`        reason     : ${res.reason}`);
    if (res.reasoning) console.log(`        reasoning  : ${res.reasoning}`);
    if (res.error)     console.log(`        error      : ${res.error}`);
    if (res.stats)     console.log(`        stats      : ${JSON.stringify(res.stats)}`);
  }
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
