/* /api/cron/expire-playlists.js
   Vercel Cron target — runs on the schedule declared in vercel.json.
   For each created_playlists row where expires_at <= now() and not yet
   deleted, this endpoint:
     1. Renames the playlist to "(expired) <original>" so the owner sees why
        it's blank if they revisit the link.
     2. Empties the playlist via replace_tracks with uris: [].
     3. Unfollows on Rubin's side (removes from library; playlist itself
        remains accessible by URL, just empty).
     4. Marks deleted_at on success, or writes the error and leaves
        deleted_at NULL so the next tick retries.

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

// Prefer the stable prod alias over the deployment-specific VERCEL_URL. The
// deployment URL is subject to Vercel Deployment Protection and would return
// {error:"Protected deployment"} for the server-to-server calls we make into
// /api/new/spotify. VERCEL_PROJECT_PRODUCTION_URL is the public prod alias.
const SPOTIFY_BASE = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:3000');

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
  let expired = [];
  try {
    expired = await pgrSelect(
      'created_playlists',
      { deleted_at: 'is.null', expires_at: `lte.${new Date().toISOString()}` },
      { select: 'spotify_id,name,expires_at', order: 'expires_at.asc', limit: 100, useService: true },
    );
  } catch (e) {
    console.error('[cron expire] fetch expired rows failed:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log(`[cron expire] ${expired.length} playlist(s) to expire`);

  const results = { succeeded: 0, failed: 0, details: [] };
  for (const row of expired) {
    try {
      // expirePlaylistNow handles rename + empty + unfollow (404-tolerant)
      // and marks created_playlists.deleted_at on success.
      await expirePlaylistNow({
        origin:    SPOTIFY_BASE,
        spotifyId: row.spotify_id,
        name:      row.name,
      });
      results.succeeded += 1;
      results.details.push({ spotify_id: row.spotify_id, ok: true });
    } catch (e) {
      console.error(`[cron expire] expire failed for ${row.spotify_id}:`, e.message);
      // Record the error but leave deleted_at NULL so the next tick retries.
      try {
        await pgrPatch(
          'created_playlists',
          { spotify_id: `eq.${row.spotify_id}` },
          { error: e.message?.slice(0, 400) || 'unknown error' },
        );
      } catch { /* swallow — logging only */ }
      results.failed += 1;
      results.details.push({ spotify_id: row.spotify_id, ok: false, error: e.message });
    }
  }

  console.log(`[cron expire] done in ${Date.now() - t0}ms: ${results.succeeded} ok / ${results.failed} failed`);
  return res.status(200).json({ ok: true, elapsed_ms: Date.now() - t0, ...results });
}
