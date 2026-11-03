/* /api/v7/account/playlist-feedback.js
   The owner's like / dislike on one daily playlist (v7 Home tab, 2026-10-26).

   Two bare icons sit beside each daily playlist's "▶ פתח" button. The client
   posts the verdict alone the moment an icon is tapped. A like is just that
   (Roni, 2026-11-03: no modal, and the server stores no reason with it). A
   dislike opens a modal, and its "שלח" posts again with what the owner
   didn't like; "דלג" posts nothing, so the verdict stands on its own.
   Tapping the lit icon again posts verdict 'clear', which deletes the row.

   One row per (business, playlist) — the CURRENT verdict, replaced in place.
   The playlist's name, genres and tracks are not copied: business_playlists
   rows are never deleted, so the admin API joins on spotify_id.

   Request:  { business_id, spotify_id, verdict: 'like' | 'dislike' | 'clear',
               reason? }   // reason only means anything with like / dislike
   Response: { ok: true, feedback: { verdict, reason } | null } | { error }

   Needs migration v5/precompute/migrations/2026-10-26-v7-playlist-feedback.sql.
   Without it the write fails and the endpoint answers 501 needs-migration, so
   the dashboard can say so instead of showing a dead icon.
*/

import { pgrSelect, pgrUpsert, pgrDelete } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { verifyUser } from './_settings-helpers.js';

const VERDICTS = new Set(['like', 'dislike', 'clear']);
const MAX_REASON = 500;

// A Spotify playlist id is 22 base62 characters (same check as the proxy's).
const isSpotifyId = (s) => typeof s === 'string' && /^[A-Za-z0-9]{22}$/.test(s);

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-playlist-feedback', 60, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { business_id, spotify_id, verdict } = req.body || {};
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isSpotifyId(spotify_id)) return res.status(400).json({ error: 'spotify_id required' });
    if (!VERDICTS.has(verdict)) return res.status(400).json({ error: 'verdict required' });

    try { await requireBusinessOwner(business_id, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // The playlist must be one of this business's own. business_playlists
    // rows are never deleted, so an expired playlist can still be rated —
    // the dashboard only shows the icons on live ones, but a verdict landing
    // a moment after expiry is a non-event, not an error.
    const owned = await pgrSelect('business_playlists',
      { business_id: `eq.${business_id}`, spotify_id: `eq.${spotify_id}` },
      { select: 'spotify_id', limit: 1, useService: true });
    if (!owned?.length) return res.status(404).json({ error: 'playlist not found' });

    if (verdict === 'clear') {
      await pgrDelete('business_playlist_feedback',
        { business_id: `eq.${business_id}`, spotify_id: `eq.${spotify_id}` });
      return res.status(200).json({ ok: true, feedback: null });
    }

    // `reason` belongs to a dislike, sent only by the modal's "שלח". A like
    // never keeps one (likes have no modal since 2026-11-03; text a like got
    // before then stays until the owner changes or clears it). For a dislike, an absent key
    // leaves a stored dislike's reason alone (the icon tap must not wipe text
    // the owner sent a moment earlier) but drops the text of an earlier
    // like; an empty string clears it.
    const hasReason = Object.prototype.hasOwnProperty.call(req.body || {}, 'reason');
    const row = { business_id, spotify_id, verdict, updated_at: new Date().toISOString() };
    if (verdict === 'like') {
      row.reason = null;
    } else if (hasReason) {
      const text = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, MAX_REASON) : '';
      row.reason = text || null;
    } else {
      const prev = await pgrSelect('business_playlist_feedback',
        { business_id: `eq.${business_id}`, spotify_id: `eq.${spotify_id}` },
        { select: 'verdict', limit: 1, useService: true });
      if (prev?.[0] && prev[0].verdict !== verdict) row.reason = null;
    }
    await pgrUpsert('business_playlist_feedback', row, { onConflict: 'business_id,spotify_id' });

    const saved = await pgrSelect('business_playlist_feedback',
      { business_id: `eq.${business_id}`, spotify_id: `eq.${spotify_id}` },
      { select: 'verdict,reason', limit: 1, useService: true });
    return res.status(200).json({ ok: true, feedback: saved?.[0] || { verdict, reason: row.reason ?? null } });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/business_playlist_feedback/i.test(msg) && /(does not exist|schema cache|relation)/i.test(msg)) {
      console.warn('[v7 playlist-feedback] table missing — run the 2026-10-26 migration');
      return res.status(501).json({ error: 'needs-migration' });
    }
    console.error('[v7 playlist-feedback] failed:', msg);
    return res.status(500).json({ error: 'שמירת המשוב נכשלה' });
  }
}
