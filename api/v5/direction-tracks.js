/* /api/v5/direction-tracks.js
   v5 per-direction playlist source. Given a direction's genres (anchor +
   secondaries) and a BPM range (from the Gemini output), returns up to
   `limit` random cached track IDs matching. Popularity is controlled
   entirely per-direction via popularity_preference (removed atmosphere-
   derived popularity window on 2026-09-02).

   Request body:
     {
       "genres":                      ["Jazz (Standards)", "Bossa Nova", ...],
       "bpm_range":                   { "min": 80, "max": 110 },
       "limit":                       10,                                       // optional; defaults to 10
       "instrumentalness_preference": "none"|"soft"|"hard",                     // optional
       "popularity_preference":       "none"|"soft"|"hard"                      // optional; 'hard' → [60,100]
     }

   Response:
     { "spotify_ids": ["...", ...] }
*/

import { pgrRpc } from './supabase-client.js';
import { requireSite, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'direction-tracks', 60, 60)) return;

  try {
    const { genres, bpm_range, limit, instrumentalness_preference, popularity_preference } = req.body || {};
    if (!Array.isArray(genres) || !genres.length) {
      return res.status(400).json({ error: 'genres required (non-empty array)' });
    }
    if (!bpm_range || typeof bpm_range.min !== 'number' || typeof bpm_range.max !== 'number') {
      return res.status(400).json({ error: 'bpm_range { min, max } required' });
    }

    const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.round(limit), 100) : 10;
    // 'hard' = strict WHERE, 'soft' = ORDER BY bias, 'none' = unchanged.
    // Anything unrecognized collapses to 'none' in the RPC's default.
    const inst_pref = (instrumentalness_preference === 'hard' || instrumentalness_preference === 'soft')
      ? instrumentalness_preference : 'none';
    // Popularity preference (added 2026-09-02). 'hard' OVERRIDES the
    // popularity window to [60,100]; 'soft' keeps the [0,100] pool wide
    // and biases hits (popularity >= 60) via ORDER BY.
    const pop_pref = (popularity_preference === 'hard' || popularity_preference === 'soft')
      ? popularity_preference : 'none';

    const rows = await pgrRpc('v5_direction_tracks', {
      p_genres:    genres,
      p_bpm_lo:    Math.floor(bpm_range.min),
      p_bpm_hi:    Math.ceil(bpm_range.max),
      // Popularity window fixed at [0, 100] since 2026-09-02 (atmosphere-
      // derived window removed). pop_pref narrows/biases from this base.
      p_pop_lo:    0,
      p_pop_hi:    100,
      p_limit:     capped,
      p_inst_pref: inst_pref,
      p_pop_pref:  pop_pref,
    });

    const spotify_ids = (rows || []).map((r) => r.spotify_id).filter(Boolean);
    return res.status(200).json({ spotify_ids });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
