/* /api/cron/v7-generate-daily.js
   Vercel Cron target — v7's per-business daily playlist builder. Sibling of
   /api/cron/generate-daily.js (v6). Same auth model (Bearer CRON_SECRET), same
   hourly slot, same skip-guard + pacing + alert scaffolding — but it only
   touches v7 businesses and branches on the v7 delivery mode.

   Differences from the v6 cron:
     - Business filter: `version = 'v7'` (v6 businesses are handled by the v6
       cron until B4 shuts that off; a v7 business never has v6-style
       onboarding-day expansion, so there's no `onboarding_expanded` gate).
     - Setup gate: instead of `onboarding_expanded`, a v7 business must have
       BOTH a business_v7_settings.delivery_mode AND a business_taste_profiles
       row before anything can build. Missing either = "not set up yet"
       (SILENT skip — abandoned/incomplete onboarding, not a broken owner).
     - Branch on delivery_mode:
         option1 → buildOption1Batch  (2 high + 2 low energy directions → 4/day)
         option2 → buildOption2TimelineBatch (2 mixes/day whose energy follows
                   the owner's timeline, placed by track duration —
                   api/v7/account/_option2-builder.js; starts at max(now,
                   opening), runs to closing + 30 min)
       Both reuse the v6 builder primitives (Spotify create/add + ledger +
       history + business_playlists INSERT, with direction_id:null for the FK).

   Skip reasons a v7 business can hit (per hour):
     - no-mode              (business_v7_settings.delivery_mode null — owner
                             hasn't cleared the first-login mode gate) — SILENT
     - bad-mode             (delivery_mode is some non-option1/2 value — should
                             be impossible given the CHECK constraint) — SILENT
     - no-taste-profile     (business_taste_profiles row missing — onboarding
                             abandoned before the taste-profile stage) — SILENT
     - mode-just-set        (delivery_mode written < MODE_JUST_SET_MS ago — the
                             dashboard builds TODAY's set itself right after the
                             first-login gate; don't race it into a duplicate
                             set before its first row lands) — SILENT
     - no-hours / closed-today / past-close / already-built-today / too-early /
       bad-hours            (identical semantics to the v6 cron)
     - no-directions        (option1 built nothing because there are no active
                             business_v7_directions rows — the client-side
                             energy-directions build at the mode gate never
                             persisted; there is no cron-side regeneration in
                             v1, so this is the signal that the owner needs to
                             re-pick Option 1) — ALERT, deduped once/day
     - no-genres            (option2 built nothing because approved_genres is
                             empty) — ALERT, deduped once/day
     - build-failed / outer-throw (exception) — ALERT every occurrence

   Alerts mirror the v6 cron: top-level fetch failure (every occurrence),
   persistent-state reasons deduped once per (biz, reason, IL-date) via Redis,
   exception reasons on every occurrence.
*/

import { timingSafeEqual } from 'node:crypto';
import { pgrSelect, pgrDelete } from '../v5/supabase-client.js';
import { buildOption1Batch } from '../v7/account/_daily-builder.js';
import { buildOption2TimelineBatch } from '../v7/account/_option2-builder.js';
import {
  dailyPlaylistExpiryIso,
  ilPartsFromDate,
} from '../../v7/generation/playlist-length.js';
import { businessWindowAt, AFTER_CLOSE_MIN, MIN_REMAINING_MIN } from '../../v7/generation/energy-timeline.js';
import { sendAlert } from '../_alert.js';

// ---- Redis (alert dedup) — copied verbatim from the v6 cron ----
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

const ALERT_DEDUP_TTL_SEC = 26 * 60 * 60;
async function claimAlertOnce(businessId, reason, ilDate) {
  const key = `alerted:v7-daily-gen:${businessId}:${reason}:${ilDate}`;
  const res = await redisPipeline([['SET', key, '1', 'NX', 'EX', String(ALERT_DEDUP_TTL_SEC)]]);
  if (!Array.isArray(res)) return true; // redis unavailable → fail-open (allow the alert)
  return res[0]?.result === 'OK';
}

