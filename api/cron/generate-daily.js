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
  const { directions, popularityWindow } = await activeDirections(business.id);
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
      popularityWindow,
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
    console.error('[cron daily-gen] business fetch failed:', e.message);
    return res.status(500).json({ error: e.message });
  }

  // Businesses processed serially. Parallel would race on the shared
  // /api/new/spotify Rubin user-token refresh (and cross-user
  // v5_direction_tracks contention on the DB).
  //
  // A 5s sleep separates each business so that even a run with 20+
  // businesses spreads its Spotify writes over minutes, not seconds.
  // Combined with _daily-builder.js's own 3s inter-playlist stagger inside
  // each business, sustained write rate stays comfortably under the
  // ~200/min ceiling we've historically observed on Rubin's app.
  // No sleep before the first business — no need to delay the first
  // eligible build.
  const INTER_BUSINESS_MS = 5000;
  const busSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  for (let i = 0; i < businesses.length; i++) {
    if (i > 0) await busSleep(INTER_BUSINESS_MS);
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

  const summary = {
    ok:          true,
    considered:  businesses.length,
    ilDate:      ilNow.isoDate,
    ilDayIdx:    ilNow.dayIdx,
    built:       results.reduce((n, r) => n + (r.built || 0), 0),
    builtBiz:    results.filter((r) => r.built).length,
    skippedBiz:  results.filter((r) => r.skipped).length,
    failedBiz:   results.filter((r) => r.error && !r.built).length,
    breakdown:   results,
    tookMs:      Date.now() - t0,
  };
  console.log(`[cron daily-gen] considered=${summary.considered} built=${summary.built} builtBiz=${summary.builtBiz} skippedBiz=${summary.skippedBiz} tookMs=${summary.tookMs}`);
  return res.status(200).json(summary);
}
