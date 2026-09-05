/* /api/cron/generate-daily.js
   Vercel Cron target — runs hourly per vercel.json.
   For every business, if today (Asia/Jerusalem) is an open day AND we're
   within 2h of opening AND no fresh daily playlist exists for today yet,
   generate one Spotify playlist per direction in the business's LATEST
   direction batch. Fresh rows land in business_playlists with today's
   created_at and an expires_at of "that day's close time + 2h".

   Storage: reads businesses (onboarding_expanded), business_hours (hours),
   business_playlists (for latestDirections + already-fresh check).
   Writes go to business_playlists via the shared _daily-builder.

   Version note: this is the sibling of /api/cron/expire-playlists. Same
   auth model (Bearer CRON_SECRET), same schedule slot ("0 * * * *"), but
   they do independent work — expire consumes the ledger's expires_at, this
   one writes new rows into it.

   Skip reasons a business can hit (per hour):
     - no-hours              (never finished onboarding)
     - not-onboarding-done   (onboarding-day expansion hasn't set the flag)
     - closed-today          (hours[dayIdx].closed = true → user-triggered
                              "המקום פתוח?" flow is the only path on
                              closed days)
     - past-close            (now > today's close + 2h in IL — the window
                              for today's daily playlist has already ended.
                              Prevents the cron from creating a born-expired
                              playlist and then re-creating it every hour
                              until midnight IL.)
     - already-built-today   (any playlist with created_at::date = today
                              exists for this business — usually because the
                              previous cron tick built it, but also true
                              when a user manually built via the closed-day
                              flow earlier today. Dedupe by build date, NOT
                              by live-status: even a same-day playlist
                              that's already expired counts as "we already
                              built today, don't re-build".)
     - too-early             (now < today's opening - 2h)
     - no-directions         (business row exists but no direction set is
                              carried forward — happens if the user
                              abandoned onboarding before samples got
                              built, rare)

   Response body is the aggregate — good for reviewing a run at
   https://vercel.com/dashboard when debugging.

   Alerts (added 2026-09-03):
     - Top-level business-fetch failure → one email per occurrence, no dedup.
       Means zero builds for anyone this tick.
     - Per-business persistent-state skips (bad-hours / no-hours /
       no-directions / zero-built) → aggregated into ONE email per tick,
       deduped via Redis key `alerted:daily-gen:<biz>:<reason>:<il-date>`
       (26h TTL) so we don't spam hourly about the same broken owner.
       "zero-built" is a DERIVED signal: cron passed every skip guard, built
       nothing, and every direction failed after retries — a real
       Spotify/DB/pool issue distinct from the never-tried "no-directions"
       case.
     - Per-business exception skips (build-failed / outer-throw) → included
       in the same aggregate email but fire on EVERY occurrence (no dedup),
       since they may recover on the next tick and we want to see patterns.
     Normal skips (not-onboarding-done / closed-today / past-close /
     already-built-today / too-early) are not alertable.
*/

import { timingSafeEqual } from 'node:crypto';
import { pgrSelect, pgrDelete } from '../v5/supabase-client.js';
import { buildDailyBatch, activeDirections } from '../v6/account/_daily-builder.js';
import {
  dailyPlaylistExpiryIso,
  dayMinutesFromHours,
  computeTargetTracks,
  ilPartsFromDate,
} from '../../v6/generation/playlist-length.js';
import { sendAlert } from '../_alert.js';

