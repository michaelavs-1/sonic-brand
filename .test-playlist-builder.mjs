// Exercise buildPlaylists() against three known 2-row business types.
// Bypasses matcher + assignEnergyRows — builds the assignment object directly
// from real rows fetched from /api/new/databox.
//
// Requires:
//   - vercel dev running on localhost:3000
//   - SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env.local
//   - Michael's refresh token already in the spotify_tokens Supabase table
//
// Run:  node .test-playlist-builder.mjs

const DEV_BASE = 'http://localhost:3000';

// fetch shim:
//   1. rewrite relative /api/new/* calls to localhost vercel dev
//   2. inject the test access_token into /api/new/spotify bodies so the proxy can
//      bypass Supabase entirely (only matters for create_playlist + add_tracks).
const realFetch = globalThis.fetch;
const TEST_TOKEN = process.argv[2] || null;
if (TEST_TOKEN) {
  console.log('test: CLI access_token provided — using override path (bypassing RUBIN_REFRESH_TOKEN).');
} else {
  console.log('test: no CLI access_token — using proxy default (RUBIN_REFRESH_TOKEN flow).');
}

globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('/api/new/spotify')) {
    let nextOpts = opts;
    if (TEST_TOKEN) {
      try {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.action === 'create_playlist' || body.action === 'add_tracks') {
          body._user_access_token = TEST_TOKEN;
          nextOpts = { ...opts, body: JSON.stringify(body) };
        }
      } catch {}
    }
    return realFetch(DEV_BASE + url, nextOpts);
  }
  if (typeof url === 'string' && url.startsWith('/api/new/')) {
    return realFetch(DEV_BASE + url, opts);
  }
  return realFetch(url, opts);
};

const TESTS = [
  'בר יין',
  'דאנס בר',
  'בית קפה שכונתי',
];

console.log(`fetching live rows from ${DEV_BASE}/api/new/databox …`);
const dbox = await realFetch(`${DEV_BASE}/api/new/databox`);
if (!dbox.ok) {
  console.error(`databox fetch failed: ${dbox.status} ${dbox.statusText}`);
  process.exit(1);
}
const { rows } = await dbox.json();
console.log(`got ${rows.length} rows`);

const { buildPlaylists } = await import('./v3/generation/new/playlist-builder.js');

let pass = 0, fail = 0;

for (const bizType of TESTS) {
  console.log(`\n=== ${bizType} ===`);

  const groupRows = rows.filter(r => r.bizType === bizType);
  const calm      = groupRows.find(r => r.energy === '1');
  const energetic = groupRows.find(r => r.energy === '2');

  if (!calm || !energetic) {
    console.log(`  SKIP: missing calm (${!!calm}) or energetic (${!!energetic}) row for "${bizType}"`);
    fail++;
    continue;
  }

  console.log(`  assignment: calm=row ${calm.row} (${calm.playlists.length} pls)  energetic=row ${energetic.row} (${energetic.playlists.length} pls)`);

  const assignment = { calm, energetic, isCalmAndEnergeticFromSameRow: false };

  const t0 = Date.now();
  try {
    const result = await buildPlaylists(assignment, bizType);
    const ms = Date.now() - t0;

    if (result.skipped) {
      console.log(`  → SKIPPED (${ms}ms): ${result.reason}`);
      fail++;
      continue;
    }

    console.log(`  → SUCCESS (${ms}ms)`);
    console.log(`     calm:      ${result.calm.url}`);
    console.log(`       id=${result.calm.id}  trackCount=${result.calm.trackCount}`);
    console.log(`     energetic: ${result.energetic.url}`);
    console.log(`       id=${result.energetic.id}  trackCount=${result.energetic.trackCount}`);
    pass++;
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`  → ERROR (${ms}ms): ${err.message}`);
    fail++;
  }
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
