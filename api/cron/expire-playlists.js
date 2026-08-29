/* /api/cron/expire-playlists.js
   Vercel Cron target — runs on the schedule declared in vercel.json.
   For each created_playlists row where expires_at <= now(), the row is
   eligible (next_attempt_at is NULL or in the past), and not yet deleted,
   this endpoint runs the expirePlaylistNow helper (rename + empty +
   unfollow + mark deleted_at).

   Retry model (added 2026-08-29):
     - On failure, increment `attempts` and schedule the next attempt with
       exponential backoff (1h, 2h, 4h, 8h, 16h, capped at 24h).
     - Rows are NEVER permanently abandoned — we keep retrying until either
       the Spotify call succeeds or the playlist entity is gone (isGone → the
       helper marks deleted_at). The backoff is what stops the tight
       every-hour re-loop that caused the 141-row backlog after Aug 22.
     - When a row crosses `attempts >= 5` (roughly 15h of failure), send
       one alert email. `alerted_at` is set in the same PATCH so the alert
       never fires twice for the same row lifetime.
     - Separately: if 3+ consecutive playlists fail within a single cron
       tick, fire one cluster-failure alert immediately. This catches the
       initial storm within the hour it starts, rather than waiting for the
       chronic-failure threshold to trip.

   Version note: this used to live at /api/v5/cron-expire-playlists but v6
   (and any future version) writes to the same created_playlists table.
   Moved out from under the v5 namespace so it's obvious it belongs to
   nobody in particular. The table name stays as-is for now to avoid a
   Supabase migration.

   Auth: verifies Authorization: Bearer <CRON_SECRET>. Vercel Cron sets this
   header automatically when CRON_SECRET is present in the Vercel env. Locally
   you can trigger this by hand with that header if you set the same env var.
*/

import { timingSafeEqual } from 'node:crypto';
import { pgrSelect, pgrPatch } from '../v5/supabase-client.js';
import { expirePlaylistNow } from '../v6/account/_expire-playlist.js';
import { sendAlert } from '../_alert.js';

// Prefer the stable prod alias over the deployment-specific VERCEL_URL. The
// deployment URL is subject to Vercel Deployment Protection and would return
// {error:"Protected deployment"} for the server-to-server calls we make into
// /api/new/spotify. VERCEL_PROJECT_PRODUCTION_URL is the public prod alias.
//
// `vercel dev` sets VERCEL_URL=localhost:3000 (not a real deployment URL),
// so we normalise the scheme: localhost / 127.* always use http, everything
// else uses https.
function resolveSpotifyBase() {
  const raw = process.env.VERCEL_PROJECT_PRODUCTION_URL
           || process.env.VERCEL_URL
           || '127.0.0.1:3000';
  const proto = /^(localhost|127\.)/.test(raw) ? 'http' : 'https';
  return `${proto}://${raw}`;
}
const SPOTIFY_BASE = resolveSpotifyBase();

const ALERT_ATTEMPTS_THRESHOLD = 5;      // fire per-row chronic-failure alert at this attempt count
const CLUSTER_FAIL_THRESHOLD   = 3;      // fire cluster alert after this many consecutive fails in one tick
const BACKOFF_CAP_HOURS        = 24;

// Backoff schedule: attempt 1 → 1h, 2 → 2h, 3 → 4h, 4 → 8h, 5 → 16h,
// 6+ → capped at 24h. Matches the schedule described in the migration.
function backoffMs(attempts) {
  const hours = Math.min(BACKOFF_CAP_HOURS, Math.pow(2, Math.max(1, attempts) - 1));
  return hours * 60 * 60 * 1000;
}

