/* /api/v5/anchor-tracks.js
   v5 direction preview source. Given per-direction specs (rank + anchor
   genre + BPM range) and a shared popularity window, returns one random
   cached track per direction that passes both filters.

   Request body:
     {
       "specs": [
         { "rank": 1, "genre": "Jazz (Standards)", "bpm_lo": 80, "bpm_hi": 110 },
         ...
       ],
       "popularity": [lo, hi]      // optional; defaults to [0, 100]
     }

   Response:
     { "byRank": { "1": "<spotify_id>", "2": "...", ... } }

   - Directions whose anchor pool has no track passing BPM + popularity are
     absent from byRank. The caller drops those directions from the preview.
   - Keyed by rank so directions with the same anchor genre still get
     distinct preview tracks.
*/

import { pgrRpc } from './supabase-client.js';

function intRange(param, dfltLo, dfltHi) {
  if (Array.isArray(param) && param.length === 2 && param.every((v) => Number.isFinite(v))) {
    return [Math.round(param[0]), Math.round(param[1])];
  }
  return [dfltLo, dfltHi];
}

function validateSpec(s) {
  return s
      && Number.isFinite(s.rank)
      && typeof s.genre === 'string' && s.genre.length
      && Number.isFinite(s.bpm_lo)
      && Number.isFinite(s.bpm_hi)
      && s.bpm_lo <= s.bpm_hi;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { specs, popularity } = req.body || {};
    if (!Array.isArray(specs) || !specs.length) {
      return res.status(400).json({ error: 'specs required (non-empty array)' });
    }
    const clean = specs.filter(validateSpec).map((s) => ({
      rank:   Math.round(s.rank),
      genre:  s.genre,
      bpm_lo: Math.floor(s.bpm_lo),
      bpm_hi: Math.ceil(s.bpm_hi),
      // Optional per-spec instrumentalness preference (added 2026-08-21).
      // 'hard' = strict WHERE, 'soft' = ORDER BY bias, 'none' = unfiltered.
      // Anything unrecognized collapses to 'none' in the RPC.
      inst_pref: (s.inst_pref === 'hard' || s.inst_pref === 'soft') ? s.inst_pref : 'none',
    }));
    if (!clean.length) {
      return res.status(400).json({ error: 'no valid specs after validation' });
    }

    const [pop_lo, pop_hi] = intRange(popularity, 0, 100);

    const rows = await pgrRpc('v5_anchor_tracks', {
      p_specs:  clean,
      p_pop_lo: pop_lo,
      p_pop_hi: pop_hi,
    });

    const byRank = {};
    for (const r of (rows || [])) byRank[String(r.rank)] = r.spotify_id;
    return res.status(200).json({ byRank });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
