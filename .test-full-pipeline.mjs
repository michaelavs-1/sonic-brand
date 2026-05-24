// Full pipeline end-to-end test:
//   user input → matcher → energy assignment → playlist builder (on Rubin's account)
//
// Requires:
//   - vercel dev running on localhost:3000
//   - SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET (Michael's app, in Vercel env)
//   - RUBIN_SPOTIFY_CLIENT_ID + RUBIN_SPOTIFY_CLIENT_SECRET (Rubin's app, in Vercel env)
//   - RUBIN_REFRESH_TOKEN (Rubin user, in Vercel env, scope=playlist-modify-private)
//   - OPENAI_API_KEY for the matcher
//
// Run: node .test-full-pipeline.mjs
//
// Note: this creates real playlists on Rubin's Spotify account. They're private + collaborative.
// Clean them up manually for now (auto-delete-after-N-hours is a future feature).

const DEV_BASE = 'http://localhost:3000';

// fetch shim: rewrite relative /api/new/* calls to vercel dev
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('/api/new/')) {
    return realFetch(DEV_BASE + url, opts);
  }
  return realFetch(url, opts);
};

console.log(`fetching rows from ${DEV_BASE}/api/new/databox …`);
const dbox = await realFetch(`${DEV_BASE}/api/new/databox`);
if (!dbox.ok) { console.error(`databox fetch failed: ${dbox.status}`); process.exit(1); }
const { rows } = await dbox.json();
console.log(`got ${rows.length} rows\n`);

const { matchBusinessType } = await import('./v3/generation/new/matcher.js');
const { assignEnergyRows  } = await import('./v3/generation/new/row-energy-assignment.js');
const { buildPlaylists    } = await import('./v3/generation/new/playlist-builder.js');

const tests = [
  { input: 'אני פותח בר יין במרכז העיר',                     bizName: null,          note: 'direct match, 2-row biz (should create)' },
  { input: 'אני פותח חנות שמוכרת גרביים צבעוניים וכיפיים',    bizName: null,          note: 'atmosphere fallback (should create if matched type has playlists)' },
  { input: 'פתחתי חומוסיה',                                    bizName: null,          note: '1-row biz (should skip — energy splitting pending)' },
  { input: 'אני בונה רקטה לחלל',                              bizName: null,          note: 'no match (matcher should refuse)' },
  { input: 'אני פותח בית קפה שכונתי',                        bizName: 'Café del Mar', note: 'with custom bizName override' },
];

let pass = 0, skip = 0, noMatch = 0, fail = 0;

for (const t of tests) {
  console.log(`=== ${t.note} ===`);
  console.log(`input:    "${t.input}"${t.bizName ? `  bizName="${t.bizName}"` : ''}`);

  // Stage 1: matcher
  const t0 = Date.now();
  let m;
  try {
    m = await matchBusinessType(t.input, rows);
  } catch (err) {
    console.log(`  matcher ERROR (${Date.now() - t0}ms): ${err.message}\n`);
    fail++;
    continue;
  }
  const mMs = Date.now() - t0;

  if (!m.matched) {
    console.log(`  matcher (${mMs}ms): NO MATCH  reasoning: ${m.reasoning}\n`);
    noMatch++;
    continue;
  }
  console.log(`  matcher (${mMs}ms): "${m.bizType}"${m.fallback ? ` (via ${m.fallback})` : ''}  reasoning: ${m.reasoning}`);

  // Stage 2: energy assignment (instant)
  const energy = assignEnergyRows(m.rows);
  const calmStr = `row ${energy.calm.row}(energy="${energy.calm.energy || '-'}",pls=${energy.calm.playlists.length})`;
  const enrStr  = `row ${energy.energetic.row}(energy="${energy.energetic.energy || '-'}",pls=${energy.energetic.playlists.length})`;
  console.log(`  energy:   sameRow=${energy.isCalmAndEnergeticFromSameRow}  calm=${calmStr}  energetic=${enrStr}`);

  // Stage 3: playlist builder
  const t1 = Date.now();
  let p;
  try {
    p = await buildPlaylists(energy, m.bizType, t.bizName);
  } catch (err) {
    console.log(`  builder ERROR (${Date.now() - t1}ms): ${err.message}\n`);
    fail++;
    continue;
  }
  const bMs = Date.now() - t1;

  if (p.skipped) {
    console.log(`  builder (${bMs}ms): SKIPPED  reason: ${p.reason}\n`);
    skip++;
    continue;
  }
  console.log(`  builder (${bMs}ms): SUCCESS`);
  console.log(`    calm:      ${p.calm.url}  (${p.calm.trackCount} tracks)`);
  console.log(`    energetic: ${p.energetic.url}  (${p.energetic.trackCount} tracks)\n`);
  pass++;
}

console.log(`=== ${pass} created, ${skip} skipped, ${noMatch} no-match, ${fail} failed ===`);