function formatHours(ms) {
  const h = ms / (60 * 60 * 1000);
  return h >= 1 ? `${Math.round(h)}h` : `${Math.round(ms / 60000)}m`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>. Reject anything
  // without the matching bearer. Fail-CLOSED on missing config — if
  // CRON_SECRET isn't set, this endpoint is fully open to the internet
  // and can be triggered by anyone.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'server misconfigured: CRON_SECRET not set' });
  }
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const provided = Buffer.from(req.headers.authorization || '');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const t0 = Date.now();
  const nowIso = new Date().toISOString();

  // Cron eligibility:
  //   deleted_at IS NULL AND
  //   expires_at <= now() AND
  //   (next_attempt_at IS NULL OR next_attempt_at <= now())
  // The OR clause is expressed via PostgREST's `or=` param. Pre-migration
  // rows (no next_attempt_at column value) get NULL by default and are
  // therefore immediately eligible — matches the pre-2026-08-29 behavior.
  let expired = [];
  try {
    expired = await pgrSelect(
      'created_playlists',
      {
        deleted_at:  'is.null',
        expires_at:  `lte.${nowIso}`,
        or:          `(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})`,
      },
      {
        select: 'spotify_id,name,expires_at,attempts,alerted_at,next_attempt_at',
        order:  'expires_at.asc',
        limit:  100,
        useService: true,
      },
    );
  } catch (e) {
    console.error('[cron expire] fetch expired rows failed:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log(`[cron expire] ${expired.length} playlist(s) eligible`);

  const results = { succeeded: 0, failed: 0, details: [] };
  let consecutiveFails = 0;
  let clusterAlertFired = false;
  const failureLog = []; // for cluster alert body

  // Collect all outbound alert promises so we can await them before the
  // function returns. On Vercel, fire-and-forget promises get cut off when
  // the response is sent — the container freezes and Resend never receives
  // the request. Confirmed empirically 2026-08-29: alerts fired via
  // `sendAlert(...).catch(() => {})` NEVER delivered in dev even though
  // /api/alert-probe (which awaits) worked fine. Await at the end.
  const alertPromises = [];

  for (const row of expired) {
    try {
      // expirePlaylistNow handles rename + empty + unfollow (404-tolerant)
      // and marks created_playlists.deleted_at on success. Any throw here
      // means the Spotify side didn't complete — record + backoff.
      await expirePlaylistNow({
        origin:    SPOTIFY_BASE,
        spotifyId: row.spotify_id,
        name:      row.name,
      });
      results.succeeded += 1;
      results.details.push({ spotify_id: row.spotify_id, ok: true });
      consecutiveFails = 0;
    } catch (e) {
      const errMsg = e.message?.slice(0, 400) || 'unknown error';
      console.error(`[cron expire] expire failed for ${row.spotify_id}:`, errMsg);
      results.failed += 1;
      consecutiveFails += 1;

      const attempts = (row.attempts || 0) + 1;
      const nextAttemptIso = new Date(Date.now() + backoffMs(attempts)).toISOString();
      const patchFields = {
        attempts,
        last_error:      errMsg,
        next_attempt_at: nextAttemptIso,
      };
      let firedChronicAlert = false;
      if (attempts >= ALERT_ATTEMPTS_THRESHOLD && !row.alerted_at) {
        // Stamp alerted_at BEFORE sending so a mid-flight crash can't cause
        // duplicate alerts on the next tick. Alert is fire-and-forget.
        patchFields.alerted_at = nowIso;
        firedChronicAlert = true;
      }

      try {
        await pgrPatch(
          'created_playlists',
          { spotify_id: `eq.${row.spotify_id}` },
          patchFields,
        );
      } catch (patchErr) {
        console.warn(`[cron expire] backoff PATCH failed for ${row.spotify_id}:`, patchErr.message);
      }

      results.details.push({
        spotify_id:      row.spotify_id,
        ok:              false,
        error:           errMsg,
        attempts,
        next_attempt_at: nextAttemptIso,
      });
      failureLog.push(`  ${row.spotify_id} (${row.name || 'unnamed'}) → attempts=${attempts}, next in ${formatHours(backoffMs(attempts))}: ${errMsg}`);

      if (firedChronicAlert) {
        alertPromises.push(sendAlert({
          subject: `[sonic-brand] Playlist stuck in cleanup (${attempts} attempts): ${row.name || row.spotify_id}`,
          text: [
            `A playlist row has failed cleanup ${attempts} times in a row and is still retrying with exponential backoff.`,
            ``,
            `Playlist:  ${row.name || '(unnamed)'}`,
            `Spotify:   ${row.spotify_id}`,
            `Expired:   ${row.expires_at}`,
            `Last error: ${errMsg}`,
            `Next retry: ${nextAttemptIso}`,
            ``,
            `This alert fires once per row lifetime. The cron will keep trying — either it eventually succeeds and gets marked deleted_at, or you investigate manually. Check /api/internal/business for cross-referencing to a specific business.`,
          ].join('\n'),
        }).catch((e) => {
          console.warn('[cron expire] chronic alert send threw:', e?.message);
        }));
      }

      // Cluster alert: fires ONCE per tick when the same tick sees
      // CLUSTER_FAIL_THRESHOLD consecutive failures. Different failure mode
      // from the chronic per-row alert — this catches the initial storm
      // (Aug 7 style 504 cascade, Aug 22 style QUOTA cascade) within the
      // hour it starts.
      if (consecutiveFails === CLUSTER_FAIL_THRESHOLD && !clusterAlertFired) {
        clusterAlertFired = true;
        // Snapshot the current failureLog so the email reflects state at
        // trip-time, not final tick state (which grows if more fail after).
        const snapshot = [...failureLog];
        alertPromises.push(sendAlert({
          subject: `[sonic-brand] Cron expire: ${CLUSTER_FAIL_THRESHOLD} consecutive failures — Spotify likely blocked`,
          text: [
            `The expire-playlists cron just failed ${CLUSTER_FAIL_THRESHOLD} playlists in a row on the same tick. This usually means Spotify is either:`,
            `  - returning 504 Gateway Timeouts on writes (Aug 7 pattern), or`,
            `  - refusing writes with 429/403 QUOTA_EXCEEDED (Aug 22 pattern).`,
            ``,
            `Check /api/new/spotify.js response-body logs (in Vercel Function logs) for the exact upstream reason.`,
            ``,
            `Failures so far this tick:`,
            ...snapshot,
            ``,
            `The pause switch (spotify:pause_until in Redis) may already be engaged, in which case all writes are 503'd until it expires. No manual action required unless the failure looks structural.`,
          ].join('\n'),
        }).catch((e) => {
          console.warn('[cron expire] cluster alert send threw:', e?.message);
        }));
      }
    }
  }

  // Await all outbound alert sends before returning. Without this, Vercel
  // may freeze the container mid-fetch and the emails never arrive.
  if (alertPromises.length) {
    await Promise.allSettled(alertPromises);
    console.log(`[cron expire] flushed ${alertPromises.length} alert send(s)`);
  }

  console.log(`[cron expire] done in ${Date.now() - t0}ms: ${results.succeeded} ok / ${results.failed} failed`);
  return res.status(200).json({ ok: true, elapsed_ms: Date.now() - t0, ...results });
}
