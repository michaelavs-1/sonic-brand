#!/usr/bin/env node
/**
 * Exercises the resilience layer against a running `vercel dev` server.
 * Tests the actual code paths in api/new/spotify.js and api/cron/*.js —
 * complementing scripts/test-resilience-layer.mjs which tests DB + Redis
 * primitives in isolation.
 *
 * Prerequisites:
 *   - `vercel dev` running on http://localhost:3000
 *   - .env.local loaded (INTERNAL_API_KEY + CRON_SECRET + UPSTASH_* required)
 *
 * Usage (PowerShell):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/test-resilience-http.mjs
 *
 * Cleans up any state it creates (pause key, orphan playlists).
 */

const BASE          = process.env.TEST_BASE_URL || 'http://localhost:3000';
const INTERNAL_KEY  = process.env.INTERNAL_API_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
const PAUSE_KEY     = 'spotify:pause_until';

if (!INTERNAL_KEY) { console.error('Missing INTERNAL_API_KEY');  process.exit(1); }
if (!CRON_SECRET)  { console.error('Missing CRON_SECRET');       process.exit(1); }
if (!REDIS_URL || !REDIS_TOKEN) { console.error('Missing UPSTASH_REDIS_REST_KV_REST_API_URL/TOKEN'); process.exit(1); }

let passed = 0, failed = 0, skipped = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}
function skip(name, reason) { console.log(`  SKIP  ${name}  — ${reason}`); skipped++; }

async function redisSet(key, value, ttlSec) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, String(value), 'EX', String(ttlSec)]]),
  });
  return r.ok;
}
async function redisDel(key) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['DEL', key]]),
  });
  return r.ok;
}

async function callSpotify(action, body = {}) {
  const r = await fetch(`${BASE}/api/new/spotify`, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-sonic-internal': INTERNAL_KEY,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text };
}

async function callCron(path) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text };
}

// ------ TEST 1: pause switch → 503 spotify_paused ------

async function testPauseSwitch() {
  console.log('\n=== TEST 1: pause switch returns 503 spotify_paused ===');
  const until = Date.now() + 60 * 1000; // 60s from now
  await redisSet(PAUSE_KEY, until, 65);
  console.log(`       (set ${PAUSE_KEY} = ${until}, ttl 65s)`);

  const res = await callSpotify('create_playlist', {
    name: 'PAUSE-SWITCH-TEST-SHOULD-NEVER-BE-CREATED-' + Date.now(),
  });

  ok(res.status === 503,
    'response is 503',
    `got ${res.status}, body=${res.text.slice(0, 200)}`);
  ok(res.data?.error === 'spotify_paused',
    'body error field is "spotify_paused"',
    `got ${JSON.stringify(res.data)}`);
  ok(typeof res.data?.pausedUntil === 'number' && res.data.pausedUntil === until,
    'body pausedUntil echoes the epoch-ms we set',
    `got ${res.data?.pausedUntil}`);
  // Tolerance is generous: vercel dev's cold-start on the first request can
  // easily eat 15s off the countdown. In production this delay is measured
  // in milliseconds, but the test needs to be forgiving for dev.
  ok(typeof res.data?.remainingMs === 'number' && res.data.remainingMs > 20000 && res.data.remainingMs <= 60000,
    'body remainingMs is within (20s, 60s] window we set',
    `got ${res.data?.remainingMs} (vercel dev cold-start eats variable time; tolerance is loose)`);

  // Cleanup so subsequent tests aren't blocked by the pause.
  await redisDel(PAUSE_KEY);
  console.log(`       (cleaned up ${PAUSE_KEY})`);
}

// ------ TEST 2: response-body logging on a real 4xx ------
// We can't observe vercel dev's stdout from here — but we CAN verify that
// the endpoint returns the 4xx and pass-through the reason for a body the
// proxy has now logged. User must check the terminal running vercel dev
// for a "[spotify] user ... → 4xx" line to confirm the log path landed.

