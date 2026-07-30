/* /api/v5/cron-expire-playlists.js
   Vercel Cron target — runs on the schedule declared in vercel.json.
   For each v5_created_playlists row where expires_at <= now() and not yet
   deleted, this endpoint:
     1. Renames the playlist to "(expired) <original>" so the owner sees why
        it's blank if they revisit the link.
     2. Empties the playlist via replace_tracks with uris: [].
     3. Unfollows on Rubin's side (removes from library; playlist itself
        remains accessible by URL, just empty).
     4. Marks deleted_at on success, or writes the error and leaves
        deleted_at NULL so the next tick retries.

   Auth: verifies Authorization: Bearer <CRON_SECRET>. Vercel Cron sets this
   header automatically when CRON_SECRET is present in the Vercel env. Locally
   you can trigger this by hand with that header if you set the same env var.
*/

import { pgrSelect, pgrPatch } from './supabase-client.js';

const SPOTIFY_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://127.0.0.1:3000';

async function postSpotify(action, body) {
  const r = await fetch(`${SPOTIFY_BASE}/api/new/spotify`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || r.statusText;
    throw new Error(`spotify ${action} ${r.status}: ${msg}`);
  }
  return data;
}

async function expireOne(row) {
  const label = `${row.spotify_id} ("${row.name}")`;
  const originalName = row.name || 'playlist';
  // Guard against re-adding the prefix if a retry happens after rename succeeded
  // on a previous tick but empty/unfollow failed.
  const newName = originalName.startsWith('(expired) ')
    ? originalName
    : `(expired) ${originalName}`;

  // 1. Rename (best-effort; not fatal if Spotify rejects — playlist may have
  //    been renamed by hand or deleted-and-recreated with a different name).
  try {
    await postSpotify('update_playlist', { playlist_id: row.spotify_id, name: newName });
  } catch (e) {
    console.warn(`[v5 cron] ${label} rename failed (continuing):`, e.message);
  }

  // 2. Empty tracks. This is the load-bearing step — the owner-visible effect.
  await postSpotify('replace_tracks', { playlist_id: row.spotify_id, uris: [] });

  // 3. Unfollow (best-effort; if Spotify has already removed the playlist for
  //    some reason, this may 404 — we still mark deleted).
  try {
    await postSpotify('unfollow_playlist', { playlist_id: row.spotify_id });
  } catch (e) {
    console.warn(`[v5 cron] ${label} unfollow failed (continuing):`, e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>. Reject anything
  // without the matching bearer.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const t0 = Date.now();
  let expired = [];
  try {
    expired = await pgrSelect(
      'v5_created_playlists',
      { deleted_at: 'is.null', expires_at: `lte.${new Date().toISOString()}` },
      { select: 'spotify_id,name,expires_at', order: 'expires_at.asc', limit: 100, useService: true },
    );
  } catch (e) {
    console.error('[v5 cron] fetch expired rows failed:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log(`[v5 cron] ${expired.length} playlist(s) to expire`);

  const results = { succeeded: 0, failed: 0, details: [] };
  for (const row of expired) {
    try {
      await expireOne(row);
      await pgrPatch(
        'v5_created_playlists',
        { spotify_id: `eq.${row.spotify_id}` },
        { deleted_at: new Date().toISOString(), error: null },
      );
      results.succeeded += 1;
      results.details.push({ spotify_id: row.spotify_id, ok: true });
    } catch (e) {
      console.error(`[v5 cron] expire failed for ${row.spotify_id}:`, e.message);
      // Record the error but leave deleted_at NULL so the next tick retries.
      try {
        await pgrPatch(
          'v5_created_playlists',
          { spotify_id: `eq.${row.spotify_id}` },
          { error: e.message?.slice(0, 400) || 'unknown error' },
        );
      } catch { /* swallow — logging only */ }
      results.failed += 1;
      results.details.push({ spotify_id: row.spotify_id, ok: false, error: e.message });
    }
  }

  console.log(`[v5 cron] done in ${Date.now() - t0}ms: ${results.succeeded} ok / ${results.failed} failed`);
  return res.status(200).json({ ok: true, elapsed_ms: Date.now() - t0, ...results });
}
