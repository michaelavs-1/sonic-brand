// Single end-to-end test for the new generation pipeline (v3/generation/new).
//
// Reads bizName + description from .test-new-pipeline.json, then walks every stage:
//   1) /api/new/databox            — pull live rows
//   2) matcher.matchBusinessType   — GPT Pass 1 / Pass 2
//   3) shouldFallback?             — decide between Data Box path and GPT fallback
//   4a) Data Box path:
//         row-energy-assignment.assignEnergyRows
//         playlist-builder.buildPlaylists  (creates 2 Spotify playlists on Rubin's account)
//   4b) GPT fallback path:
//         gpt-fallback.generateFromGPT     (creates 0/1/2 Spotify playlists on Rubin's account)
//
// Edit .test-new-pipeline.json to change inputs, then run:
//   vercel dev                        (in one terminal — serves /api/new/*)
//   node .test-new-pipeline.mjs       (in another)
//
// Note: a successful run creates real playlists on Rubin's Spotify account.

import { readFileSync } from 'node:fs';

const DEV_BASE  = process.env.DEV_BASE || 'http://localhost:3000';
const CFG_PATH  = new URL('./.test-new-pipeline.json', import.meta.url);

// fetch shim so the pipeline's relative /api/new/* calls reach vercel dev from Node.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('/api/new/')) {
    return realFetch(DEV_BASE + url, opts);
  }
  return realFetch(url, opts);
};

const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const description = typeof cfg.description === 'string' ? cfg.description.trim() : '';
const bizName     = typeof cfg.bizName     === 'string' && cfg.bizName.trim() ? cfg.bizName.trim() : null;

if (!description) {
  console.error('.test-new-pipeline.json: "description" is required (non-empty string)');
  process.exit(1);
}

console.log('=== input ===');
console.log(`bizName:     ${bizName ?? '(none)'}`);
console.log(`description: "${description}"`);

console.log(`\n=== /api/new/databox ===`);
const dboxRes = await realFetch(`${DEV_BASE}/api/new/databox`);
if (!dboxRes.ok) {
  console.error(`databox fetch failed: ${dboxRes.status} ${dboxRes.statusText}`);
  process.exit(1);
}
const { rows } = await dboxRes.json();
console.log(`got ${rows.length} rows`);

const { matchBusinessType }                            = await import('../v3/generation/new/matcher.js');
const { assignEnergyRows  }                            = await import('../v3/generation/new/row-energy-assignment.js');
const { buildPlaylists    }                            = await import('../v3/generation/new/playlist-builder.js');
const { generateFromGPT, shouldFallback }              = await import('../v3/generation/new/gpt-fallback.js');

console.log(`\n=== stage 1: matcher ===`);
const tMatch0 = Date.now();
let match;
try {
  match = await matchBusinessType(description, rows);
} catch (err) {
  console.error(`matcher ERROR (${Date.now() - tMatch0}ms): ${err.message}`);
  process.exit(1);
}
const tMatch = Date.now() - tMatch0;

if (match.matched) {
  console.log(`(${tMatch}ms) DATA BOX MATCH: SUCCESS`);
  console.log(`        business type selected: "${match.bizType}"${match.fallback ? ` (via ${match.fallback})` : ''}`);
  console.log(`        rows=${match.rows.length}`);
  console.log(`        reasoning: ${match.reasoning}`);
} else {
  console.log(`(${tMatch}ms) DATA BOX MATCH: NONE — GPT fallback will be initiated`);
  console.log(`        reasoning: ${match.reasoning}`);
}

const needsFallback = shouldFallback(match);
if (needsFallback) {
  if (match.matched) {
    console.log(`\n>>> matched business type "${match.bizType}" has no usable playlists — GPT fallback has been initiated`);
  } else {
    console.log(`\n>>> no data box match — GPT fallback has been initiated`);
  }
} else {
  console.log(`\n>>> proceeding via Data Box path with business type "${match.bizType}"`);
}

if (!needsFallback) {
  // ---------- Data Box path ----------
  console.log(`\n=== stage 2: assignEnergyRows ===`);
  const energy = assignEnergyRows(match.rows);
  const fmtRow = (r) =>
    `row ${r.row}(energy="${r.energy || '-'}", playlists=${Array.isArray(r.playlists) ? r.playlists.length : 0})`;
  console.log(`sameRow:    ${energy.isCalmAndEnergeticFromSameRow}`);
  console.log(`calm:       ${fmtRow(energy.calm)}`);
  console.log(`energetic:  ${fmtRow(energy.energetic)}`);

  console.log(`\n=== stage 3: buildPlaylists ===`);
  const tBuild0 = Date.now();
  let pl;
  try {
    pl = await buildPlaylists(energy, match.bizType, bizName);
  } catch (err) {
    console.error(`buildPlaylists ERROR (${Date.now() - tBuild0}ms): ${err.message}`);
    process.exit(1);
  }
  const tBuild = Date.now() - tBuild0;

  if (pl.skipped) {
    console.log(`(${tBuild}ms) SKIPPED: ${pl.reason}`);
    process.exit(0);
  }
  console.log(`(${tBuild}ms) SUCCESS`);
  console.log(`  calm:      ${pl.calm.url}  (${pl.calm.trackCount} tracks)  id=${pl.calm.id}`);
  console.log(`  energetic: ${pl.energetic.url}  (${pl.energetic.trackCount} tracks)  id=${pl.energetic.id}`);
  process.exit(0);
}

// ---------- GPT fallback path ----------
console.log(`\n=== stage 2+3: generateFromGPT (fallback) ===`);
const tGpt0 = Date.now();
let fb;
try {
  fb = await generateFromGPT(description, rows, bizName);
} catch (err) {
  console.error(`generateFromGPT ERROR (${Date.now() - tGpt0}ms): ${err.message}`);
  process.exit(1);
}
const tGpt = Date.now() - tGpt0;

if (!fb.matched) {
  console.log(`(${tGpt}ms) NO MATCH via fallback`);
  console.log(`  reason:    ${fb.reason}`);
  if (fb.reasoning) console.log(`  reasoning: ${fb.reasoning}`);
  if (fb.error)     console.log(`  error:     ${fb.error}`);
  if (fb.stats)     console.log(`  stats:     ${JSON.stringify(fb.stats)}`);
  process.exit(0);
}

console.log(`(${tGpt}ms) SUCCESS via fallback`);
console.log(`  atmosphere: "${fb.atmosphere}"`);
if (fb.reasoning) console.log(`  reasoning:  ${fb.reasoning}`);
console.log(`  calm:       ${fb.calm      ? `${fb.calm.url}  (${fb.calm.trackCount} tracks)  id=${fb.calm.id}`                : '(none — no calm tracks resolved)'}`);
console.log(`  energetic:  ${fb.energetic ? `${fb.energetic.url}  (${fb.energetic.trackCount} tracks)  id=${fb.energetic.id}` : '(none — no energetic tracks resolved)'}`);
console.log(`  stats:      ${JSON.stringify(fb.stats)}`);
