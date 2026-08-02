/* /api/cron/generate-daily.js
   Vercel Cron target — runs hourly per vercel.json.
   For every business, if today (Asia/Jerusalem) is an open day AND we're
   within 2h of opening AND no fresh daily playlist exists for today yet,
   generate one Spotify playlist per direction in the user's LATEST
   direction batch. Fresh entries land at the top of
   user_metadata.sonic.b[bizId].playlists with today's createdAt and an
   expiresAt of "that day's close time + 2h".

   Version note: this is the sibling of /api/cron/expire-playlists. Same
   auth model (Bearer CRON_SECRET), same schedule slot ("0 * * * *"), but
   they do independent work — expire consumes the ledger's expires_at, this
   one writes new rows into it.

   Skip reasons a business can hit (per hour):
     - no-hours              (never finished onboarding)
     - not-onboarding-done   (still in onboarding-day expansion window)
     - closed-today          (hours[dayIdx].closed = true → user-triggered
                              "המקום פתוח?" flow is the only path on
                              closed days)
     - already-fresh         (a live playlist with createdAt === todayIL
                              already exists — usually because the previous
                              cron tick built it, but also true when a user
                              manually built via the closed-day flow
                              earlier today)
     - too-early             (now < today's opening - 2h)
     - no-directions         (business row exists but no direction set is
                              carried forward — happens if the user
                              abandoned onboarding before samples got
                              built, rare)

   Response body is the aggregate — good for reviewing a run at
   https://vercel.com/dashboard when debugging.
*/

import { pgrSelect, pgrDelete } from '../v5/supabase-client.js';
import { buildDailyBatch, latestDirections, readSonic } from '../v6/account/_daily-builder.js';
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
const SPOTIFY_BASE = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:3000');

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

async function processBusiness({ business, now, ilNow, origin }) {
  const label = `biz=${business.id}`;
  let sonic;
  try {
    sonic = await readSonic(business.owner_id);
  } catch (e) {
    return { id: business.id, skipped: 'read-failed', error: e.message };
  }
  const bRow = sonic?.b?.[business.id] || {};

  if (!bRow.hours || typeof bRow.hours !== 'object') {
    return { id: business.id, skipped: 'no-hours' };
  }
  // Don't compete with the onboarding-day one-time expansion — it fires on
  // first dashboard load and creates today's playlists too. Once that's
  // done and the flag is set, the cron takes over from the next opening.
  if (!bRow.onboardingExpanded) {
    return { id: business.id, skipped: 'not-onboarding-done' };
  }

  const h = bRow.hours[ilNow.dayIdx];
  if (!h || h.closed) {
    return { id: business.id, skipped: 'closed-today' };
  }

  // "Already fresh" — a live daily playlist with today's IL date already
  // exists. Covers both "cron ran an earlier hour today" and "user
  // manually built via closed-day flow earlier today".
  const nowMs   = now.getTime();
  const playlists = Array.isArray(bRow.playlists) ? bRow.playlists : [];
  const alreadyFresh = playlists.some((p) =>
    p && p.createdAt === ilNow.isoDate && !p.eventId
       && (!p.expiresAt || p.expiresAt > nowMs)
  );
  if (alreadyFresh) return { id: business.id, skipped: 'already-fresh' };

  const minsToOpen = minsUntilILToday(h.open, ilNow);
  if (minsToOpen == null) return { id: business.id, skipped: 'bad-hours' };
  if (minsToOpen > LEAD_MINUTES) return { id: business.id, skipped: 'too-early' };
  // minsToOpen may be negative (venue already open, cron missed the window
  // for some reason — e.g. app was down). Still generate: better late than
  // no playlist for the day.

  const { directions, popularityWindow } = latestDirections(playlists);
  if (!directions.length) {
    return { id: business.id, skipped: 'no-directions' };
  }

  const dayMins = dayMinutesFromHours(bRow.hours, ilNow.dayIdx);
  const target  = computeTargetTracks(dayMins);
  const expiryIso = dailyPlaylistExpiryIso({ hours: bRow.hours, now });

  try {
    const { built, failures } = await buildDailyBatch({
      ownerId:    business.owner_id,
      businessId: business.id,
      bizName:    business.name || '',
      directions,
      popularityWindow,
      target,
      expiryIso,
      origin,
    });
    console.log(`[cron daily-gen] ${label} built=${built.length}/${directions.length} target=${target} expires=${expiryIso}${failures.length ? ' failures=' + JSON.stringify(failures) : ''}`);
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
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
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
      { select: 'id,owner_id,name', order: 'created_at.asc', limit: 500, useService: true },
    );
  } catch (e) {
    console.error('[cron daily-gen] business fetch failed:', e.message);
    return res.status(500).json({ error: e.message });
  }

  // Businesses processed serially. Parallel would race on the shared
  // /api/new/spotify Rubin user-token refresh (and cross-user
  // v5_direction_tracks contention on the DB), and each business's own
  // buildDailyBatch already parallelises its N direction builds. Serial
  // outer loop is the right granularity.
  const results = [];
  for (const b of businesses) {
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
