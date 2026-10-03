/* /api/v7/account/delete-event.js
   Trash icon on a v7 special-playlist card: the card AND its Spotify playlist
   go away (v6's delete-event only removed the card and left the playlist live
   until 04:00).

   1. Archive the business_events row into deleted_events, then delete it —
      which also frees a slot in the 2-per-day cap (_special-events.js).
   2. The event's live business_playlists rows get expires_at = now, so the
      dashboard drops them at once.
   3. Spotify: the crons go first (Roni, 2026-10-03). If the daily cron or the
      expire cron is running (api/_cron-running.js), the playlist is handed to
      the expire cron — its ledger row gets expires_at = now, and the next :30
      sweep deletes it ("back of the line"). Otherwise it's deleted right away
      (expirePlaylistNow: rename → empty → unfollow → ledger deleted_at); if
      that fails, it falls back to the same hand-off.

   Request:  { businessId, eventId }
   Response: { ok: true, spotify: 'deleted' | 'queued' | 'none' } */

import { pgrSelect, pgrUpsert, pgrDelete, pgrPatch } from '../../v5/supabase-client.js';
import { setCors }      from '../../v6/origin-guard.js';
import { guard }        from '../../v6/ratelimit.js';
import { expirePlaylistNow } from '../../v6/account/_expire-playlist.js';
import { runningCrons } from '../../_cron-running.js';
import { verifyUser }   from './_settings-helpers.js';
import { ownedBusiness, selfOrigin } from './_special-events.js';

// Let the expire cron delete it on its next tick.
async function handToExpireCron(spotifyId, nowIso) {
  await pgrPatch('created_playlists',
    { spotify_id: `eq.${spotifyId}`, deleted_at: 'is.null' },
    { expires_at: nowIso, next_attempt_at: null });
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-delete-event', 30, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, eventId } = req.body || {};
    if (!businessId || !eventId) return res.status(400).json({ error: 'businessId and eventId required' });
    try { await ownedBusiness(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // 1) Archive (best-effort) + delete the card's row.
    try {
      const rows = await pgrSelect('business_events',
        { id: `eq.${eventId}`, business_id: `eq.${businessId}` },
        { select: 'id,business_id,name,description,created_at', limit: 1, useService: true });
      const src = rows?.[0];
      if (src) {
        await pgrUpsert('deleted_events', [{
          id:                  src.id,
          business_id:         src.business_id,
          name:                src.name,
          description:         src.description,
          original_created_at: src.created_at,
        }], { onConflict: 'id' });
      }
    } catch (e) {
      console.warn('[v7 delete-event] archive to deleted_events failed:', e.message);
    }
    await pgrDelete('business_events', { id: `eq.${eventId}`, business_id: `eq.${businessId}` });

    // 2) Its live playlists leave the dashboard now.
    const nowIso = new Date().toISOString();
    const live = await pgrSelect('business_playlists',
      { business_id: `eq.${businessId}`, event_id: `eq.${eventId}`, expires_at: `gt.${nowIso}` },
      { select: 'spotify_id,label', useService: true });
    if (!live?.length) return res.status(200).json({ ok: true, spotify: 'none' });
    await pgrPatch('business_playlists',
      { business_id: `eq.${businessId}`, event_id: `eq.${eventId}`, expires_at: `gt.${nowIso}` },
      { expires_at: nowIso });

    // 3) Spotify — after the crons.
    const crons = await runningCrons();
    let spotify = crons.length ? 'queued' : 'deleted';
    for (const p of live) {
      if (crons.length) { await handToExpireCron(p.spotify_id, nowIso); continue; }
      try {
        const ledger = await pgrSelect('created_playlists', { spotify_id: `eq.${p.spotify_id}` },
          { select: 'name', limit: 1, useService: true });
        await expirePlaylistNow({ origin: selfOrigin(req), spotifyId: p.spotify_id, name: ledger?.[0]?.name, label: p.label });
      } catch (e) {
        console.warn(`[v7 delete-event] immediate expire of ${p.spotify_id} failed — handing to the expire cron:`, e.message);
        await handToExpireCron(p.spotify_id, nowIso);
        spotify = 'queued';
      }
    }
    if (crons.length) console.log(`[v7 delete-event] crons running (${crons.join(', ')}) — ${live.length} playlist(s) queued for the expire cron`);
    return res.status(200).json({ ok: true, spotify });
  } catch (err) {
    console.error('[v7 delete-event] failed:', err.message);
    return res.status(500).json({ error: 'המחיקה נכשלה. נסו שוב.' });
  }
}
