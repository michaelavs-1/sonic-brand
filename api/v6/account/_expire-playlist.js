/* /api/v6/account/_expire-playlist.js
   Shared "expire one Spotify playlist right now" primitive.

   Consumed by:
     - /api/cron/expire-playlists.js       (hourly TTL sweep)
     - /api/v6/account/apply-direction-change.js
                                           (immediate remove/edit rebuild)

   Not an HTTP endpoint — the leading underscore signals "private helper".

   What "expire" means, per the existing cron:
     1. Rename the playlist to "(expired) <original>" on Rubin's account so
        the owner sees why it's blank if they revisit the link.
     2. Empty tracks via replace_tracks uris:[].
     3. Unfollow on Rubin's side (removes from library).
     4. Mark created_playlists.deleted_at = now() on success.

   404/410 on any step is treated as "already gone" — the playlist entity
   is no longer on Spotify's side, so nothing to do; we still mark
   deleted_at so the ledger doesn't keep retrying.

   The `origin` arg is the base URL to hit /api/new/spotify at. Server-to-
   server callers with a valid INTERNAL_API_KEY bypass origin-guard + rate
   limits — see api/v6/origin-guard.js and api/v6/ratelimit.js.
*/

import { pgrPatch } from '../../v5/supabase-client.js';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Detect Spotify errors that mean "there is no point ever retrying this row."
// The cron treats a "gone" error as success and marks the ledger row deleted,
// so it never fires exponential backoff / chronic-failure alerts on the row.
//
// Cases covered:
//   - 404 / 410 — the playlist entity is no longer on Spotify's side
//   - 400 with "Invalid base62 id" — Spotify can't even parse the id, so no
//     amount of retry will succeed. Happens when a bad id somehow lands in
//     `created_playlists` (e.g. a test fixture leaked into prod, a truncated
//     insert). Without this branch, the row alerts after ~15h of backoff and
//     never resolves. Discovered 2026-09-04 via a stray `fake_...` fixture.
function isGone(err) {
  const msg = String(err?.message || '');
  if (/\b(404|410)\b/.test(msg)) return true;
  if (/\b400\b/.test(msg) && /Invalid base62 id/i.test(msg)) return true;
  return false;
}

async function postSpotify(origin, action, body) {
  const r = await fetch(`${origin}/api/new/spotify`, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-sonic-internal': INTERNAL_API_KEY,
    },
    body:    JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || r.statusText;
    throw new Error(`spotify ${action} ${r.status}: ${msg}`);
  }
  return data;
}

/**
 * Expire one playlist on Rubin's account and mark the ledger row deleted.
 *
 * @param {object} args
 * @param {string} args.origin      Base URL for /api/new/spotify (e.g., "https://robin-music.com")
 * @param {string} args.spotifyId   Spotify playlist id to expire
 * @param {string} [args.name]      Current playlist name (used for the "(expired) <name>" rename)
 * @param {string} [args.label]     Alternate name source if `name` is missing
 * @returns {Promise<{ok: true, gone?: boolean}>}
 * @throws if any non-404 step fails; caller decides whether to swallow.
 */
export async function expirePlaylistNow({ origin, spotifyId, name, label }) {
  const originalName = name || label || 'playlist';
  const newName = originalName.startsWith('(expired) ')
    ? originalName
    : `(expired) ${originalName}`;

  let gone = false;

  // 1. Rename (best-effort; if the playlist is already gone we skip
  // straight to marking deleted below).
  try {
    await postSpotify(origin, 'update_playlist', { playlist_id: spotifyId, name: newName });
  } catch (e) {
    if (isGone(e)) gone = true;
    else console.warn(`[expire-playlist] ${spotifyId} rename failed (continuing):`, e.message);
  }

  // 2. Empty tracks.
  if (!gone) {
    try {
      await postSpotify(origin, 'replace_tracks', { playlist_id: spotifyId, uris: [] });
    } catch (e) {
      if (isGone(e)) gone = true;
      else throw e;
    }
  }

  // 3. Unfollow (best-effort).
  if (!gone) {
    try {
      await postSpotify(origin, 'unfollow_playlist', { playlist_id: spotifyId });
    } catch (e) {
      if (isGone(e)) gone = true;
      else console.warn(`[expire-playlist] ${spotifyId} unfollow failed (continuing):`, e.message);
    }
  }

  // 4. Mark the ledger row so the hourly cron doesn't re-process.
  try {
    await pgrPatch(
      'created_playlists',
      { spotify_id: `eq.${spotifyId}` },
      { deleted_at: new Date().toISOString(), error: null },
    );
  } catch (e) {
    console.warn(`[expire-playlist] ${spotifyId} ledger mark-deleted failed:`, e.message);
  }

  return { ok: true, gone };
}
