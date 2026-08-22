/* /api/v5/record-playlist.js
   Called by v5/generation/playlist-builder.js right after a playlist has been
   successfully created + tracks added. Inserts a row in created_playlists
   with expires_at = now + TTL_HOURS. The cron worker picks it up later.

   Request body: { spotify_id, name, ttl_hours?, owner_id?, business_id? }
   - owner_id / business_id are optional because this endpoint is called
     during onboarding, BEFORE the user account exists. In that flow the
     row is written with NULL owner_id/business_id and /api/v6/account/
     signup.js back-fills them once the account + business are created.
     Callers with a user context in-hand (event-playlist, expand-playlist,
     _daily-builder) SHOULD pass both.
   Response: { ok: true, expires_at }
*/

import { pgrUpsert } from './supabase-client.js';
import { requireSite, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';

const DEFAULT_TTL_HOURS = 24;

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'record-playlist', 30, 60)) return;

  try {
    const { spotify_id, name, ttl_hours } = req.body || {};
    // owner_id / business_id INTENTIONALLY not read from the body — this
    // endpoint is called from the browser during onboarding where no user
    // account exists yet. Attribution is back-filled by signup.js (which
    // runs server-side with the service role). Accepting owner_id/business_id
    // from a client would let anyone pollute the ledger with fake attribution
    // (attach one victim's business to a foreign spotify_id).
    if (typeof spotify_id !== 'string' || !spotify_id) {
      return res.status(400).json({ error: 'spotify_id required' });
    }
    if (typeof name !== 'string' || !name) {
      return res.status(400).json({ error: 'name required' });
    }
    const ttl = Number.isFinite(ttl_hours) && ttl_hours > 0
      ? Math.min(Math.round(ttl_hours), 24 * 30) // cap at 30 days as sanity
      : DEFAULT_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttl * 3600 * 1000).toISOString();

    await pgrUpsert('created_playlists', {
      spotify_id,
      name,
      expires_at:  expiresAt,
      deleted_at:  null,
      error:       null,
      owner_id:    null,
      business_id: null,
    }, { onConflict: 'spotify_id' });

    return res.status(200).json({ ok: true, expires_at: expiresAt });
  } catch (err) {
    console.error('[record-playlist]', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