// Persistent state that won't self-heal without owner/admin action → dedup
// once per (biz, reason, day). no-mode / no-taste-profile are deliberately NOT
// here: they mean "onboarding not finished", a normal transient/abandoned
// state we don't nag about.
const DEDUP_REASONS  = new Set(['bad-hours', 'no-hours', 'no-directions', 'no-genres', 'zero-built']);
// Always alert (per-occurrence) — real exceptions, may recover next tick.
const ALWAYS_REASONS = new Set(['build-failed', 'outer-throw']);

// resolveSpotifyBase — copied verbatim from the v6 cron. See that file's
// comment for the VERCEL_URL=localhost:3000 dev quirk this normalises.
function resolveSpotifyBase() {
  const raw = process.env.VERCEL_PROJECT_PRODUCTION_URL
           || process.env.VERCEL_URL
           || '127.0.0.1:3000';
  const proto = /^(localhost|127\.)/.test(raw) ? 'http' : 'https';
  return `${proto}://${raw}`;
}
const SPOTIFY_BASE = resolveSpotifyBase();

const LEAD_MINUTES = 120;

// After the owner picks a daily-playlist type in the first-login gate, the
// dashboard immediately builds today's set via /api/v7/account/generate-daily.
// That takes ~1-2 min and the first business_playlists row only lands after
// the first playlist finishes, so already-built-today can't see it yet. Skip
// businesses whose mode changed within this window; if that on-demand build
// failed entirely, the next tick (nothing built today) picks it up.
const MODE_JUST_SET_MS = 15 * 60 * 1000;