// ---- Redis (for alert dedup) ----
// Mirrors the pattern in api/new/spotify.js: fail-open on any Upstash outage /
// missing env — a broken Redis path must not turn into missed builds. When
// Redis is down we simply lose dedup for that tick and alerts may repeat;
// that's strictly better than skipping the alert entirely.
async function redisPipeline(commands) {
  const url   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(commands),
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

// SET NX EX — returns true iff we won the race to set the key (i.e. this is
// the first time today we're alerting about this (biz, reason)). Uses 26h TTL
// so the key covers an IL day + slop.
const ALERT_DEDUP_TTL_SEC = 26 * 60 * 60;
async function claimAlertOnce(businessId, reason, ilDate) {
  const key = `alerted:daily-gen:${businessId}:${reason}:${ilDate}`;
  const res = await redisPipeline([['SET', key, '1', 'NX', 'EX', String(ALERT_DEDUP_TTL_SEC)]]);
  if (!Array.isArray(res)) return true; // redis unavailable → fail-open (allow the alert)
  return res[0]?.result === 'OK';
}

// Reasons that reflect PERSISTENT STATE (won't self-heal without owner action)
// and would otherwise re-alert every hour until fixed. Dedup once-per-day.
const DEDUP_REASONS = new Set(['bad-hours', 'no-hours', 'no-directions', 'zero-built']);
// Reasons that ALWAYS alert (per-occurrence). Cheap because they're rare —
// build-failed / outer-throw signal a genuine exception, not owner state.
const ALWAYS_REASONS = new Set(['build-failed', 'outer-throw']);

// Prefer the stable prod alias (e.g. sonic-brand.vercel.app) over the
// deployment-specific VERCEL_URL. The deployment URL is subject to Vercel
// Deployment Protection and returns {error:"Protected deployment"} for
// server-to-server calls from inside a cron. VERCEL_PROJECT_PRODUCTION_URL
// resolves to the primary production alias, which is publicly reachable.
//
// `vercel dev` sets VERCEL_URL=localhost:3000 (not a real deployment URL),
// so we normalise the scheme: localhost / 127.* always use http, everything
// else uses https. Without this, the cron in dev tries https://localhost:3000
// and every server-to-server fetch fails with "fetch failed".
function resolveSpotifyBase() {
  const raw = process.env.VERCEL_PROJECT_PRODUCTION_URL
           || process.env.VERCEL_URL
           || '127.0.0.1:3000';
  const proto = /^(localhost|127\.)/.test(raw) ? 'http' : 'https';
  return `${proto}://${raw}`;
}
const SPOTIFY_BASE = resolveSpotifyBase();

// Fire the generation this many minutes before opening. Cron is hourly so
// the actual firing lands anywhere in [openIL-120min, openIL-60min].
const LEAD_MINUTES = 120;

// Parse "HH:MM" to minutes-since-midnight.
function hhmmToMins(s) {
  const [h, m] = String(s || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Minutes until a given HH:MM in Asia/Jerusalem today. Positive = in the
// future, negative = already passed (or overnight-wrapped). Uses IL wall
// clock, which is what the user-entered `open` string is in.
function minsUntilILToday(hhmm, ilNow) {
  const openMins  = hhmmToMins(hhmm);
  if (openMins == null) return null;
  const nowMins   = ilNow.hour * 60 + ilNow.minute;
  return openMins - nowMins;
}

async function fetchBusinessHours(businessId) {
  try {
    const rows = await pgrSelect('business_hours',
      { business_id: `eq.${businessId}` },
      { select: 'hours', useService: true, limit: 1 },
    );
    return rows?.[0]?.hours || null;
  } catch (e) {
    console.warn(`[cron daily-gen] business_hours read failed for biz=${businessId}:`, e.message);
    return null;
  }
}

// Check if ANY daily playlist for today (IL) exists for this business —
// live OR expired. Dedup key is build DATE, not live-status: if the cron
// has already built today, don't build again, period.
//
// Historical note: this used to also require `expires_at > now`. That
// meant a business whose window had already ended (close + 2h < now)
// would fail the "fresh" check every hour after close — its playlist
// was born already-expired since expires_at = close + 2h — and the
// cron would rebuild every hour until midnight IL. Each rebuild fired
// N parallel Spotify create_playlist calls that tripped 429s and blew
// out the /api/new/spotify function budget (see 2026-08-22 alert).
// Now the past-close skip prevents even the first pointless build.
async function anyBuiltToday(businessId, ilIsoDate) {
  let rows = [];
  try {
    rows = await pgrSelect('business_playlists',
      { business_id: `eq.${businessId}`, event_id: 'is.null' },
      { select: 'created_at', order: 'created_at.desc', limit: 10, useService: true },
    );
  } catch (e) {
    console.warn(`[cron daily-gen] freshness read failed for biz=${businessId}:`, e.message);
    return false;
  }
  return (rows || []).some((p) => p?.created_at
    && String(p.created_at).slice(0, 10) === ilIsoDate);
}

async function processBusiness({ business, now, ilNow, origin }) {
  const label = `biz=${business.id}`;

  // Don't compete with the onboarding-day one-time expansion — it fires on
  // first dashboard load and creates today's playlists too. Once that's
  // done and the flag is set, the cron takes over from the next opening.
  if (!business.onboarding_expanded) {
    return { id: business.id, skipped: 'not-onboarding-done' };
  }

  const hours = await fetchBusinessHours(business.id);
  if (!hours || typeof hours !== 'object') {
    return { id: business.id, skipped: 'no-hours' };
  }

  const h = hours[ilNow.dayIdx];
  if (!h || h.closed) {
    return { id: business.id, skipped: 'closed-today' };
  }

  // Past-close: today's window is over (now > close + 2h in IL). Reuses
  // dailyPlaylistExpiryIso — same helper that stamps expires_at on the
  // built row — so "past-close" here matches "expires_at in the past for
  // today's build" by construction. Overnight-wrap venues (close ≤ open)
  // are handled inside the helper. Without this skip we'd build a playlist
  // that's born already-expired.
  const todaysExpiryIso = dailyPlaylistExpiryIso({ hours, now });
  if (todaysExpiryIso && Date.parse(todaysExpiryIso) <= now.getTime()) {
    return { id: business.id, skipped: 'past-close' };
  }

  // "Already built today" — a daily playlist with created_at::date = today
  // (IL) already exists. Dedup by DATE, not by live-status; see the note
  // on anyBuiltToday for why.
  if (await anyBuiltToday(business.id, ilNow.isoDate)) {
    return { id: business.id, skipped: 'already-built-today' };
  }

  const minsToOpen = minsUntilILToday(h.open, ilNow);
  if (minsToOpen == null) return { id: business.id, skipped: 'bad-hours' };
  if (minsToOpen > LEAD_MINUTES) return { id: business.id, skipped: 'too-early' };
  // minsToOpen may be negative (venue already open, cron missed the window
  // for some reason — e.g. app was down). Still generate: better late than
  // no playlist for the day.

  // Direction source is now the permanent business_directions table (not
  // reconstructed from playlist history). Cascade failures — partial daily
  // builds shrinking the extractable direction set day-over-day — are
  // impossible under this model.
  const { directions } = await activeDirections(business.id);
  if (!directions.length) {
    return { id: business.id, skipped: 'no-directions' };
  }

  const dayMins = dayMinutesFromHours(hours, ilNow.dayIdx);
  const target  = computeTargetTracks(dayMins);
  // todaysExpiryIso was already computed above (past-close skip); reuse it.

  try {
    const { built, failures } = await buildDailyBatch({
      ownerId:    business.owner_id,
      businessId: business.id,
      bizName:    business.name || '',
      directions,
      target,
      expiryIso:  todaysExpiryIso,
      origin,
    });
    console.log(`[cron daily-gen] ${label} built=${built.length}/${directions.length} target=${target} expires=${todaysExpiryIso}${failures.length ? ' failures=' + JSON.stringify(failures) : ''}`);
    return {
      id: business.id,
      built: built.length,
      failures: failures.length,
      // Include the per-direction failure reasons so the diagnostic curl
      // can see why nothing was built without having to open Vercel logs.
      ...(failures.length ? { failureDetails: failures } : {}),
    };
  } catch (e) {
    console.error(`[cron daily-gen] ${label} build threw:`, e.message);
    return { id: business.id, skipped: 'build-failed', error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'server misconfigured: CRON_SECRET not set' });
  }
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const provided = Buffer.from(req.headers.authorization || '');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const t0    = Date.now();
  const now   = new Date();
  const ilNow = ilPartsFromDate(now);
  const origin = SPOTIFY_BASE;

  let businesses = [];
  try {
    businesses = await pgrSelect(
      'businesses',
      {},
      { select: 'id,owner_id,name,onboarding_expanded', order: 'created_at.asc', limit: 500, useService: true },
    );
  } catch (e) {
    // Top-level fetch failure = zero builds for anyone this tick. Alert
    // every occurrence (no dedup); this is a real infra problem, not owner
    // state. Await before responding — Vercel freezes the function post-
    // response and would cut the send mid-flight otherwise.
    console.error('[cron daily-gen] business fetch failed:', e.message);
    await sendAlert({
      subject: '[sonic-brand] Daily-gen cron: top-level business fetch failed',
      text: [
        `The daily-gen cron could not enumerate businesses this tick. No playlists were built for anyone.`,
        ``,
        `Error: ${e.message}`,
        `Time:  ${new Date().toISOString()}`,
        ``,
        `Usually points at Supabase being down or an RLS/schema issue on the businesses table. Check Vercel Function logs.`,
      ].join('\n'),
    }).catch((err) => console.warn('[cron daily-gen] top-level alert send threw:', err?.message));
    return res.status(500).json({ error: e.message });
  }

  // Businesses processed serially. Parallel would race on the shared
  // /api/new/spotify Rubin user-token refresh (and cross-user
  // v5_direction_tracks contention on the DB).
  //
  // 5s inter-business sleep spreads Spotify writes over minutes rather
  // than seconds; combined with _daily-builder.js's own 3s inter-playlist
  // stagger inside each business, sustained write rate stays well under
  // the ~200/min ceiling we've historically observed on Rubin's app.
  //
  // Conditional-sleep optimisation (2026-09-04): we only sleep after a
  // business that actually consumed Spotify budget. Skip-only ticks used
  // to eat 5s × (businesses-1) of sleep on every hourly firing (~85s at
  // 17 businesses, ~150s at 30) even when no real work happened; the
  // 08:01 UTC Sep 4 cron tick hit Vercel's 300s maxDuration mid-batch
  // partly because of this. Skipping the sleep after skip-only outcomes
  // gets us back to <10s for idle ticks. First business also never
  // sleeps.
  const INTER_BUSINESS_MS = 5000;
  const busSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Skip reasons that mean processBusiness returned WITHOUT touching
  // /api/new/spotify — no writes, no rate-budget consumption, no need
  // to space out. `build-failed` and `outer-throw` are NOT here: they
  // both imply the build reached buildDailyBatch before throwing, which
  // means Spotify was probably hit.
  const SKIP_REASONS_NO_SPOTIFY = new Set([
    'not-onboarding-done', 'no-hours', 'closed-today', 'past-close',
    'already-built-today', 'too-early', 'no-directions', 'bad-hours',
  ]);
  function consumedSpotifyBudget(result) {
    if (!result) return false;
    if (result.skipped && SKIP_REASONS_NO_SPOTIFY.has(result.skipped)) return false;
    return true;
  }
  const results = [];
  for (let i = 0; i < businesses.length; i++) {
    if (i > 0 && consumedSpotifyBudget(results[i - 1])) {
      await busSleep(INTER_BUSINESS_MS);
    }
    const b = businesses[i];
    try {
      const r = await processBusiness({ business: b, now, ilNow, origin });
      results.push(r);
    } catch (e) {
      console.error(`[cron daily-gen] biz=${b.id} outer throw:`, e.message);
      results.push({ id: b.id, skipped: 'outer-throw', error: e.message });
    }
  }

  // Opportunistic prune of v6_daily_track_history rows older than 14 days
  // (2x the 7-day exclusion window, safety margin). Non-fatal — a failure
  // just means the table grows a bit; nothing user-visible breaks.
  try {
    const cutoffIso = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
    await pgrDelete('v6_daily_track_history', { served_at: `lt.${cutoffIso}` });
  } catch (e) {
    console.warn('[cron daily-gen] history prune failed:', e.message);
  }

  // ---- alertable events ----
  // Look at each per-business result and decide if it deserves an alert.
  // - DEDUP_REASONS: persistent state (bad-hours / no-hours / no-directions /
  //   zero-built). One alert per (biz, reason, IL-date) — otherwise every
  //   hourly tick would re-alert about the same broken business until the
  //   owner fixes it.
  // - ALWAYS_REASONS: build-failed / outer-throw. Rare exceptions — fire on
  //   every occurrence since they may recover on the next tick and we want
  //   to see the pattern.
  //
  // "zero-built" is a DERIVED signal: cron went past every skip guard
  // (business SHOULD have built), buildDailyBatch returned without throwing,
  // yet built.length === 0 with failures > 0. Means every direction's build
  // failed after all retries. A real Spotify / DB / pool problem worth
  // knowing about, but persistent enough to dedup once per day.
  const bizNameById = new Map(businesses.map((b) => [b.id, b.name || '(unnamed)']));
  const candidateEvents = [];
  for (const r of results) {
    if (r.skipped && (DEDUP_REASONS.has(r.skipped) || ALWAYS_REASONS.has(r.skipped))) {
      candidateEvents.push({ bizId: r.id, reason: r.skipped, error: r.error || null });
    } else if (!r.skipped && r.built === 0 && r.failures > 0) {
      candidateEvents.push({
        bizId:   r.id,
        reason:  'zero-built',
        error:   `all ${r.failures} direction build(s) failed: ${JSON.stringify(r.failureDetails || []).slice(0, 400)}`,
      });
    }
  }

  // Filter through Redis dedup for the persistent-state reasons. Always-fire
  // reasons pass through untouched.
  const survivors = [];
  for (const ev of candidateEvents) {
    if (ALWAYS_REASONS.has(ev.reason)) {
      survivors.push(ev);
    } else if (await claimAlertOnce(ev.bizId, ev.reason, ilNow.isoDate)) {
      survivors.push(ev);
    }
  }

  if (survivors.length) {
    const lines = survivors.map((e) => {
      const name = bizNameById.get(e.bizId) || '(unknown)';
      const errPart = e.error ? ` — ${String(e.error).slice(0, 300)}` : '';
      return `  [${e.reason}] ${name} (${e.bizId})${errPart}`;
    });
    const isPersistentOnly = survivors.every((e) => DEDUP_REASONS.has(e.reason));
    const preamble = isPersistentOnly
      ? `The daily-gen cron skipped one or more businesses for reasons that require owner or admin action. This alert is deduped once per (business, reason, day) so you won't get spammed hourly — but expect it again tomorrow if unresolved.`
      : `The daily-gen cron encountered failures this tick. Persistent-state issues are deduped once per day; exceptions (build-failed / outer-throw) fire every occurrence.`;
    await sendAlert({
      subject: `[sonic-brand] Daily-gen: ${survivors.length} business(es) need attention`,
      text: [
        preamble,
        ``,
        `IL date: ${ilNow.isoDate}`,
        `Tick:    ${new Date().toISOString()}`,
        ``,
        `Events:`,
        ...lines,
        ``,
        `Reason glossary:`,
        `  bad-hours     → business_hours row is malformed (open/close unparseable). Owner needs to re-save hours in the profile tab.`,
        `  no-hours      → business_hours row missing entirely. Same fix.`,
        `  no-directions → no active rows in business_directions. Onboarding incomplete or all directions removed.`,
        `  zero-built    → cron tried to build but every direction failed after retries. Check /api/new/spotify logs for the upstream reason.`,
        `  build-failed  → processBusiness threw an exception. See Vercel logs.`,
        `  outer-throw   → the cron's own loop threw on this business. See Vercel logs.`,
      ].join('\n'),
    }).catch((err) => console.warn('[cron daily-gen] aggregate alert send threw:', err?.message));
  }

  const summary = {
    ok:          true,
    considered:  businesses.length,
    ilDate:      ilNow.isoDate,
    ilDayIdx:    ilNow.dayIdx,
    built:       results.reduce((n, r) => n + (r.built || 0), 0),
    builtBiz:    results.filter((r) => r.built).length,
    skippedBiz:  results.filter((r) => r.skipped).length,
    failedBiz:   results.filter((r) => r.error && !r.built).length,
    alerted:     survivors.length,
    breakdown:   results,
    tookMs:      Date.now() - t0,
  };
  console.log(`[cron daily-gen] considered=${summary.considered} built=${summary.built} builtBiz=${summary.builtBiz} skippedBiz=${summary.skippedBiz} alerted=${summary.alerted} tookMs=${summary.tookMs}`);
  return res.status(200).json(summary);
}
