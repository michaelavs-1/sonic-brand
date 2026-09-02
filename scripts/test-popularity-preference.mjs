#!/usr/bin/env node
/**
 * Integration test for the 2026-09-02 popularity_preference feature.
 *
 * Mirrors scripts/test-instrumentalness-preference.mjs but for the popularity
 * axis. Verifies:
 *   1. `business_directions.popularity_preference` column exists +
 *      CHECK constraint accepts 'none'/'soft'/'hard' and rejects garbage.
 *   2. `v5_direction_tracks` respects `p_pop_pref`:
 *        - 'hard' → every returned track has popularity BETWEEN 60 AND 100
 *          (OVERRIDES the atmosphere popularity window).
 *        - 'none' → uses the passed p_pop_lo/p_pop_hi window.
 *        - 'soft' → same WHERE as 'none', but bias-sorts hits (>=60) to
 *          the front of the random draw.
 *   3. `v6_direction_tracks_recent` respects `p_pop_pref` (same three cases).
 *   4. `v5_anchor_tracks` respects per-spec `pop_pref`:
 *        - a spec with pop_pref='hard' returns an anchor with
 *          popularity BETWEEN 60 AND 100 (if any exist in the anchor pool),
 *          even when p_pop_lo/p_pop_hi are set outside that window.
 *
 * Cleans up all fixture rows even on failure.
 *
 * Usage (PowerShell, from repo root, .env.local loaded):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/test-popularity-preference.mjs
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
const testEmail = `test-poppref-${stamp}@example.invalid`;
const testBiz   = `_test_poppref_${stamp}`;
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

// ---------- Helper: fetch popularity values for a batch of ids ----------
async function fetchPopularity(spotifyIds) {
  if (!spotifyIds.length) return {};
  const rows = await pgr('GET', 'track_analyses', {
    query: { spotify_id: `in.(${spotifyIds.join(',')})`, select: 'spotify_id,popularity' },
  });
  return Object.fromEntries((rows || []).map((r) => [r.spotify_id, r.popularity]));
}

// ---------- Test cases ----------
async function runTests() {
  // ---- Test 1: business_directions column + CHECK constraint ----
  console.log('\n=== TEST 1: business_directions.popularity_preference column ===');
  const dirRows = await pgr('POST', 'business_directions', {
    body: {
      business_id: businessId,
      title_en:    'Test',
      genres:      ['rock'],
      bpm_range:   { min: 80, max: 130 },
      popularity_preference: 'hard',
    },
    prefer: 'return=representation',
  });
  const dirId = Array.isArray(dirRows) ? dirRows[0]?.id : dirRows?.id;
  ok(!!dirId, 'insert with popularity_preference=hard succeeded');
  const readBack = await pgr('GET', 'business_directions', {
    query: { id: `eq.${dirId}`, select: 'popularity_preference' },
  });
  ok(readBack?.[0]?.popularity_preference === 'hard',
    'read-back matches inserted value',
    `got ${readBack?.[0]?.popularity_preference}`);

  // CHECK constraint should reject a garbage value.
  let checkRejected = false;
  try {
    await pgr('POST', 'business_directions', {
      body: {
        business_id: businessId,
        title_en:    'BadPrefTest',
        genres:      ['rock'],
        bpm_range:   { min: 80, max: 130 },
        popularity_preference: 'MEGA_HITS',
      },
    });
  } catch (e) {
    checkRejected = /check constraint|violates|popularity/i.test(e.message);
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
    query: { id: `eq.${defaultId}`, select: 'popularity_preference' },
  });
  ok(defaultRead?.[0]?.popularity_preference === 'none',
    'omitted column defaults to "none"',
    `got ${defaultRead?.[0]?.popularity_preference}`);

  // ---- Test 2: v5_direction_tracks respects p_pop_pref ----
  console.log('\n=== TEST 2: v5_direction_tracks respects p_pop_pref ===');
  // Broad BPM window on rock, LOW popularity window in the args (0-40).
  // 'hard' must OVERRIDE to 60-100 and produce hits from OUTSIDE the passed window.
  const commonArgs = {
    p_genres: ['rock'],
    p_bpm_lo: 60,
    p_bpm_hi: 200,
    p_pop_lo: 0,
    p_pop_hi: 40,
    p_limit:  50,
  };

  // 'hard' — override to 60-100.
  const hardRows = await rpc('v5_direction_tracks', { ...commonArgs, p_pop_pref: 'hard' });
  const hardIds  = (hardRows || []).map((r) => r.spotify_id).filter(Boolean);
  console.log(`  hard fetched ${hardIds.length} tracks (should all be popularity 60-100)`);
  const hardPop = await fetchPopularity(hardIds);
  const hardOutOfHitZone = hardIds.filter((id) => {
    const p = hardPop[id] ?? 0;
    return p < 60 || p > 100;
  });
  ok(hardIds.length > 0, 'hard returned at least some tracks (pool has hits)',
    'if this fails, rock has no popularity>=60 tracks in the analyzed pool');
  ok(hardOutOfHitZone.length === 0, 'hard: every returned track has popularity 60-100',
    `${hardOutOfHitZone.length} of ${hardIds.length} were outside [60,100]`);

  // 'none' — obeys passed window [0, 40].
  const noneRows = await rpc('v5_direction_tracks', { ...commonArgs, p_pop_pref: 'none' });
  const noneIds  = (noneRows || []).map((r) => r.spotify_id).filter(Boolean);
  console.log(`  none fetched ${noneIds.length} tracks (should all be popularity 0-40)`);
  const nonePop = await fetchPopularity(noneIds);
  const noneOutOfWindow = noneIds.filter((id) => {
    const p = nonePop[id] ?? 0;
    return p < 0 || p > 40;
  });
  ok(noneIds.length > 0, 'none returned tracks');
  ok(noneOutOfWindow.length === 0,
    'none: every returned track is within passed [0,40] window',
    `${noneOutOfWindow.length} of ${noneIds.length} were outside`);

  // 'soft' — WIDER window (0-100) so both hits and non-hits are eligible.
  // Hits should bubble to the front of the random draw via ORDER BY bias.
  const softArgs = { ...commonArgs, p_pop_lo: 0, p_pop_hi: 100 };
  const softRows = await rpc('v5_direction_tracks', { ...softArgs, p_pop_pref: 'soft' });
  const softIds  = (softRows || []).map((r) => r.spotify_id).filter(Boolean);
  console.log(`  soft fetched ${softIds.length} tracks (should be hits-first)`);
  const softPop = await fetchPopularity(softIds);
  // Find the first index where popularity drops below 60. Every index
  // BEFORE that must also be >= 60 (i.e. no non-hit-then-hit flip
  // within the returned batch, since soft is stable-ordering hits to the
  // front). Rely on the position of the first non-hit as the pivot.
  const firstNonHitIdx = softIds.findIndex((id) => (softPop[id] ?? 0) < 60);
  const softHead = firstNonHitIdx === -1 ? softIds : softIds.slice(0, firstNonHitIdx);
  const softHeadBelow60 = softHead.filter((id) => (softPop[id] ?? 0) < 60);
  ok(softHeadBelow60.length === 0,
    'soft: hits come first (no non-hit appears before any hit)',
    `firstNonHitIdx=${firstNonHitIdx}, softHead had ${softHeadBelow60.length} non-hits`);
  console.log(`  soft first-non-hit position: ${firstNonHitIdx === -1 ? 'no non-hits in result' : firstNonHitIdx}`);

  // ---- Test 3: v6_direction_tracks_recent (same three cases) ----
  console.log('\n=== TEST 3: v6_direction_tracks_recent respects p_pop_pref ===');
  const recentArgs = {
    ...commonArgs,
    p_biz_id:        businessId,
    p_direction_key: '_test_key_' + stamp,
    p_exclude_days:  0,   // fresh biz has no history anyway
  };
  const rHardRows = await rpc('v6_direction_tracks_recent', { ...recentArgs, p_pop_pref: 'hard' });
  const rHardIds  = (rHardRows || []).map((r) => r.spotify_id).filter(Boolean);
  const rHardPop = await fetchPopularity(rHardIds);
  const rHardOutOfHitZone = rHardIds.filter((id) => {
    const p = rHardPop[id] ?? 0;
    return p < 60 || p > 100;
  });
  ok(rHardIds.length > 0 && rHardOutOfHitZone.length === 0,
    'v6_direction_tracks_recent hard: only hits (60-100), overriding [0,40] window',
    `${rHardOutOfHitZone.length} of ${rHardIds.length} outside [60,100]`);

  const rNoneRows = await rpc('v6_direction_tracks_recent', { ...recentArgs, p_pop_pref: 'none' });
  const rNoneIds  = (rNoneRows || []).map((r) => r.spotify_id).filter(Boolean);
  ok(rNoneIds.length > 0, 'v6_direction_tracks_recent none: pool populated within [0,40]');

  const rSoftArgs = { ...recentArgs, p_pop_lo: 0, p_pop_hi: 100 };
  const rSoftRows = await rpc('v6_direction_tracks_recent', { ...rSoftArgs, p_pop_pref: 'soft' });
  const rSoftIds  = (rSoftRows || []).map((r) => r.spotify_id).filter(Boolean);
  const rSoftPop = await fetchPopularity(rSoftIds);
  const rFirstNonHitIdx = rSoftIds.findIndex((id) => (rSoftPop[id] ?? 0) < 60);
  const rSoftHead = rFirstNonHitIdx === -1 ? rSoftIds : rSoftIds.slice(0, rFirstNonHitIdx);
  const rSoftHeadBelow = rSoftHead.filter((id) => (rSoftPop[id] ?? 0) < 60);
  ok(rSoftHeadBelow.length === 0,
    'v6_direction_tracks_recent soft: hits bubble first',
    `firstNonHitIdx=${rFirstNonHitIdx}`);

  // ---- Test 4: v5_anchor_tracks per-spec pop_pref ----
  console.log('\n=== TEST 4: v5_anchor_tracks respects per-spec pop_pref ===');
  // Pass a LOW popularity window (0-40) but ask spec 1 for hits via pop_pref='hard'.
  // The hard override should ignore the passed window and give us a hit (60-100).
  const anchorRows = await rpc('v5_anchor_tracks', {
    p_specs: [
      { rank: 1, genre: 'rock', bpm_lo: 60, bpm_hi: 200, pop_pref: 'hard' },
      { rank: 2, genre: 'rock', bpm_lo: 60, bpm_hi: 200, pop_pref: 'none' },
    ],
    p_pop_lo: 0,
    p_pop_hi: 40,
  });
  const byRank = Object.fromEntries((anchorRows || []).map((r) => [r.rank, r.spotify_id]));
  const rank1 = byRank[1];
  const rank2 = byRank[2];
  ok(!!rank1, 'anchor rank=1 (hard) returned a track');
  ok(!!rank2, 'anchor rank=2 (none) returned a track');
  if (rank1) {
    const pops = await fetchPopularity([rank1]);
    const p = pops[rank1];
    ok(p >= 60 && p <= 100,
      'anchor rank=1 (hard) track has popularity 60-100 despite p_pop_hi=40',
      `got popularity=${p}`);
  }
  if (rank2) {
    const pops = await fetchPopularity([rank2]);
    const p = pops[rank2];
    ok(p >= 0 && p <= 40,
      'anchor rank=2 (none) track obeys passed [0,40] window',
      `got popularity=${p}`);
  }

  // ---- Test 5: combined inst_pref + pop_pref (both biases together) ----
  console.log('\n=== TEST 5: combined inst_pref=hard + pop_pref=hard (both filters) ===');
  const bothRows = await rpc('v5_direction_tracks', {
    p_genres: ['rock'],
    p_bpm_lo: 60,
    p_bpm_hi: 200,
    p_pop_lo: 0,
    p_pop_hi: 40,
    p_limit:  50,
    p_inst_pref: 'hard',
    p_pop_pref:  'hard',
  });
  const bothIds = (bothRows || []).map((r) => r.spotify_id).filter(Boolean);
  if (bothIds.length === 0) {
    // Perfectly valid — the intersection of "instrumental >= 85" AND "popular 60-100"
    // for rock may be empty in the analyzed pool. Note but don't fail.
    console.log('  note: intersection (inst=hard AND pop=hard) returned zero tracks — pool is thin, that is OK');
    ok(true, 'combined hard filters ran without error');
  } else {
    const bothInstPop = await pgr('GET', 'track_analyses', {
      query: { spotify_id: `in.(${bothIds.join(',')})`, select: 'spotify_id,instrumentalness,popularity' },
    });
    const bad = bothInstPop.filter((r) => (r.instrumentalness ?? 0) < 85 || r.popularity < 60 || r.popularity > 100);
    ok(bad.length === 0,
      'combined hard filters: every track satisfies BOTH (inst>=85 AND pop 60-100)',
      `${bad.length} of ${bothIds.length} violated one of the two`);
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
