/* /api/v6/account/log-playlist-open.js
   Append one row to business_playlist_opens whenever the owner clicks
   a "▶ פתח" button on their dashboard Home tab. Fire-and-forget from
   the client — non-blocking, opens the Spotify link regardless.

   Referenced by joining spotify_id back to business_playlists (which
   is never deleted, only expiry-gated) so a click yesterday can still
   be traced to its direction / genres / track_ids today.

   Request:
     { businessId, spotifyId, source? }   // source defaults to 'home'
   Response:
     { ok: true }
*/

import { pgrInsert } from '../../v5/supabase-client.js';
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
  // Per-IP cap. Higher than super-like (60/min) since opening a playlist
  // is a natural rapid action — an owner could plausibly click through
  // several playlists in a burst.
  if (!await guard(req, res, 'log-playlist-open', 120, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, spotifyId, source } = req.body || {};
    if (!businessId || typeof spotifyId !== 'string' || !spotifyId.length) {
      return res.status(400).json({ error: 'businessId and spotifyId required' });
    }
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const src = typeof source === 'string' && source.length && source.length <= 32
      ? source
      : 'home';

    await pgrInsert('business_playlist_opens', [{
      business_id: businessId,
      spotify_id:  spotifyId,
      source:      src,
    }]);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[log-playlist-open] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
