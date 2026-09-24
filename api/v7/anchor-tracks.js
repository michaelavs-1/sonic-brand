/* /api/v7/anchor-tracks.js
   v7's swipe-deck preview source: one random cached track per card.

     POST { "specs": [ { rank, genre, inst_pref?, pop_pref? }, ... ] }
     →    { "byRank": { "1": "<spotify_id>", ... } }

   Calls the v7_anchor_tracks RPC (migration
   v5/precompute/migrations/2026-09-24-v7-anchor-tracks.sql), which samples a
   few random playlists of the genre and picks one track from them — bounded
   work, no tempo parameter (v7 has no BPM). v6 keeps using its own
   /api/v5/anchor-tracks → v5_anchor_tracks, untouched.

   - Ranks whose genre pool yields nothing are absent from byRank; the caller
     drops those cards.
   - Keyed by rank so directions sharing a genre still get distinct tracks.
   - inst_pref / pop_pref: 'none' | 'soft' | 'hard', same semantics as v5.
*/

import { pgrRpc } from '../v5/supabase-client.js';
import { requireSite, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';

const PREF = (p) => (p === 'hard' || p === 'soft') ? p : 'none';

function validateSpec(s) {
  return s
      && Number.isFinite(s.rank)
      && typeof s.genre === 'string' && s.genre.length;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  // Same bucket as v5's anchor-tracks so a client can't double its per-IP
  // allowance by alternating between the two endpoints.
  if (!await guard(req, res, 'anchor-tracks', 60, 60)) return;

  try {
    const { specs } = req.body || {};
    if (!Array.isArray(specs) || !specs.length) {
      return res.status(400).json({ error: 'specs required (non-empty array)' });
    }
    const clean = specs.filter(validateSpec).map((s) => ({
      rank:      Math.round(s.rank),
      genre:     s.genre,
      inst_pref: PREF(s.inst_pref),
      pop_pref:  PREF(s.pop_pref),
    }));
    if (!clean.length) {
      return res.status(400).json({ error: 'no valid specs after validation' });
    }

    const rows = await pgrRpc('v7_anchor_tracks', { p_specs: clean });

    const byRank = {};
    for (const r of (rows || [])) byRank[String(r.rank)] = r.spotify_id;
    return res.status(200).json({ byRank });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
