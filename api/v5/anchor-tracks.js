/* /api/v5/anchor-tracks.js
   v5 direction preview source. Given per-direction specs (rank + anchor
   genre + BPM range + optional inst_pref/pop_pref), returns one random
   cached track per direction that matches.

   Request body:
     {
       "specs": [
         { "rank": 1, "genre": "Jazz (Standards)", "bpm_lo": 80, "bpm_hi": 110,
           "inst_pref": "none"|"soft"|"hard",     // optional
           "pop_pref":  "none"|"soft"|"hard"      // optional; 'hard' → [60,100]
         },
         ...
       ]
     }

   Response:
     { "byRank": { "1": "<spotify_id>", "2": "...", ... } }

   - Directions whose anchor pool has no matching track are absent from
     byRank. The caller drops those directions from the preview.
   - Keyed by rank so directions with the same anchor genre still get
     distinct preview tracks.
   - Popularity filter is applied entirely per-spec via pop_pref. The
     atmosphere-derived popularity window (top-level `popularity` param)
     was removed 2026-09-02; the RPC now always receives [0, 100] and
     each spec's pop_pref narrows/biases from there.
*/

import { pgrRpc } from './supabase-client.js';
import { requireSite, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';

function validateSpec(s) {
  return s
      && Number.isFinite(s.rank)
      && typeof s.genre === 'string' && s.genre.length
      && Number.isFinite(s.bpm_lo)
      && Number.isFinite(s.bpm_hi)
      && s.bpm_lo <= s.bpm_hi;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'anchor-tracks', 60, 60)) return;

  try {
    const { specs } = req.body || {};
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
      // Optional per-spec popularity preference (added 2026-09-02). Same
      // three-state shape as inst_pref but with a twist: 'hard' OVERRIDES
      // the effective popularity window to [60,100] regardless of the
      // shared popularity param. 'soft' keeps the shared window in WHERE
      // and adds an ORDER BY bias so hits (popularity >= 60) surface first.
      pop_pref:  (s.pop_pref  === 'hard' || s.pop_pref  === 'soft') ? s.pop_pref  : 'none',
    }));
    if (!clean.length) {
      return res.status(400).json({ error: 'no valid specs after validation' });
    }

    // Popularity window fixed at [0, 100] since 2026-09-02 (atmosphere-derived
    // window removed). Per-spec pop_pref='hard' overrides to [60,100] inside
    // the RPC; 'soft' biases via ORDER BY.
    const rows = await pgrRpc('v5_anchor_tracks', {
      p_specs:  clean,
      p_pop_lo: 0,
      p_pop_hi: 100,
    });

    const byRank = {};
    for (const r of (rows || [])) byRank[String(r.rank)] = r.spotify_id;
    return res.status(200).json({ byRank });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