function hhmmToMins(s) {
  const [h, m] = String(s || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function minsUntilILToday(hhmm, ilNow) {
  const openMins = hhmmToMins(hhmm);
  if (openMins == null) return null;
  const nowMins  = ilNow.hour * 60 + ilNow.minute;
  return openMins - nowMins;
}

async function fetchDeliverySettings(businessId) {
  try {
    const rows = await pgrSelect('business_v7_settings',
      { business_id: `eq.${businessId}` },
      { select: 'delivery_mode,updated_at', useService: true, limit: 1 },
    );
    return { mode: rows?.[0]?.delivery_mode || null, updatedAt: rows?.[0]?.updated_at || null };
  } catch (e) {
    console.warn(`[cron v7 daily-gen] business_v7_settings read failed for biz=${businessId}:`, e.message);
    return { mode: null, updatedAt: null };
  }
}

async function hasTasteProfile(businessId) {
  try {
    const rows = await pgrSelect('business_taste_profiles',
      { business_id: `eq.${businessId}` },
      { select: 'business_id', useService: true, limit: 1 },
    );
    return !!rows?.length;
  } catch (e) {
    console.warn(`[cron v7 daily-gen] business_taste_profiles read failed for biz=${businessId}:`, e.message);
    return false;
  }
}

async function fetchBusinessHours(businessId) {
  try {
    const rows = await pgrSelect('business_hours',
      { business_id: `eq.${businessId}` },
      { select: 'hours', useService: true, limit: 1 },
    );
    return rows?.[0]?.hours || null;
  } catch (e) {
    console.warn(`[cron v7 daily-gen] business_hours read failed for biz=${businessId}:`, e.message);
    return null;
  }
}

// Any daily playlist for today (IL) — live OR expired. Dedup key is build
// DATE, not live-status. Same idea as the v6 cron's guard, but compares the
// IL date of created_at (a UTC slice mismatches between 00:00 and 02:00/03:00 IL).
async function anyBuiltToday(businessId, ilIsoDate) {
  let rows = [];
  try {
    rows = await pgrSelect('business_playlists',
      { business_id: `eq.${businessId}`, event_id: 'is.null' },
      { select: 'created_at', order: 'created_at.desc', limit: 10, useService: true },
    );
  } catch (e) {
    console.warn(`[cron v7 daily-gen] freshness read failed for biz=${businessId}:`, e.message);
    return false;
  }
  return (rows || []).some((p) => p?.created_at
    && ilPartsFromDate(new Date(p.created_at)).isoDate === ilIsoDate);
}

async function processBusiness({ business, now, ilNow, origin }) {
  const label = `biz=${business.id}`;

  const { mode, updatedAt } = await fetchDeliverySettings(business.id);
  if (!mode) return { id: business.id, skipped: 'no-mode' };
  if (mode !== 'option1' && mode !== 'option2') return { id: business.id, skipped: 'bad-mode' };
  if (updatedAt && now.getTime() - Date.parse(updatedAt) < MODE_JUST_SET_MS) {
    return { id: business.id, skipped: 'mode-just-set' };
  }

  if (!await hasTasteProfile(business.id)) {
    return { id: business.id, skipped: 'no-taste-profile' };
  }

  const hours = await fetchBusinessHours(business.id);
  if (!hours || typeof hours !== 'object') {
    return { id: business.id, skipped: 'no-hours' };
  }

  const h = hours[ilNow.dayIdx];
  if (!h || h.closed) {
    return { id: business.id, skipped: 'closed-today' };
  }

  // Past-close: today's window (close + 2h IL) already ended. Same helper the
  // batch uses to stamp expires_at, so "past-close" here matches "born
  // already-expired" by construction. Overnight-wrap handled inside the helper.
  const todaysExpiryIso = dailyPlaylistExpiryIso({ hours, now });
  if (todaysExpiryIso && Date.parse(todaysExpiryIso) <= now.getTime()) {
    return { id: business.id, skipped: 'past-close' };
  }

  // Option 2 fills [max(now, opening), closing + 30 min] — the v6-style
  // past-close above allows builds until close + 2h, which for Option 2 would
  // mean a pointless sliver (or nothing). Overnight-aware window.
  if (mode === 'option2') {
    const w = businessWindowAt(hours, now);
    const open = w.phase === 'before-open' || w.phase === 'open';
    if (!open || w.closeMin + AFTER_CLOSE_MIN - Math.max(w.nowMin, w.openMin) < MIN_REMAINING_MIN) {
      return { id: business.id, skipped: 'past-close' };
    }
  }

  if (await anyBuiltToday(business.id, ilNow.isoDate)) {
    return { id: business.id, skipped: 'already-built-today' };
  }

  const minsToOpen = minsUntilILToday(h.open, ilNow);
  if (minsToOpen == null) return { id: business.id, skipped: 'bad-hours' };
  if (minsToOpen > LEAD_MINUTES) return { id: business.id, skipped: 'too-early' };
  // minsToOpen may be negative (already open, cron missed the window) — still
  // build: better late than no playlists for the day.

  try {
    // The batch fns compute their own per-playlist target + expiry from `hours`
    // + `now` (via the same v7 playlist-length helpers used for the past-close
    // check above), so this cron only hands over the raw hours.
    const batchFn = mode === 'option1' ? buildOption1Batch : buildOption2TimelineBatch;
    const { built, failures } = await batchFn({
      ownerId:    business.owner_id,
      businessId: business.id,
      bizName:    business.name || '',
      hours,
      origin,
      now,
    });
    console.log(`[cron v7 daily-gen] ${label} mode=${mode} built=${built.length}${failures.length ? ' failures=' + JSON.stringify(failures) : ''}`);
    return {
      id: business.id,
      mode,
      built: built.length,
      failures: failures.length,
      ...(failures.length ? { failureDetails: failures } : {}),
    };
  } catch (e) {
    console.error(`[cron v7 daily-gen] ${label} build threw:`, e.message);
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
      { version: 'eq.v7' },
      { select: 'id,owner_id,name,version', order: 'created_at.asc', limit: 500, useService: true },
    );
  } catch (e) {
    console.error('[cron v7 daily-gen] business fetch failed:', e.message);
    await sendAlert({
      subject: '[sonic-brand] v7 daily-gen cron: top-level business fetch failed',
      text: [
        `The v7 daily-gen cron could not enumerate v7 businesses this tick. No playlists were built for anyone.`,
        ``,
        `Error: ${e.message}`,
        `Time:  ${new Date().toISOString()}`,
        ``,
        `Usually points at Supabase being down or an RLS/schema issue on the businesses table. Check Vercel Function logs.`,
      ].join('\n'),
    }).catch((err) => console.warn('[cron v7 daily-gen] top-level alert send threw:', err?.message));
    return res.status(500).json({ error: e.message });
  }

  // Serial per-business loop + conditional inter-business sleep — same pacing
  // rationale as the v6 cron (shared Rubin Spotify token; only pause after a
  // business that actually consumed Spotify budget).
  const INTER_BUSINESS_MS = 5000;
  const busSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SKIP_REASONS_NO_SPOTIFY = new Set([
    'no-mode', 'bad-mode', 'mode-just-set', 'no-taste-profile', 'no-hours', 'closed-today',
    'past-close', 'already-built-today', 'too-early', 'bad-hours',
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
      console.error(`[cron v7 daily-gen] biz=${b.id} outer throw:`, e.message);
      results.push({ id: b.id, skipped: 'outer-throw', error: e.message });
    }
  }

  // Opportunistic prune of v6_daily_track_history (shared with v6 — the v7
  // batch records into the same table via buildDailyBatch). Non-fatal.
  try {
    const cutoffIso = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
    await pgrDelete('v6_daily_track_history', { served_at: `lt.${cutoffIso}` });
  } catch (e) {
    console.warn('[cron v7 daily-gen] history prune failed:', e.message);
  }

  // ---- alertable events ----
  const bizNameById = new Map(businesses.map((b) => [b.id, b.name || '(unnamed)']));
  const candidateEvents = [];
  for (const r of results) {
    if (r.skipped && (DEDUP_REASONS.has(r.skipped) || ALWAYS_REASONS.has(r.skipped))) {
      candidateEvents.push({ bizId: r.id, reason: r.skipped, error: r.error || null });
    } else if (!r.skipped && r.built === 0 && r.failures > 0) {
      // zero-built: passed every guard, called the batch, every direction/mix
      // failed after retries. Real Spotify/DB/pool issue.
      candidateEvents.push({
        bizId:  r.id,
        reason: 'zero-built',
        error:  `all ${r.failures} build(s) failed: ${JSON.stringify(r.failureDetails || []).slice(0, 400)}`,
      });
    } else if (!r.skipped && r.built === 0 && r.failures === 0) {
      // built nothing WITHOUT any failure = the batch had nothing to build.
      // option1 → no active business_v7_directions (client-side energy build
      // never persisted); option2 → empty approved_genres. No cron-side
      // regeneration in v1, so surface it (deduped) — owner must re-pick.
      candidateEvents.push({
        bizId:  r.id,
        reason: r.mode === 'option2' ? 'no-genres' : 'no-directions',
        error:  `mode=${r.mode || '?'} produced no playlists and no failures — nothing to build`,
      });
    }
  }

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
      ? `The v7 daily-gen cron skipped one or more businesses for reasons that require owner or admin action. Deduped once per (business, reason, day) — expect it again tomorrow if unresolved.`
      : `The v7 daily-gen cron encountered failures this tick. Persistent-state issues are deduped once per day; exceptions (build-failed / outer-throw) fire every occurrence.`;
    await sendAlert({
      subject: `[sonic-brand] v7 daily-gen: ${survivors.length} business(es) need attention`,
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
        `  bad-hours     → business_hours row malformed. Owner re-saves hours in the profile tab.`,
        `  no-hours      → business_hours row missing entirely. Same fix.`,
        `  no-directions → option1 business has no active business_v7_directions. Owner re-picks Option 1 (regenerates + persists the energy directions).`,
        `  no-genres     → option2 business has empty approved_genres in its taste profile.`,
        `  zero-built    → cron tried to build but every playlist failed after retries. Check /api/new/spotify logs.`,
        `  build-failed  → processBusiness threw. See Vercel logs.`,
        `  outer-throw   → the cron's own loop threw on this business. See Vercel logs.`,
      ].join('\n'),
    }).catch((err) => console.warn('[cron v7 daily-gen] aggregate alert send threw:', err?.message));
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
  console.log(`[cron v7 daily-gen] considered=${summary.considered} built=${summary.built} builtBiz=${summary.builtBiz} skippedBiz=${summary.skippedBiz} alerted=${summary.alerted} tookMs=${summary.tookMs}`);
  return res.status(200).json(summary);
}
