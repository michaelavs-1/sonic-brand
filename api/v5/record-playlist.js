/* /api/v5/record-playlist.js
   Called by v5/generation/playlist-builder.js right after a playlist has been
   successfully created + tracks added. Inserts a row in v5_created_playlists
   with expires_at = now + TTL_HOURS. The cron worker picks it up later.

   Request body: { spotify_id, name, ttl_hours? }
   Response:     { ok: true, expires_at }
*/

import { pgrUpsert } from './supabase-client.js';

const DEFAULT_TTL_HOURS = 24;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { spotify_id, name, ttl_hours } = req.body || {};
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

    await pgrUpsert('v5_created_playlists', {
      spotify_id,
      name,
      expires_at: expiresAt,
      deleted_at: null,
      error:      null,
    }, { onConflict: 'spotify_id' });

    return res.status(200).json({ ok: true, expires_at: expiresAt });
  } catch (err) {
    console.error('[v5 record-playlist]', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
