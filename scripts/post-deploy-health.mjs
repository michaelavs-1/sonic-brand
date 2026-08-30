#!/usr/bin/env node
/**
 * Post-deploy health report for the 2026-08-29 Spotify resilience rollout.
 * Read-only. Queries production Supabase + Upstash Redis directly.
 *
 * What it reports:
 *   1. created_playlists activity in the last window (default 24h):
 *      - How many were freshly registered by cron/onboarding
 *      - How many the expire cron successfully cleaned up
 *      - How many are still pending (expired but deleted_at IS NULL)
 *      - How many have attempts >= 1 (the resilience layer's retry state)
 *      - Any rows with alerted_at set (chronic-failure alerts already fired)
 *
 *   2. business_playlists built in the last window (daily-gen output):
 *      - Rows created today grouped by business (was daily-gen actually
 *        firing for each business that should have been built for?)
 *      - Any businesses that expected to be built but weren't
 *
 *   3. Redis state right now:
 *      - Is spotify:pause_until currently set? (if yes: writes are frozen)
 *      - Today's spotify:writes counter — how many Spotify writes so far
 *
 * Usage:
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/post-deploy-health.mjs                # last 24h
 *   node scripts/post-deploy-health.mjs --hours=15     # last 15h
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REDIS_URL    = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY'); process.exit(1); }
if (!REDIS_URL || !REDIS_TOKEN)    { console.error('Missing UPSTASH_REDIS_REST_KV_REST_API_URL / TOKEN'); process.exit(1); }

// Parse --hours=N
const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
const WINDOW_HOURS = hoursArg ? Number(hoursArg.split('=')[1]) : 24;
const WINDOW_MS    = WINDOW_HOURS * 3600 * 1000;
const nowMs        = Date.now();
const sinceIso     = new Date(nowMs - WINDOW_MS).toISOString();
const nowIso       = new Date(nowMs).toISOString();

const HDR = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type':'application/json',
};

async function pgr(path, query = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `${SUPABASE_URL}/rest/v1/${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: HDR });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : []; } catch { data = txt; }
  if (!r.ok) throw new Error(`${path} ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function pgrCount(path, query = {}) {
  const qs = new URLSearchParams({ ...query, select: 'id' }).toString();
  const url = `${SUPABASE_URL}/rest/v1/${path}?${qs}`;
  const r = await fetch(url, {
    headers: { ...HDR, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok) throw new Error(`${path} count ${r.status}`);
  const range = r.headers.get('content-range') || '0-0/0';
  const total = Number(range.split('/')[1] || 0);
  return total;
}

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['GET', key], ['TTL', key]]),
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  return { value: data?.[0]?.result || null, ttl: data?.[1]?.result || -2 };
}

function todayIL() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function fmtRel(ms) {
  const d = ms / 1000;
  if (Math.abs(d) < 60) return `${Math.round(d)}s`;
  if (Math.abs(d) < 3600) return `${Math.round(d/60)}m`;
  if (Math.abs(d) < 86400) return `${(d/3600).toFixed(1)}h`;
  return `${(d/86400).toFixed(1)}d`;
}

console.log(`\n=== POST-DEPLOY HEALTH REPORT ===`);
console.log(`Window: last ${WINDOW_HOURS}h  (since ${sinceIso})\n`);

// ---------- SECTION 1: created_playlists ----------
console.log('=== 1. Cleanup ledger (created_playlists) ===');

// Rows registered in the window (any new playlists that were built)
const registered = await pgr('created_playlists', {
  select:     'spotify_id,name,expires_at,deleted_at,attempts,last_error,next_attempt_at,alerted_at,business_id',
  order:      'expires_at.desc',
  limit:      '500',
  expires_at: `gte.${sinceIso}`,   // approximation: rows with recent expires_at were mostly registered recently
});
console.log(`  Rows registered (expires_at within window): ${registered.length}`);

// Rows successfully cleaned (deleted_at within window)
const cleaned = await pgr('created_playlists', {
  select:     'spotify_id,deleted_at',
  order:      'deleted_at.desc',
  limit:      '1000',
  deleted_at: `gte.${sinceIso}`,
});
console.log(`  Rows successfully cleaned (deleted_at within window): ${cleaned.length}`);

// Currently-pending rows: past-expired + not deleted
const pending = await pgr('created_playlists', {
  select:     'spotify_id,name,expires_at,attempts,last_error,next_attempt_at,alerted_at,business_id',
  order:      'expires_at.asc',
  deleted_at: 'is.null',
  expires_at: `lte.${nowIso}`,
});
console.log(`  Pending (past-expired, not yet cleaned): ${pending.length}`);
if (pending.length) {
  const withRetries = pending.filter((r) => r.attempts >= 1);
  const chronic     = pending.filter((r) => r.alerted_at != null);
  console.log(`    ├─ with attempts >= 1 (retry backoff engaged): ${withRetries.length}`);
  console.log(`    └─ chronic (alerted_at set — attempts >= 5): ${chronic.length}`);

  // Top-5 worst offenders by attempts
  const worst = [...pending].sort((a, b) => (b.attempts || 0) - (a.attempts || 0)).slice(0, 5);
  if (worst.some((r) => r.attempts)) {
    console.log(`\n  Worst-offender rows (top 5 by attempts):`);
    for (const r of worst) {
      const nextIn = r.next_attempt_at ? fmtRel(Date.parse(r.next_attempt_at) - nowMs) : 'NOW';
      console.log(`    ${r.spotify_id}  attempts=${r.attempts || 0}  next in ${nextIn}  err="${(r.last_error || '').slice(0, 80)}"`);
    }
  } else {
    console.log(`  (all pending rows have attempts=0 — they're just fresh, next cron will handle)`);
  }
}

// Any freshly-fired chronic alerts in the window
const alertedNew = await pgr('created_playlists', {
  select:     'spotify_id,name,attempts,alerted_at,last_error',
  order:      'alerted_at.desc',
  alerted_at: `gte.${sinceIso}`,
});
console.log(`\n  Chronic alerts fired in window: ${alertedNew.length}`);
for (const r of alertedNew) {
  console.log(`    ${r.spotify_id} "${r.name || '(unnamed)'}"  attempts=${r.attempts}  at ${r.alerted_at}`);
}

// ---------- SECTION 2: business_playlists (daily-gen output) ----------
console.log('\n=== 2. Daily-gen output (business_playlists) ===');

const dailyBuilt = await pgr('business_playlists', {
  select:     'spotify_id,business_id,label,track_count,expanded_at,expires_at,created_at,event_id',
  order:      'created_at.desc',
  created_at: `gte.${sinceIso}`,
  event_id:   'is.null',   // exclude event playlists — those are one-off, not from daily-gen
});
console.log(`  Daily playlists inserted (event_id IS NULL): ${dailyBuilt.length}`);

const byBiz = new Map();
for (const p of dailyBuilt) {
  if (!byBiz.has(p.business_id)) byBiz.set(p.business_id, []);
  byBiz.get(p.business_id).push(p);
}
console.log(`  Businesses served in window:                  ${byBiz.size}`);
if (byBiz.size) {
  // Get business names for readability
  const bizIds = [...byBiz.keys()];
  let bizRows = [];
  try {
    bizRows = await pgr('businesses', {
      select: 'id,name',
      id:     `in.(${bizIds.join(',')})`,
    });
  } catch (e) { console.warn(`  (couldn't fetch business names: ${e.message})`); }
  const bizName = Object.fromEntries(bizRows.map((b) => [b.id, b.name || '(unnamed)']));
  console.log(`\n  Per-business breakdown:`);
  for (const [bizId, arr] of [...byBiz.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const firstTs   = arr.reduce((m, p) => Math.min(m, Date.parse(p.created_at)), Infinity);
    const trackSum  = arr.reduce((s, p) => s + (p.track_count || 0), 0);
    const anyLive   = arr.some((p) => Date.parse(p.expires_at) > nowMs);
    console.log(`    ${bizId.slice(0,8)}…  "${bizName[bizId] || '?'}"  ${arr.length} playlist(s)  ${trackSum} tracks  first at ${new Date(firstTs).toISOString().slice(11,16)}Z  ${anyLive ? '(some LIVE)' : '(all expired)'}`);
  }
}

// ---------- SECTION 3: Redis diagnostics ----------
console.log('\n=== 3. Redis state ===');

const pause = await redisGet('spotify:pause_until');
if (pause?.value) {
  const until = Number(pause.value);
  const remain = until - nowMs;
  if (remain > 0) {
    console.log(`  ⚠  spotify:pause_until IS SET — writes are FROZEN`);
    console.log(`     until ${new Date(until).toISOString()} (${fmtRel(remain)} from now)`);
    console.log(`     TTL:  ${pause.ttl}s`);
  } else {
    console.log(`  spotify:pause_until has a stale value in the past (${new Date(until).toISOString()}) — not blocking anything`);
  }
} else {
  console.log(`  spotify:pause_until — NOT SET (writes are open)`);
}

const counterKey = `spotify:writes:${todayIL()}`;
const counter = await redisGet(counterKey);
if (counter?.value) {
  const n = Number(counter.value);
  const soft = 500, hard = 800;
  const status = n >= hard ? '🔴 HARD threshold crossed' : n >= soft ? '🟡 SOFT threshold crossed' : '🟢 under threshold';
  console.log(`  ${counterKey}:  ${n} writes today  ${status}`);
  console.log(`    (TTL: ${counter.ttl}s; soft alert at ${soft}, hard at ${hard})`);
} else {
  console.log(`  ${counterKey}: not set — zero user-token writes so far today (or key expired)`);
}

console.log('');
