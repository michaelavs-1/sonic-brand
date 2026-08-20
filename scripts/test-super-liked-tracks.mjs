#!/usr/bin/env node
/**
 * Integration test for the super_liked_tracks table + signup.js persistence
 * path. Creates a throwaway auth user + business, exercises the same
 * PostgREST calls signup.js makes, verifies inserts + de-dup + delete, then
 * cleans everything up.
 *
 * Safe to run against prod — the test user is fully purged at the end.
 *
 * Usage (PowerShell, from repo root, .env.local loaded):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/test-super-liked-tracks.mjs
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
    throw err;
  }
  return data;
}

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

// ---------- Test fixture: create throwaway user + business ----------

const stamp     = Date.now();
const testEmail = `test-superlike-${stamp}@example.invalid`;
const testBiz   = `_test_superlike_${stamp}`;

let userId    = null;
let businessId = null;

async function setup() {
  console.log(`\n=== SETUP: creating throwaway user + business (${testEmail}) ===`);
  const created = await auth('POST', '/auth/v1/admin/users', { email: testEmail, email_confirm: false });
  userId = created?.id;
  if (!userId) throw new Error('user creation returned no id');
  console.log(`  user id: ${userId}`);

  const bizRows = await pgr('POST', 'businesses', {
    body:   { owner_id: userId, name: testBiz },
    prefer: 'return=representation',
  });
  businessId = Array.isArray(bizRows) ? bizRows[0]?.id : bizRows?.id;
  if (!businessId) throw new Error('business insert returned no id');
  console.log(`  business id: ${businessId}`);
}

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  try {
    // CASCADE on business_id will drop super_liked_tracks + business_playlists
    // + business_events + business_hours + business_place, so we only need to
    // remove the business row + the auth user.
    if (businessId) {
      await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } });
      console.log(`  business ${businessId} deleted (CASCADE drops any super_liked_tracks rows too)`);
    }
    if (userId) {
      await auth('DELETE', `/auth/v1/admin/users/${userId}`);
      console.log(`  user ${userId} deleted`);
    }
  } catch (e) {
    console.warn(`  cleanup failed: ${e.message}`);
  }
}

// ---------- Test cases ----------

const TRACK_A = '_test_track_a_20260820';
const TRACK_B = '_test_track_b_20260820';
const TRACK_C = '_test_track_c_20260820';

async function runTests() {
  // Test 1 — INSERT three super-likes (mimicking signup.js step 6).
  console.log('\n=== TEST 1: signup persists three super-likes ===');
  await pgr('POST', 'super_liked_tracks', {
    body: [
      { business_id: businessId, spotify_id: TRACK_A },
      { business_id: businessId, spotify_id: TRACK_B },
      { business_id: businessId, spotify_id: TRACK_C },
    ],
    prefer: 'return=minimal,resolution=merge-duplicates',
    query:  { on_conflict: 'business_id,spotify_id' },
  });
  let rows = await pgr('GET', 'super_liked_tracks', {
    query: { business_id: `eq.${businessId}`, select: 'spotify_id' },
  });
  ok(Array.isArray(rows) && rows.length === 3, 'three rows exist after insert', `got ${rows?.length}`);
  const ids = new Set((rows || []).map((r) => r.spotify_id));
  ok(ids.has(TRACK_A) && ids.has(TRACK_B) && ids.has(TRACK_C),
    'all three spotify_ids landed', `got ${JSON.stringify([...ids])}`);

  // Test 2 — re-INSERT same rows (repeat signup / idempotency check).
  console.log('\n=== TEST 2: re-signup with same set is a no-op (ignoreDuplicates + UNIQUE) ===');
  await pgr('POST', 'super_liked_tracks', {
    body: [
      { business_id: businessId, spotify_id: TRACK_A },
      { business_id: businessId, spotify_id: TRACK_B },
      { business_id: businessId, spotify_id: TRACK_C },
    ],
    prefer: 'return=minimal,resolution=merge-duplicates',
    query:  { on_conflict: 'business_id,spotify_id' },
  });
  rows = await pgr('GET', 'super_liked_tracks', {
    query: { business_id: `eq.${businessId}`, select: 'spotify_id' },
  });
  ok(Array.isArray(rows) && rows.length === 3, 'still three rows (dedup by UNIQUE)', `got ${rows?.length}`);

  // Test 3 — INSERT a new one (repeat signup with a fresh super-like added).
  console.log('\n=== TEST 3: re-signup adds a new super-like alongside existing ones ===');
  const TRACK_D = '_test_track_d_20260820';
  await pgr('POST', 'super_liked_tracks', {
    body:   [{ business_id: businessId, spotify_id: TRACK_D }],
    prefer: 'return=minimal,resolution=merge-duplicates',
    query:  { on_conflict: 'business_id,spotify_id' },
  });
  rows = await pgr('GET', 'super_liked_tracks', {
    query: { business_id: `eq.${businessId}`, select: 'spotify_id' },
  });
  const ids2 = new Set((rows || []).map((r) => r.spotify_id));
  ok(rows.length === 4 && ids2.has(TRACK_D), 'row added, previous ones intact', `got ${rows?.length} / ${JSON.stringify([...ids2])}`);

  // Test 4 — DELETE one row (simulates a future "unlike" endpoint or a
  //          manual cleanup).
  console.log('\n=== TEST 4: DELETE removes a specific super-like ===');
  await pgr('DELETE', 'super_liked_tracks', {
    query: { business_id: `eq.${businessId}`, spotify_id: `eq.${TRACK_B}` },
  });
  rows = await pgr('GET', 'super_liked_tracks', {
    query: { business_id: `eq.${businessId}`, select: 'spotify_id' },
  });
  const ids3 = new Set((rows || []).map((r) => r.spotify_id));
  ok(rows.length === 3, 'three rows remain', `got ${rows?.length}`);
  ok(!ids3.has(TRACK_B), 'TRACK_B is gone', `remaining: ${JSON.stringify([...ids3])}`);
  ok(ids3.has(TRACK_A) && ids3.has(TRACK_C) && ids3.has(TRACK_D),
    'the other three still present', `remaining: ${JSON.stringify([...ids3])}`);

  // Test 5 — CASCADE: deleting the business drops all super-likes.
  //          (Verified inside cleanup below — count after DELETE businesses
  //          should be 0.)
  console.log('\n=== TEST 5: dropping the business cascades to super_liked_tracks ===');
  await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } });
  // Mark businessId cleared so cleanup() doesn't try to delete again.
  const droppedBusinessId = businessId;
  businessId = null;
  rows = await pgr('GET', 'super_liked_tracks', {
    query: { business_id: `eq.${droppedBusinessId}`, select: 'spotify_id' },
  });
  ok(Array.isArray(rows) && rows.length === 0, 'zero rows after business CASCADE delete', `got ${rows?.length}`);
}

// ---------- Runner ----------

(async () => {
  try {
    await setup();
    await runTests();
  } catch (err) {
    console.error(`\nTEST RUN ABORTED: ${err.message}`);
    failed++;
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
