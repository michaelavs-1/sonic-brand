/* /api/v6/account/toggle-super-like.js
   Add or remove ONE super_liked_tracks row for a (business, spotify_id)
   pair. Called by the direction-edit preview modal's super-like button.

   Super-like is DECOUPLED from committing a direction change: an owner
   can super-like a track for future taste-tuning and then either
   confirm or dismiss the modal. The commit path in
   apply-direction-change no longer accepts the id — this endpoint is
   the sole write path for super-likes from the profile-tab chat.

   Request:
     { businessId, spotifyId, active }   // active=true → upsert, false → delete
   Response:
     { ok: true, active }
*/

import { pgrUpsert, pgrDelete } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from './_require-business-owner.js';
import { setCors } from '../origin-guard.js';
import { guard } from '../ratelimit.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function verifyUser(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  // Modest per-IP cap — the button is toggled by hand; anything above this
  // is either a bug loop or abuse.
  if (!await guard(req, res, 'toggle-super-like', 60, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, spotifyId, active } = req.body || {};
    if (!businessId || typeof spotifyId !== 'string' || !spotifyId.length) {
      return res.status(400).json({ error: 'businessId and spotifyId required' });
    }
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    if (active) {
      // Upsert on the (business_id, spotify_id) unique constraint — no-op
      // on duplicate, safe to call repeatedly.
      await pgrUpsert('super_liked_tracks',
        [{ business_id: businessId, spotify_id: spotifyId }],
        { onConflict: 'business_id,spotify_id' });
      return res.status(200).json({ ok: true, active: true });
    }

    // Remove — filtered DELETE. No error if the row doesn't exist (PostgREST
    // treats DELETE of an empty match as a 204).
    await pgrDelete('super_liked_tracks', {
      business_id: `eq.${businessId}`,
      spotify_id:  `eq.${spotifyId}`,
    });
    return res.status(200).json({ ok: true, active: false });
  } catch (err) {
    console.error('[toggle-super-like] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
