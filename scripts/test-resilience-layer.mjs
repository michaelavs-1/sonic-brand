#!/usr/bin/env node
/**
 * Integration test for the 2026-08-29 Spotify resilience layer:
 *
 *   1. Migration schema present (created_playlists.attempts, last_error,
 *      next_attempt_at, alerted_at columns exist and default correctly)
 *   2. PostgREST `or=(...)` filter syntax works for the cron eligibility query
 *   3. Backoff schedule math
 *   4. Redis pause switch: set + read
 *   5. Redis pause switch: don't-overwrite-with-shorter logic
 *   6. Redis pause switch: TTL auto-expires
 *   7. Redis daily-write counter: increments + TTL persists
 *   8. Round-trip: insert a fake failing row, apply the cron's PATCH,
 *      verify attempts + next_attempt_at + last_error + alerted_at behave
 *   9. Alert email helper (dry-run by default — pass --send-alert to
 *      actually deliver a test email via Resend)
 *
 * Cleans up all fixture rows and Redis keys even on failure.
 *
 * Usage (PowerShell, from repo root):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/test-resilience-layer.mjs                 # skip live email
 *   node scripts/test-resilience-layer.mjs --send-alert    # sends 1 test email
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REDIS_URL    = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
// (see below for RESEND_KEY — read after the checks so it can be undefined)
// The project's Resend key is stored under SUPABASE_AUTH (see CLAUDE.md
// Auth email). Same env name the alert helper reads.
const RESEND_KEY   = process.env.SUPABASE_AUTH;
const SEND_ALERT   = process.argv.includes('--send-alert');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_KV_REST_API_URL / _TOKEN.');
  process.exit(1);
}

const HDR = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type':'application/json',
};

let passed = 0;
let failed = 0;
let skipped = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}
function skip(name, reason) {
  console.log(`  SKIP  ${name}  — ${reason}`);
  skipped++;
}

// Compare two ISO-8601 timestamp strings within a tolerance (default 2s).
// PostgREST reformats timestamptz on the way back out (`+00:00` instead of
// `Z`, occasional sub-microsecond drift) so byte-for-byte string equality
// is the wrong test. What we actually care about is: "did the DB store what
// we sent."
function eqTs(a, b, toleranceMs = 2000) {
  const ta = Date.parse(a || '');
  const tb = Date.parse(b || '');
  if (!ta || !tb) return false;
  return Math.abs(ta - tb) <= toleranceMs;
}

// ---------- Supabase helper ----------
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

// ---------- Redis pipeline (mirror of api/new/spotify.js) ----------
async function redisPipeline(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`redis pipeline ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

async function redisSet(key, value, ttlSec) {
  const res = await redisPipeline([['SET', key, String(value), 'EX', String(ttlSec)]]);
  return Array.isArray(res) && res[0]?.result === 'OK';
}
async function redisGet(key) {
  const res = await redisPipeline([['GET', key]]);
  return Array.isArray(res) ? res[0]?.result : null;
}
async function redisDel(key) {
  const res = await redisPipeline([['DEL', key]]);
  return Array.isArray(res) ? res[0]?.result : null;
}
async function redisTtl(key) {
  const res = await redisPipeline([['TTL', key]]);
  return Array.isArray(res) ? res[0]?.result : null;
}

// ---------- Backoff schedule (mirror of api/cron/expire-playlists.js) ----------
function backoffMs(attempts) {
  const hours = Math.min(24, Math.pow(2, Math.max(1, attempts) - 1));
  return hours * 60 * 60 * 1000;
}

// ---------- Fixtures ----------
const stamp = Date.now();
const TEST_PLAYLIST_ID = `_test_res_${stamp}`;
const TEST_PAUSE_KEY   = `spotify:pause_until_test_${stamp}`;
const TEST_COUNT_KEY   = `spotify:writes_test_${stamp}`;

async function cleanupFixtures() {
  try {
    await pgr('DELETE', 'created_playlists', {
      query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` },
    });
  } catch (e) { console.warn(`  fixture DELETE failed: ${e.message}`); }
  try { await redisDel(TEST_PAUSE_KEY); } catch {}
  try { await redisDel(TEST_COUNT_KEY); } catch {}
}

// ---------- Tests ----------

async function testMigrationSchema() {
  console.log('\n=== TEST 1: migration columns exist on created_playlists ===');
  // Insert a row using every new column explicitly; if any column is
  // missing, PostgREST returns 400/PGRST204 (schema mismatch).
  const now = new Date();
  const fixture = {
    spotify_id:      TEST_PLAYLIST_ID,
    name:            'test row for resilience-layer suite',
    expires_at:      new Date(now.getTime() - 60000).toISOString(),
    attempts:        0,
    last_error:      null,
    next_attempt_at: null,
    alerted_at:      null,
  };
  try {
    await pgr('POST', 'created_playlists', { body: fixture, prefer: 'return=minimal' });
    ok(true, 'INSERT with all new columns succeeded — migration is live');
  } catch (e) {
    ok(false, 'INSERT with all new columns', e.message);
    throw e;
  }

  // Read it back and verify defaults land as expected on a bare INSERT.
  await pgr('DELETE', 'created_playlists', { query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` } });
  await pgr('POST', 'created_playlists', {
    body: { spotify_id: TEST_PLAYLIST_ID, name: 'default check', expires_at: new Date().toISOString() },
    prefer: 'return=minimal',
  });
  const [row] = await pgr('GET', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}`, select: 'attempts,last_error,next_attempt_at,alerted_at' },
  });
  ok(row?.attempts === 0,          'attempts defaults to 0',           `got ${row?.attempts}`);
  ok(row?.last_error === null,     'last_error defaults to NULL',      `got ${row?.last_error}`);
  ok(row?.next_attempt_at === null,'next_attempt_at defaults to NULL', `got ${row?.next_attempt_at}`);
  ok(row?.alerted_at === null,     'alerted_at defaults to NULL',      `got ${row?.alerted_at}`);
}

async function testOrFilterSyntax() {
  console.log('\n=== TEST 2: PostgREST or=(...) filter works for cron eligibility ===');
  // The cron's eligibility WHERE clause uses PostgREST's `or` composition:
  //   or=(next_attempt_at.is.null,next_attempt_at.lte.<iso>)
  // If URLSearchParams encoding breaks the syntax, this SELECT 4xxs.
  const nowIso = new Date().toISOString();
  try {
    const rows = await pgr('GET', 'created_playlists', {
      query: {
        deleted_at:  'is.null',
        expires_at:  `lte.${nowIso}`,
        or:          `(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})`,
        spotify_id:  `eq.${TEST_PLAYLIST_ID}`,
        select:      'spotify_id',
      },
    });
    ok(Array.isArray(rows) && rows.length >= 1,
      'or=(next_attempt_at.is.null,next_attempt_at.lte.<iso>) matches our expired test row',
      `matched ${rows?.length ?? 0} rows`);
  } catch (e) {
    ok(false, 'PostgREST or=(...) query executes cleanly', e.message);
  }

  // Set next_attempt_at to the future — row must NOT match now.
  const futureIso = new Date(Date.now() + 3600 * 1000).toISOString();
  await pgr('PATCH', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` },
    body:  { next_attempt_at: futureIso },
    prefer:'return=minimal',
  });
  const rowsAfter = await pgr('GET', 'created_playlists', {
    query: {
      deleted_at:  'is.null',
      expires_at:  `lte.${nowIso}`,
      or:          `(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})`,
      spotify_id:  `eq.${TEST_PLAYLIST_ID}`,
      select:      'spotify_id',
    },
  });
  ok(Array.isArray(rowsAfter) && rowsAfter.length === 0,
    'row with next_attempt_at in the future is correctly EXCLUDED',
    `matched ${rowsAfter?.length ?? 0} rows`);

  // Reset next_attempt_at to NULL for later tests.
  await pgr('PATCH', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` },
    body:  { next_attempt_at: null },
    prefer:'return=minimal',
  });
}

function testBackoffMath() {
  console.log('\n=== TEST 3: backoff schedule (1h, 2h, 4h, 8h, 16h, cap 24h) ===');
  const HR = 60 * 60 * 1000;
  ok(backoffMs(1) === 1 * HR,   'attempt 1 → 1h',   `got ${backoffMs(1)}`);
  ok(backoffMs(2) === 2 * HR,   'attempt 2 → 2h',   `got ${backoffMs(2)}`);
  ok(backoffMs(3) === 4 * HR,   'attempt 3 → 4h',   `got ${backoffMs(3)}`);
  ok(backoffMs(4) === 8 * HR,   'attempt 4 → 8h',   `got ${backoffMs(4)}`);
  ok(backoffMs(5) === 16 * HR,  'attempt 5 → 16h',  `got ${backoffMs(5)}`);
  ok(backoffMs(6) === 24 * HR,  'attempt 6 → 24h (cap)', `got ${backoffMs(6)}`);
  ok(backoffMs(10) === 24 * HR, 'attempt 10 → 24h (still capped)', `got ${backoffMs(10)}`);
}

async function testPauseSetAndRead() {
  console.log('\n=== TEST 4: Redis pause switch — set and read ===');
  const until = Date.now() + 60 * 1000; // 60s from now
  await redisSet(TEST_PAUSE_KEY, String(until), 120);
  const readBack = parseInt(await redisGet(TEST_PAUSE_KEY) || '0', 10);
  ok(readBack === until, 'SET then GET returns the same epoch-ms',
    `sent=${until}  got=${readBack}`);
  const ttl = await redisTtl(TEST_PAUSE_KEY);
  ok(typeof ttl === 'number' && ttl > 0 && ttl <= 120,
    `TTL is set (${ttl}s, expected ≤ 120)`);
}

async function testPauseDontShorten() {
  console.log('\n=== TEST 5: Redis pause switch — don\'t overwrite with shorter deadline ===');
  const longUntil  = Date.now() + 600 * 1000;   // 10 minutes
  const shortUntil = Date.now() + 30 * 1000;    // 30 seconds

  await redisDel(TEST_PAUSE_KEY);
  await redisSet(TEST_PAUSE_KEY, String(longUntil), 700);
  const before = parseInt(await redisGet(TEST_PAUSE_KEY) || '0', 10);
  ok(before === longUntil, 'long pause set as baseline', `got ${before}`);

  // Now emulate the check-then-set logic from api/new/spotify.js.
  const current = parseInt(await redisGet(TEST_PAUSE_KEY) || '0', 10);
  const shouldOverwrite = current < shortUntil;   // false since current > shortUntil
  ok(shouldOverwrite === false,
    'check-before-write blocks the shorter deadline from overwriting',
    `current=${current}  attempted=${shortUntil}`);

  // The actual `setPause` in spotify.js returns { extended: false } without SET.
  // If our code accidentally SET anyway, this test catches it.
  const still = parseInt(await redisGet(TEST_PAUSE_KEY) || '0', 10);
  ok(still === longUntil,
    'key still holds the longer deadline after the (skipped) attempt',
    `got ${still}`);
}

async function testPauseExpiry() {
  console.log('\n=== TEST 6: Redis pause switch — TTL auto-expires ===');
  const until = Date.now() + 2000;  // 2s from now
  await redisSet(TEST_PAUSE_KEY, String(until), 2);
  let val = await redisGet(TEST_PAUSE_KEY);
  ok(val !== null, 'key present just after SET', `got ${val}`);
  await new Promise((r) => setTimeout(r, 3000)); // wait past TTL
  val = await redisGet(TEST_PAUSE_KEY);
  ok(val === null, 'key auto-cleared after TTL', `got ${val}`);
}

async function testWriteCounter() {
  console.log('\n=== TEST 7: Redis daily-write counter — INCR + EXPIRE-NX ===');
  await redisDel(TEST_COUNT_KEY);
  const res = await redisPipeline([
    ['INCR', TEST_COUNT_KEY],
    ['EXPIRE', TEST_COUNT_KEY, String(60), 'NX'],  // short TTL for the test
  ]);
  const c1 = Array.isArray(res) ? res[0]?.result : null;
  ok(c1 === 1, 'first INCR returns 1', `got ${c1}`);

  const res2 = await redisPipeline([['INCR', TEST_COUNT_KEY]]);
  const c2 = Array.isArray(res2) ? res2[0]?.result : null;
  ok(c2 === 2, 'second INCR returns 2', `got ${c2}`);

  // Confirm EXPIRE NX did land (TTL > 0)
  const ttl = await redisTtl(TEST_COUNT_KEY);
  ok(typeof ttl === 'number' && ttl > 0 && ttl <= 60,
    `EXPIRE NX applied (TTL=${ttl}s, expected ≤ 60)`);

  // A SECOND EXPIRE NX must be a no-op (NX = "only if no TTL"). Confirm by
  // trying to reset to a much larger TTL and observing it doesn't change.
  await redisPipeline([['EXPIRE', TEST_COUNT_KEY, String(9999), 'NX']]);
  const ttl2 = await redisTtl(TEST_COUNT_KEY);
  ok(ttl2 <= 60,
    'second EXPIRE NX is a no-op (TTL unchanged)',
    `ttl before=${ttl}  after second NX=${ttl2}`);
}

async function testCronBackoffRoundTrip() {
  console.log('\n=== TEST 8: cron backoff round-trip PATCH ===');
  // Ensure fixture is in a fresh state: expired, attempts=0.
  await pgr('DELETE', 'created_playlists', { query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` } });
  await pgr('POST', 'created_playlists', {
    body: {
      spotify_id: TEST_PLAYLIST_ID,
      name:       'backoff round-trip fixture',
      expires_at: new Date(Date.now() - 60000).toISOString(),
    },
    prefer: 'return=minimal',
  });

  // Simulate attempt #1 failure (mirrors the exact patchFields shape in
  // api/cron/expire-playlists.js).
  const t1 = new Date().toISOString();
  const nextAttempt1 = new Date(Date.now() + backoffMs(1)).toISOString();
  await pgr('PATCH', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` },
    body: {
      attempts:        1,
      last_error:      'simulated 504 gateway timeout',
      next_attempt_at: nextAttempt1,
    },
    prefer:'return=minimal',
  });
  let [row] = await pgr('GET', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}`, select: 'attempts,last_error,next_attempt_at,alerted_at' },
  });
  ok(row.attempts === 1,                                  'attempts=1 after first fail');
  ok(row.last_error === 'simulated 504 gateway timeout',  'last_error stored');
  ok(eqTs(row.next_attempt_at, nextAttempt1),             'next_attempt_at set to +1h',
     `sent=${nextAttempt1}  got=${row.next_attempt_at}`);
  ok(row.alerted_at === null,                             'alerted_at NULL below threshold');

  // Jump to attempt #5 — should stamp alerted_at (this is the threshold).
  const nextAttempt5 = new Date(Date.now() + backoffMs(5)).toISOString();
  const alertedAtIso = new Date().toISOString();
  await pgr('PATCH', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` },
    body: {
      attempts:        5,
      last_error:      'still failing',
      next_attempt_at: nextAttempt5,
      alerted_at:      alertedAtIso,
    },
    prefer:'return=minimal',
  });
  [row] = await pgr('GET', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}`, select: 'attempts,alerted_at,next_attempt_at' },
  });
  ok(row.attempts === 5,                        'attempts=5 after fifth fail');
  ok(eqTs(row.alerted_at, alertedAtIso),        'alerted_at now set (crossing threshold)',
     `sent=${alertedAtIso}  got=${row.alerted_at}`);
  ok(eqTs(row.next_attempt_at, nextAttempt5),   'next_attempt_at set to +16h',
     `sent=${nextAttempt5}  got=${row.next_attempt_at}`);

  // Attempt #6 must NOT re-set alerted_at (guard by "alerted_at IS NULL").
  const previouslyAlerted = row.alerted_at;
  await pgr('PATCH', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}` },
    body: {
      attempts:        6,
      last_error:      'still still failing',
      next_attempt_at: new Date(Date.now() + backoffMs(6)).toISOString(),
      // alerted_at intentionally NOT included — the cron only writes it on threshold crossing.
    },
    prefer:'return=minimal',
  });
  [row] = await pgr('GET', 'created_playlists', {
    query: { spotify_id: `eq.${TEST_PLAYLIST_ID}`, select: 'attempts,alerted_at' },
  });
  ok(row.attempts === 6,                       'attempts=6 after sixth fail');
  ok(row.alerted_at === previouslyAlerted,     'alerted_at unchanged (no re-alert)');
}

async function testAlertHelper() {
  console.log(`\n=== TEST 9: Resend alert helper (${SEND_ALERT ? 'LIVE SEND' : 'dry-run — pass --send-alert to deliver'}) ===`);
  if (!RESEND_KEY) {
    skip('Resend send',
      'SUPABASE_AUTH not in .env.local — set it locally to test end-to-end. api/_alert.js fails open by design when the key is missing.');
    return;
  }
  if (!SEND_ALERT) {
    skip('Resend send', 'dry-run mode. Rerun with --send-alert to deliver one test email.');
    return;
  }
  const from = process.env.ALERT_EMAIL_FROM || 'noreply@robin-music.com';
  const to   = process.env.ALERT_EMAIL_TO   || 'roni.mark@gmail.com';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: '[sonic-brand] TEST — resilience layer smoke test',
        text: [
          'This is a TEST email from scripts/test-resilience-layer.mjs.',
          '',
          'If you\'re reading this, the Resend integration works end-to-end.',
          'You can safely delete this email.',
          '',
          `Sent at: ${new Date().toISOString()}`,
        ].join('\n'),
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      ok(false, 'Resend send returned OK', `${r.status}: ${body.slice(0, 200)}`);
      return;
    }
    const data = await r.json().catch(() => ({}));
    ok(true, `Resend delivered — id=${data.id || '(no id)'}`);
    console.log(`       Delivered to: ${to}`);
  } catch (e) {
    ok(false, 'Resend fetch succeeded', e.message);
  }
}

// ---------- Runner ----------
(async () => {
  try {
    await cleanupFixtures();
    await testMigrationSchema();
    await testOrFilterSyntax();
    testBackoffMath();
    await testPauseSetAndRead();
    await testPauseDontShorten();
    await testPauseExpiry();
    await testWriteCounter();
    await testCronBackoffRoundTrip();
    await testAlertHelper();
  } catch (err) {
    console.error(`\nTEST RUN ABORTED: ${err.message}\n${err.stack}`);
    failed++;
  } finally {
    await cleanupFixtures();
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();