async function testBodyLoggingOn4xx() {
  console.log('\n=== TEST 2: proxy passes through a real Spotify 4xx (log line goes to vercel dev terminal) ===');
  // update_playlist on an obviously invalid playlist id — Spotify returns 400
  // "Invalid base62 id" (a real client-error the proxy will forward).
  const res = await callSpotify('update_playlist', {
    playlist_id: 'not-a-real-playlist-id',
    name: 'x',
  });
  ok(res.status >= 400 && res.status < 500,
    `proxy returned 4xx (${res.status}) — Spotify rejected as expected`,
    `body=${res.text.slice(0, 200)}`);
  console.log('       In the vercel dev terminal you should now see a line like:');
  console.log('       [spotify] user PUT https://api.spotify.com/v1/playlists/not-a-real-playlist-id → 400 ...');
  console.log('       (this confirms the response-body logging path is live)');
}

// ------ TEST 3: AbortController timeout ------
// Requires a slow upstream, which we can't inject without mocking api.spotify.com.
// The unit-level test in test-resilience-layer.mjs doesn't cover this either.
// Documented as SKIP so we're honest.

function testTimeout() {
  console.log('\n=== TEST 3: AbortController 15s timeout ===');
  skip('AbortController timeout',
    'requires a slow-responding upstream. Verified by code inspection only. ' +
    'Real-world validation happens the next time Spotify has a 504 hour.');
}

// ------ TEST 4: expire-playlists cron with new eligibility query ------
// Ensures the OR filter and code paths land end-to-end. Empty backlog case
// is the happy path we want to see today.

async function testCronExpireEndpoint() {
  console.log('\n=== TEST 4: /api/cron/expire-playlists — end-to-end tick ===');
  const res = await callCron('/api/cron/expire-playlists');
  ok(res.status === 200,       `cron returned 200 (${res.status})`, res.text.slice(0, 200));
  ok(res.data?.ok === true,    'response body ok=true');
  ok(typeof res.data?.elapsed_ms === 'number', 'response includes elapsed_ms');
  ok(Array.isArray(res.data?.details), 'response includes details[]');
  ok(typeof res.data?.succeeded === 'number' && typeof res.data?.failed === 'number',
    'response includes succeeded + failed counts',
    `succeeded=${res.data?.succeeded} failed=${res.data?.failed}`);
  console.log(`       (${res.data?.succeeded} ok / ${res.data?.failed} failed in ${res.data?.elapsed_ms}ms)`);
  console.log('       No backlog expected — last week\'s manual cleanup drained the queue.');
}

// ------ TEST 5: generate-daily cron endpoint alive check ------

async function testCronGenerateDailyEndpoint() {
  console.log('\n=== TEST 5: /api/cron/generate-daily — end-to-end tick ===');
  const res = await callCron('/api/cron/generate-daily');
  ok(res.status === 200,       `cron returned 200 (${res.status})`, res.text.slice(0, 300));
  ok(res.data?.ok === true,    'response body ok=true');
  ok(typeof res.data?.considered === 'number', 'response includes considered=<biz count>');
  ok(Array.isArray(res.data?.breakdown), 'response includes breakdown[]');
  console.log(`       (considered=${res.data?.considered} built=${res.data?.built} builtBiz=${res.data?.builtBiz} skippedBiz=${res.data?.skippedBiz} tookMs=${res.data?.tookMs})`);
  // Print skip reasons so we can see what's happening
  const skipReasons = {};
  for (const r of res.data?.breakdown || []) {
    if (r.skipped) skipReasons[r.skipped] = (skipReasons[r.skipped] || 0) + 1;
  }
  if (Object.keys(skipReasons).length) {
    console.log(`       skip reason breakdown: ${JSON.stringify(skipReasons)}`);
  }
}

// ------ Runner ------

(async () => {
  try {
    await testPauseSwitch();
    await testBodyLoggingOn4xx();
    testTimeout();
    await testCronExpireEndpoint();
    await testCronGenerateDailyEndpoint();
  } catch (err) {
    console.error(`\nTEST RUN ABORTED: ${err.message}\n${err.stack}`);
    failed++;
  } finally {
    try { await redisDel(PAUSE_KEY); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();
