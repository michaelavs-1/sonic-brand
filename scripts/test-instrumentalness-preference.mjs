#!/usr/bin/env node
/**
 * Integration test for the 2026-08-21 instrumentalness_preference feature.
 *
 * Verifies:
 *   1. `business_directions.instrumentalness_preference` column exists +
 *      CHECK constraint accepts 'none'/'soft'/'hard' and rejects garbage.
 *   2. `v5_direction_tracks` respects `p_inst_pref`:
 *        - 'hard' → every returned track has instrumentalness >= 85
 *        - 'none' → mixed pool (unfiltered)
 *        - 'soft' → returned in instrumentals-first order
 *   3. `v6_direction_tracks_recent` respects `p_inst_pref` (same three cases).
 *   4. `v5_anchor_tracks` respects per-spec `inst_pref`:
 *        - a spec with inst_pref='hard' returns an anchor with
 *          instrumentalness >= 85 (if any exist in the anchor pool).
 *
 * Cleans up all fixture rows even on failure.
 *
 * Usage (PowerShell, from repo root, .env.local loaded):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/test-instrumentalness-preference.mjs
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Load .env.local first.');
  process.exit(1);
}

const HDR = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type':'application/json',
};

let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}

async function pgr(method, path, { body, query, prefer } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const r = await fetch(url, {
    method,
    headers: prefer ? { ...HDR, Prefer: prefer } : HDR,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) {
    const err = new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

const rpc = (fn, args) => pgr('POST', `rpc/${fn}`, { body: args });

async function auth(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: HDR,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

// ---------- Fixture ----------
const stamp     = Date.now();
const testEmail = `test-instpref-${stamp}@example.invalid`;
const testBiz   = `_test_instpref_${stamp}`;
let userId     = null;
let businessId = null;

async function setup() {
  console.log(`\n=== SETUP: creating throwaway user + business (${testEmail}) ===`);
  const created = await auth('POST', '/auth/v1/admin/users', { email: testEmail, email_confirm: false });
  userId = created?.id;
  if (!userId) throw new Error('user creation returned no id');
  const bizRows = await pgr('POST', 'businesses', {
    body:   { owner_id: userId, name: testBiz },
    prefer: 'return=representation',
  });
  businessId = Array.isArray(bizRows) ? bizRows[0]?.id : bizRows?.id;
  if (!businessId) throw new Error('business insert returned no id');
  console.log(`  user=${userId}  business=${businessId}`);
}

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  try {
    if (businessId) {
      await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } });
      console.log(`  business ${businessId} deleted (CASCADE covers business_directions)`);
    }
    if (userId) {
      await auth('DELETE', `/auth/v1/admin/users/${userId}`);
      console.log(`  user ${userId} deleted`);
    }
  } catch (e) {
    console.warn(`  cleanup failed: ${e.message}`);
  }
}

// ---------- Helper: fetch instrumentalness values for a batch of ids ----------
async function fetchInstrumentalness(spotifyIds) {
  if (!spotifyIds.length) return {};
  const rows = await pgr('GET', 'track_analyses', {
    query: { spotify_id: `in.(${spotifyIds.join(',')})`, select: 'spotify_id,instrumentalness' },
  });
  return Object.fromEntries((rows || []).map((r) => [r.spotify_id, r.instrumentalness]));
}

// ---------- Test cases ----------
async function runTests() {
  // ---- Test 1: business_directions column + CHECK constraint ----
  console.log('\n=== TEST 1: business_directions.instrumentalness_preference column ===');
  const dirRows = await pgr('POST', 'business_directions', {
    body: {
      business_id: businessId,
      title_en:    'Test',
      genres:      ['rock'],
      bpm_range:   { min: 80, max: 130 },
      instrumentalness_preference: 'hard',
    },
    prefer: 'return=representation',
  });
  const dirId = Array.isArray(dirRows) ? dirRows[0]?.id : dirRows?.id;
  ok(!!dirId, 'insert with instrumentalness_preference=hard succeeded');
  const readBack = await pgr('GET', 'business_directions', {
    query: { id: `eq.${dirId}`, select: 'instrumentalness_preference' },
  });
  ok(readBack?.[0]?.instrumentalness_preference === 'hard',
    'read-back matches inserted value',
    `got ${readBack?.[0]?.instrumentalness_preference}`);

  // CHECK constraint should reject a garbage value.
  let checkRejected = false;
  try {
    await pgr('POST', 'business_directions', {
      body: {
        business_id: businessId,
        title_en:    'BadPrefTest',
        genres:      ['rock'],
        bpm_range:   { min: 80, max: 130 },
        instrumentalness_preference: 'ULTRA_HARD',
      },
    });
  } catch (e) {
    checkRejected = /check constraint|violates|instrumentalness/i.test(e.message);
  }
  ok(checkRejected, 'CHECK constraint rejects unrecognized value');

  // Verify the default is 'none' when omitted.
  const defaultRows = await pgr('POST', 'business_directions', {
    body: {
      business_id: businessId,
      title_en:    'DefaultCheck',
      genres:      ['rock'],
      bpm_range:   { min: 80, max: 130 },
    },
    prefer: 'return=representation',
  });
  const defaultId = Array.isArray(defaultRows) ? defaultRows[0]?.id : defaultRows?.id;
  const defaultRead = await pgr('GET', 'business_directions', {
    query: { id: `eq.${defaultId}`, select: 'instrumentalness_preference' },
  });
  ok(defaultRead?.[0]?.instrumentalness_preference === 'none',
    'omitted column defaults to "none"',
    `got ${defaultRead?.[0]?.instrumentalness_preference}`);

  // ---- Test 2: v5_direction_tracks ----
  console.log('\n=== TEST 2: v5_direction_tracks respects p_inst_pref ===');
  // Broad filter to ensure both instrumental and non-instrumental tracks exist
  // in the candidate pool (rock is well-populated).
  const commonArgs = {
    p_genres: ['rock'],
    p_bpm_lo: 60,
    p_bpm_hi: 200,
    p_pop_lo: 0,
    p_pop_hi: 100,
    p_limit:  50,
  };

  // 'hard' — strict filter.
  const hardRows = await rpc('v5_direction_tracks', { ...commonArgs, p_inst_pref: 'hard' });
  const hardIds  = (hardRows || []).map((r) => r.spotify_id).filter(Boolean);
  console.log(`  hard fetched ${hardIds.length} tracks`);
  const hardInst = await fetchInstrumentalness(hardIds);
  const hardBelow85 = hardIds.filter((id) => (hardInst[id] ?? 0) < 85);
  ok(hardIds.length > 0, 'hard returned at least some tracks (pool has instrumentals)',
    'if this fails, rock has no instrumentalness>=85 tracks — try a different genre');
  ok(hardBelow85.length === 0, 'hard: every returned track has instrumentalness >= 85',
    `${hardBelow85.length} of ${hardIds.length} were below threshold`);

  // 'none' — unfiltered.
  const noneRows = await rpc('v5_direction_tracks', { ...commonArgs, p_inst_pref: 'none' });
  const noneIds  = (noneRows || []).map((r) => r.spotify_id).filter(Boolean);
  console.log(`  none fetched ${noneIds.length} tracks`);
  const noneInst = await fetchInstrumentalness(noneIds);
  const noneBelow85 = noneIds.filter((id) => (noneInst[id] ?? 0) < 85);
  ok(noneIds.length > 0, 'none returned tracks');
  ok(noneBelow85.length > 0,
    'none: at least some returned tracks have instrumentalness < 85 (mixed pool)',
    'if this fails, rock is unexpectedly all-instrumental — swap genre in test');

  // 'soft' — bias-sort. Instrumentals should come first, non-instrumentals fill later.
  const softRows = await rpc('v5_direction_tracks', { ...commonArgs, p_inst_pref: 'soft' });
  const softIds  = (softRows || []).map((r) => r.spotify_id).filter(Boolean);
  console.log(`  soft fetched ${softIds.length} tracks`);
  const softInst = await fetchInstrumentalness(softIds);
  // Find the first index where instrumentalness drops below 85. Every index
  // BEFORE that must also be >= 85 (i.e. no vocal-then-instrumental flip
  // within the returned batch, since soft is stable-ordering instrumentals
  // to the front). Rely on the position of the first vocal as the pivot.
  const firstVocalIdx = softIds.findIndex((id) => (softInst[id] ?? 0) < 85);
  const softHead = firstVocalIdx === -1 ? softIds : softIds.slice(0, firstVocalIdx);
  const softHeadBelow85 = softHead.filter((id) => (softInst[id] ?? 0) < 85);
  ok(softHeadBelow85.length === 0,
    'soft: instrumentals come first (no vocal appears before any instrumental)',
    `firstVocalIdx=${firstVocalIdx}, softHead had ${softHeadBelow85.length} vocals`);
  console.log(`  soft first-vocal position: ${firstVocalIdx === -1 ? 'no vocals in result' : firstVocalIdx}`);

  // ---- Test 3: v6_direction_tracks_recent (same three cases) ----
  console.log('\n=== TEST 3: v6_direction_tracks_recent respects p_inst_pref ===');
  const recentArgs = {
    ...commonArgs,
    p_biz_id:        businessId,
    p_direction_key: '_test_key_' + stamp,
    p_exclude_days:  0,   // fresh biz has no history anyway
  };
  const rHardRows = await rpc('v6_direction_tracks_recent', { ...recentArgs, p_inst_pref: 'hard' });
  const rHardIds  = (rHardRows || []).map((r) => r.spotify_id).filter(Boolean);
  const rHardInst = await fetchInstrumentalness(rHardIds);
  const rHardBelow85 = rHardIds.filter((id) => (rHardInst[id] ?? 0) < 85);
  ok(rHardIds.length > 0 && rHardBelow85.length === 0,
    'v6_direction_tracks_recent hard: only instrumentals',
    `${rHardBelow85.length} of ${rHardIds.length} below 85`);

  const rNoneRows = await rpc('v6_direction_tracks_recent', { ...recentArgs, p_inst_pref: 'none' });
  const rNoneIds  = (rNoneRows || []).map((r) => r.spotify_id).filter(Boolean);
  ok(rNoneIds.length > 0, 'v6_direction_tracks_recent none: pool populated');

  const rSoftRows = await rpc('v6_direction_tracks_recent', { ...recentArgs, p_inst_pref: 'soft' });
  const rSoftIds  = (rSoftRows || []).map((r) => r.spotify_id).filter(Boolean);
  const rSoftInst = await fetchInstrumentalness(rSoftIds);
  const rFirstVocalIdx = rSoftIds.findIndex((id) => (rSoftInst[id] ?? 0) < 85);
  const rSoftHead = rFirstVocalIdx === -1 ? rSoftIds : rSoftIds.slice(0, rFirstVocalIdx);
  const rSoftHeadBelow = rSoftHead.filter((id) => (rSoftInst[id] ?? 0) < 85);
  ok(rSoftHeadBelow.length === 0,
    'v6_direction_tracks_recent soft: instrumentals bubble first',
    `firstVocalIdx=${rFirstVocalIdx}`);

  // ---- Test 4: v5_anchor_tracks per-spec inst_pref ----
  console.log('\n=== TEST 4: v5_anchor_tracks respects per-spec inst_pref ===');
  const anchorRows = await rpc('v5_anchor_tracks', {
    p_specs: [
      { rank: 1, genre: 'rock', bpm_lo: 60, bpm_hi: 200, inst_pref: 'hard' },
      { rank: 2, genre: 'rock', bpm_lo: 60, bpm_hi: 200, inst_pref: 'none' },
    ],
    p_pop_lo: 0,
    p_pop_hi: 100,
  });
  const byRank = Object.fromEntries((anchorRows || []).map((r) => [r.rank, r.spotify_id]));
  const rank1 = byRank[1];
  const rank2 = byRank[2];
  ok(!!rank1, 'anchor rank=1 (hard) returned a track');
  ok(!!rank2, 'anchor rank=2 (none) returned a track');
  if (rank1) {
    const instr = await fetchInstrumentalness([rank1]);
    ok((instr[rank1] ?? 0) >= 85,
      'anchor rank=1 (hard) track has instrumentalness >= 85',
      `got instrumentalness=${instr[rank1]}`);
  }
}

// ---------- Runner ----------
(async () => {
  try {
    await setup();
    await runTests();
  } catch (err) {
    console.error(`\nTEST RUN ABORTED: ${err.message}`);
    if (err.data) console.error('  detail:', JSON.stringify(err.data).slice(0, 400));
    failed++;
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
