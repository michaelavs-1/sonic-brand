#!/usr/bin/env node
/**
 * Integration test for the 2026-08-22 cron daily-gen guards:
 *   1. past-close skip: dailyPlaylistExpiryIso for a Friday 10-14 venue
 *      called at Friday 18:00 IL returns an ISO in the past → skip fires.
 *   2. anyBuiltToday dedup: a playlist row with created_at=today counts as
 *      "already built today" regardless of expires_at (would have failed
 *      the OLD anyFreshToday check when expires_at was in the past).
 *   3. Historical replay against real פרוטון data: for the exact hourly
 *      ticks that produced the 429 bursts on 2026-08-21, confirm the new
 *      guards would have skipped rather than fired a rebuild.
 *   4. Overnight-wrap venue (bar 20:00-02:00): dailyPlaylistExpiryIso
 *      still returns future ISO at 21:00 IL → past-close does NOT fire
 *      (correct — the venue's open until 02:00 next day).
 *
 * Cleans up all fixture rows even on failure.
 *
 * Usage (PowerShell, from repo root, .env.local loaded):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/test-cron-daily-guards.mjs
 */

import { dailyPlaylistExpiryIso, ilPartsFromDate } from '../v6/generation/playlist-length.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
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

// Mirror of the exported anyBuiltToday helper in api/cron/generate-daily.js
// (not exported — duplicated here as the test contract).
async function anyBuiltToday(businessId, ilIsoDate) {
  const rows = await pgr('GET', 'business_playlists', {
    query: {
      business_id: `eq.${businessId}`,
      event_id:    'is.null',
      select:      'created_at',
      order:       'created_at.desc',
      limit:       '10',
    },
  });
  return (rows || []).some((p) => p?.created_at
    && String(p.created_at).slice(0, 10) === ilIsoDate);
}

// ---------- Fixture ----------
const stamp     = Date.now();
const testEmail = `test-cron-guards-${stamp}@example.invalid`;
const testBiz   = `_test_cron_guards_${stamp}`;
let userId     = null;
let businessId = null;

async function setup() {
  console.log(`\n=== SETUP ===`);
  const created = await auth('POST', '/auth/v1/admin/users', { email: testEmail, email_confirm: false });
  userId = created?.id;
  const bizRows = await pgr('POST', 'businesses', {
    body:   { owner_id: userId, name: testBiz },
    prefer: 'return=representation',
  });
  businessId = Array.isArray(bizRows) ? bizRows[0]?.id : bizRows?.id;
  console.log(`  user=${userId}  business=${businessId}`);
}

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  try {
    if (businessId) {
      await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } });
    }
    if (userId) {
      await auth('DELETE', `/auth/v1/admin/users/${userId}`);
    }
    console.log('  removed test user + business (CASCADE clears business_playlists)');
  } catch (e) {
    console.warn(`  cleanup failed: ${e.message}`);
  }
}

