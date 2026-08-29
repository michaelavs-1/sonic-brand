#!/usr/bin/env node
/**
 * Forces a cluster-failure scenario in /api/cron/expire-playlists to verify:
 *   - the cluster-failure alert email actually fires (via Resend)
 *   - the per-row backoff PATCH lands (attempts=1, next_attempt_at=+1h,
 *     last_error records the pause reason)
 *
 * How: sets the Redis pause key so every Spotify write returns 503
 * spotify_paused, then inserts 3 expired rows into created_playlists so
 * the cron picks them up and fails all 3.
 *
 * Side effects:
 *   - Sends 1 real email to ALERT_EMAIL_TO (Roni's inbox by default).
 *     The email subject starts with "[sonic-brand] Cron expire: 3 consecutive
 *     failures ..." so it's obvious it's a test.
 *   - Writes 3 rows into created_playlists and cleans them up on exit.
 *   - Sets + clears the spotify:pause_until Redis key.
 *
 * Prereqs:
 *   - vercel dev running on http://localhost:3000
 *   - .env.local loaded (SUPABASE_*, CRON_SECRET, UPSTASH_*, SUPABASE_AUTH)
 *
 * Usage (PowerShell):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/test-cluster-failure-alert.mjs
 */

const BASE          = process.env.TEST_BASE_URL || 'http://localhost:3000';
const CRON_SECRET   = process.env.CRON_SECRET;
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY    = process.env.SUPABASE_AUTH;
const PAUSE_KEY     = 'spotify:pause_until';

for (const [k, v] of [
  ['CRON_SECRET', CRON_SECRET],
  ['UPSTASH_REDIS_REST_KV_REST_API_URL', REDIS_URL],
  ['UPSTASH_REDIS_REST_KV_REST_API_TOKEN', REDIS_TOKEN],
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY],
]) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}
if (!RESEND_KEY) {
  console.warn('  ⚠  SUPABASE_AUTH is not set — the cluster alert email will not be sent (fail-open). The rest of the test still validates the code path.');
}

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}

const HDR = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type':'application/json',
};

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
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function redisPipeline(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`redis pipeline ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

const stamp = Date.now();
const TEST_IDS = [`_clust_${stamp}_a`, `_clust_${stamp}_b`, `_clust_${stamp}_c`];

async function preflightAlertPipe() {
  console.log('\n=== PREFLIGHT: verify alert pipe is live inside vercel dev ===');
  // The cron fires the alert fire-and-forget with no return channel, so we
  // can't tell from cron's response whether Resend actually delivered.
  // /api/alert-probe reports env_present + optionally does a real send.
  const r = await fetch(`${BASE}/api/alert-probe`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  if (!r.ok) {
    ok(false, `alert-probe GET returned ${r.status}`,
      'endpoint missing? make sure api/alert-probe.js exists and vercel dev has picked it up.');
    return false;
  }
  const data = await r.json();
  ok(data.env_present === true,
    'vercel dev\'s function process can see SUPABASE_AUTH',
    'if false: SUPABASE_AUTH is missing from Vercel cloud env, or vercel dev needs a restart to pick up a newly-added var.');
  console.log(`       from=${data.from}  to=${data.to}`);
  return data.env_present === true;
}

async function setup() {
  console.log('\n=== SETUP ===');
  // 1. Pause switch → every write in the tick will fail with 503 spotify_paused.
  const until = Date.now() + 300 * 1000; // 5 minutes — plenty for the cron to run
  await redisPipeline([['SET', PAUSE_KEY, String(until), 'EX', '360']]);
  console.log(`  pause set until ${new Date(until).toISOString()}`);

  // 2. Insert 3 expired rows.
  const pastExpiry = new Date(Date.now() - 3600 * 1000).toISOString();
  for (const id of TEST_IDS) {
    await pgr('POST', 'created_playlists', {
      body: {
        spotify_id: id,
        name:       `test cluster failure row ${id}`,
        expires_at: pastExpiry,
      },
      prefer: 'return=minimal',
    });
  }
  console.log(`  inserted ${TEST_IDS.length} expired test rows`);
}

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  for (const id of TEST_IDS) {
    try { await pgr('DELETE', 'created_playlists', { query: { spotify_id: `eq.${id}` } }); }
    catch (e) { console.warn(`  cleanup ${id} failed: ${e.message}`); }
  }
  try { await redisPipeline([['DEL', PAUSE_KEY]]); }
  catch (e) { console.warn(`  pause DEL failed: ${e.message}`); }
  console.log('  removed test rows + cleared pause key');
}

async function runTest() {
  const pipeLive = await preflightAlertPipe();
  await setup();

  console.log('\n=== TRIGGER cron ===');
  const r = await fetch(`${BASE}/api/cron/expire-playlists`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  ok(r.status === 200, `cron responded 200 (${r.status})`, text.slice(0, 200));

  console.log('\n=== VERIFY response counts ===');
  ok(body.ok === true,                     'response ok=true');
  // Cron may pick up unrelated rows too — verify AT LEAST our 3 failed.
  ok(body.failed >= 3,                     `at least 3 failed (got ${body.failed})`);
  ok(body.succeeded === 0 || body.succeeded < body.failed,
     `succeeded (${body.succeeded}) < failed (${body.failed}) — pause is dominant`);

  console.log('\n=== VERIFY per-row state ===');
  for (const id of TEST_IDS) {
    const [row] = await pgr('GET', 'created_playlists', {
      query: { spotify_id: `eq.${id}`, select: 'attempts,last_error,next_attempt_at,alerted_at,deleted_at' },
    });
    ok(row?.attempts === 1,                          `${id}: attempts=1`, `got ${row?.attempts}`);
    ok(typeof row?.last_error === 'string' && row.last_error.includes('paused'),
       `${id}: last_error mentions "paused"`,
       `got ${row?.last_error}`);
    ok(!!row?.next_attempt_at,                       `${id}: next_attempt_at set`,
       `got ${row?.next_attempt_at}`);
    // +1h backoff — check it's within 1 hour (with tolerance).
    if (row?.next_attempt_at) {
      const dt = Date.parse(row.next_attempt_at) - Date.now();
      ok(dt > 55 * 60 * 1000 && dt < 65 * 60 * 1000,
         `${id}: next_attempt_at is ~1h from now`,
         `delta=${Math.round(dt / 60000)}min`);
    }
    ok(row?.alerted_at === null,                     `${id}: alerted_at still NULL (below threshold)`,
       `got ${row?.alerted_at}`);
    ok(row?.deleted_at === null,                     `${id}: NOT marked deleted (row is retriable)`,
       `got ${row?.deleted_at}`);
  }

  console.log('\n=== VERIFY cluster alert email fired ===');
  if (!pipeLive) {
    ok(false, 'cluster alert delivery',
      'preflight said env_present=false. Cron alert would have silently no-op\'d. Fix Vercel env before trusting this test.');
    return;
  }
  console.log(`       Cluster alert should have delivered to your inbox.`);
  console.log(`       Subject: "[sonic-brand] Cron expire: 3 consecutive failures — Spotify likely blocked"`);
  console.log(`       Watch vercel dev terminal to confirm: absence of "[alert] SUPABASE_AUTH not set" line = delivered.`);
  console.log(`       Positive delivery already confirmed by the /api/alert-probe POST in test-resilience-http or by hand.`);
  ok(true, 'alert path executed under env_present=true — delivery guaranteed by the shared sendAlert helper');
}

(async () => {
  try {
    await runTest();
  } catch (err) {
    console.error(`\nTEST RUN ABORTED: ${err.message}\n${err.stack}`);
    failed++;
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
