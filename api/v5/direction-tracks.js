/* /api/v5/direction-tracks.js
   v5 per-direction playlist source. Given a direction's genres (anchor +
   secondaries), a BPM range (from the GPT output), and a popularity range
   (derived from the user's selected atmospheres), returns up to `limit`
   random cached track IDs matching all three constraints.

   Request body:
     {
       "genres":       ["Jazz (Standards)", "Bossa Nova", ...],
       "bpm_range":    { "min": 80, "max": 110 },
       "popularity":   [lo, hi],     // 0-100; optional, defaults to [0, 100]
       "limit":        10             // optional; defaults to 10
     }

   Response:
     { "spotify_ids": ["...", ...] }

   No filtering other than BPM + popularity — this is intentional.
*/

import { pgrRpc } from './supabase-client.js';
import { requireSite, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';

function intRange(param, dfltLo, dfltHi) {
  if (Array.isArray(param) && param.length === 2 && param.every((v) => Number.isFinite(v))) {
    return [Math.round(param[0]), Math.round(param[1])];
  }
  return [dfltLo, dfltHi];
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'direction-tracks', 60, 60)) return;

  try {
    const { genres, bpm_range, popularity, limit, instrumentalness_preference } = req.body || {};
    if (!Array.isArray(genres) || !genres.length) {
      return res.status(400).json({ error: 'genres required (non-empty array)' });
    }
    if (!bpm_range || typeof bpm_range.min !== 'number' || typeof bpm_range.max !== 'number') {
      return res.status(400).json({ error: 'bpm_range { min, max } required' });
    }

    const [pop_lo, pop_hi] = intRange(popularity, 0, 100);
    const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.round(limit), 100) : 10;
    // 'hard' = strict WHERE, 'soft' = ORDER BY bias, 'none' = unchanged.
    // Anything unrecognized collapses to 'none' in the RPC's default.
    const inst_pref = (instrumentalness_preference === 'hard' || instrumentalness_preference === 'soft')
      ? instrumentalness_preference : 'none';

    const rows = await pgrRpc('v5_direction_tracks', {
      p_genres:    genres,
      p_bpm_lo:    Math.floor(bpm_range.min),
      p_bpm_hi:    Math.ceil(bpm_range.max),
      p_pop_lo:    pop_lo,
      p_pop_hi:    pop_hi,
      p_limit:     capped,
      p_inst_pref: inst_pref,
    });

    const spotify_ids = (rows || []).map((r) => r.spotify_id).filter(Boolean);
    return res.status(200).json({ spotify_ids });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