// ---------- Tests ----------
async function runTests() {
  // Friday hours 10-14 (exact same shape as biz פרוטון that triggered the alert).
  const friHours = {
    0: { closed: true },
    1: { closed: true },
    2: { closed: true },
    3: { closed: true },
    4: { closed: true },
    5: { open: '10:00', close: '14:00', closed: false },
    6: { closed: true },
  };

  // Pick a real Friday in 2026 for the fake "now" — 2026-08-21 was a Friday.
  const fri18IL_UTC = new Date('2026-08-21T15:00:00Z');  // 18:00 IL summer (+3)
  const fri12IL_UTC = new Date('2026-08-21T09:00:00Z');  // 12:00 IL summer

  console.log('\n=== TEST 1: past-close skip via dailyPlaylistExpiryIso ===');
  const exp18 = dailyPlaylistExpiryIso({ hours: friHours, now: fri18IL_UTC });
  ok(!!exp18, 'expiry ISO returned for open-day Friday');
  ok(exp18 && Date.parse(exp18) <= fri18IL_UTC.getTime(),
    'at 18:00 IL Friday (past close+2h), expiry ISO is in the past → past-close skip fires',
    `exp18=${exp18}  fri18IL=${fri18IL_UTC.toISOString()}`);
  console.log(`  computed expiry: ${exp18}  (should be 2026-08-21T13:00:00.000Z = 16:00 IL)`);

  console.log('\n=== TEST 2: past-close does NOT fire mid-window ===');
  const exp12 = dailyPlaylistExpiryIso({ hours: friHours, now: fri12IL_UTC });
  ok(exp12 && Date.parse(exp12) > fri12IL_UTC.getTime(),
    'at 12:00 IL Friday (mid-window), expiry ISO is in the future → past-close does NOT fire',
    `exp12=${exp12}  fri12IL=${fri12IL_UTC.toISOString()}`);

  console.log('\n=== TEST 3: past-close does NOT fire for overnight-wrap venue ===');
  // Bar 20:00-02:00. At 21:00 IL Friday, the venue's open until 02:00
  // Saturday. dailyPlaylistExpiryIso should give a next-day ISO (04:00 Sat).
  const overnightHours = {
    ...friHours,
    5: { open: '20:00', close: '02:00', closed: false },  // Fri 20:00 → Sat 02:00
  };
  const fri21IL_UTC = new Date('2026-08-21T18:00:00Z');   // 21:00 IL Friday
  const expOvernight = dailyPlaylistExpiryIso({ hours: overnightHours, now: fri21IL_UTC });
  ok(expOvernight && Date.parse(expOvernight) > fri21IL_UTC.getTime(),
    'overnight venue (Fri 20-02) at Fri 21:00 IL → expiry ISO in the future (early Saturday)',
    `expOvernight=${expOvernight}  fri21IL=${fri21IL_UTC.toISOString()}`);
  console.log(`  computed expiry: ${expOvernight}  (should be 2026-08-22T01:00:00.000Z = Sat 04:00 IL)`);

  // --- DB round-trip tests need the test fixture ---
  await setup();

  console.log('\n=== TEST 4: anyBuiltToday matches same-day row regardless of expires_at ===');
  // Insert a business_playlists row created today with expires_at IN THE PAST.
  // Under the OLD anyFreshToday, this row would fail the expires_at>now check
  // and the cron would rebuild. Under the NEW anyBuiltToday, it counts.
  const nowIso = new Date().toISOString();
  const pastExpiryIso = new Date(Date.now() - 3600 * 1000).toISOString(); // 1h ago
  await pgr('POST', 'business_playlists', {
    body: {
      spotify_id:   `_test_${stamp}_1`,
      business_id:  businessId,
      url:          'https://example.invalid/test',
      label:        'test',
      ico:          '🎵',
      track_count:  10,
      genres:       ['rock'],
      created_at:   nowIso,
      expires_at:   pastExpiryIso,
      expanded_at:  nowIso,
    },
    prefer: 'return=minimal',
  });
  const ilNow = ilPartsFromDate(new Date());
  const built = await anyBuiltToday(businessId, ilNow.isoDate);
  ok(built === true,
    'anyBuiltToday returns TRUE for a row created today with expires_at in the past',
    `ilIsoDate=${ilNow.isoDate}, built=${built}`);

  console.log('\n=== TEST 5: anyBuiltToday returns FALSE when no row exists for today ===');
  // Use a different (yesterday) isoDate on the query.
  const yesterday = new Date(Date.now() - 24*3600*1000);
  const yesterdayIsoDate = ilPartsFromDate(yesterday).isoDate;
  const builtYesterday = await anyBuiltToday(businessId, yesterdayIsoDate);
  ok(builtYesterday === false,
    `anyBuiltToday returns FALSE for a different IL date (yesterday=${yesterdayIsoDate})`,
    `got ${builtYesterday}`);

  console.log('\n=== TEST 6: historical replay — פרוטון 2026-08-21 hourly ticks ===');
  // Real hours from the biz that produced the 429 alert. For each hourly
  // tick after close+2h (13:00 UTC = 16:00 IL onwards), the new past-close
  // guard should say "skip". Before the fix, all these ticks fired a rebuild.
  const protonHours = {
    0: { open: '10:00', close: '22:00', closed: false },
    1: { closed: true },
    2: { open: '10:00', close: '22:00', closed: false },
    3: { open: '10:00', close: '22:00', closed: false },
    4: { open: '10:00', close: '22:00', closed: false },
    5: { open: '10:00', close: '14:00', closed: false }, // Friday
    6: { closed: true },
  };
  const historicalTicks = [
    '2026-08-21T13:00:00Z', // 16:00 IL — first tick that should skip (was building)
    '2026-08-21T14:00:00Z', // 17:00 IL
    '2026-08-21T15:00:00Z', // 18:00 IL
    '2026-08-21T16:00:00Z', // 19:00 IL
    '2026-08-21T17:00:00Z', // 20:00 IL — last tick before daily-gen fell silent
  ];
  let allSkipped = true;
  for (const iso of historicalTicks) {
    const now = new Date(iso);
    const exp = dailyPlaylistExpiryIso({ hours: protonHours, now });
    const wouldSkipPastClose = exp && Date.parse(exp) <= now.getTime();
    console.log(`    ${iso}  exp=${exp}  wouldSkipPastClose=${wouldSkipPastClose}`);
    if (!wouldSkipPastClose) allSkipped = false;
  }
  ok(allSkipped,
    'every one of the 5 hourly ticks that used to fire a rebuild now hits past-close → skip');

  console.log('\n=== TEST 7: pre-close tick still fires normally ===');
  // 06:01 UTC = 09:01 IL, Friday. minsToOpen = 59 (within 2h lead), not past close.
  // dailyPlaylistExpiryIso returns 13:00 UTC (16:00 IL), which is in the FUTURE
  // relative to 06:01 UTC → past-close does NOT fire.
  const preOpen = new Date('2026-08-21T06:01:00Z');
  const preOpenExp = dailyPlaylistExpiryIso({ hours: protonHours, now: preOpen });
  ok(preOpenExp && Date.parse(preOpenExp) > preOpen.getTime(),
    'at 09:01 IL Friday (59 min before open), past-close does NOT fire — normal build proceeds',
    `preOpenExp=${preOpenExp}`);
}

// ---------- Runner ----------
(async () => {
  try {
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
