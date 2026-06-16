/* /api/v4/cached-playlist.js
   v4 final-playlist source. Returns a random screened track sample for each
   of the desired genres, drawn from the Supabase cache (playlist_genres ⋈
   playlist_tracks ⋈ track_analyses).

   Two genre lists:
   - strict_genres:  filtered by energy/danceability/popularity windows
                     (tracks outside the windows are excluded entirely).
   - relaxed_genres: NOT filtered by the screen — any cached `ok` track from
                     the genre is fair game. Use when the user explicitly
                     picked an unscreened preview from a genre (i.e. they
                     want that genre even though no track from it passed
                     the atmosphere filter).

   Request body:
     {
       "strict_genres":  ["jazz", ...],
       "relaxed_genres": ["punk", ...],
       "screen_params": {
         "energy":       [lo, hi],   // each optional; missing ⇒ [0, 100]
         "danceability": [lo, hi],
         "popularity":   [lo, hi]
       },
       "per_genre": 200               // optional cap; defaults to 200
     }

   Response:
     {
       "tracksByGenre": { "<genre>": ["<spotify_id>", ...], ... }
     }

   Notes:
   - Genres absent from the cache (or with zero matching candidates) appear
     as empty arrays so the caller knows the genre was attempted.
   - The caller (v4/generation/playlist-builder.js) does equal-as-possible
     balancing + redistribution and the final shuffle + 40-track trim.
*/

import { pgrRpc } from './supabase-client.js';

function range(param) {
  if (Array.isArray(param) && param.length === 2 && param.every((v) => Number.isFinite(v))) {
    return [Math.round(param[0]), Math.round(param[1])];
  }
  return [0, 100];
}

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

function uniqNormalized(arr) {
  const seen = new Set();
  const out  = [];
  for (const g of arr || []) {
    const n = normalize(g);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { strict_genres, relaxed_genres, screen_params, per_genre } = req.body || {};

    const strictNorm  = uniqNormalized(Array.isArray(strict_genres)  ? strict_genres  : []);
    const relaxedSet  = new Set(uniqNormalized(Array.isArray(relaxed_genres) ? relaxed_genres : []));
    // If a genre somehow shows up in both lists, relaxed wins (broader).
    const strictFinal  = strictNorm.filter((g) => !relaxedSet.has(g));
    const relaxedFinal = [...relaxedSet];

    if (!strictFinal.length && !relaxedFinal.length) {
      return res.status(400).json({ error: 'at least one genre required (strict_genres or relaxed_genres)' });
    }

    const sp = screen_params || {};
    const [e_lo, e_hi] = range(sp.energy);
    const [d_lo, d_hi] = range(sp.danceability);
    const [p_lo, p_hi] = range(sp.popularity);

    const cap = Number.isFinite(per_genre) && per_genre > 0 ? Math.min(Math.round(per_genre), 500) : 200;

    const rows = await pgrRpc('cached_playlist', {
      p_strict_genres:  strictFinal,
      p_relaxed_genres: relaxedFinal,
      p_energy_lo: e_lo, p_energy_hi: e_hi,
      p_dance_lo:  d_lo, p_dance_hi:  d_hi,
      p_pop_lo:    p_lo, p_pop_hi:    p_hi,
      p_per_genre: cap,
    });

    const tracksByGenre = {};
    for (const g of strictFinal)  tracksByGenre[g] = [];
    for (const g of relaxedFinal) tracksByGenre[g] = [];
    for (const r of (rows || [])) {
      if (tracksByGenre[r.genre]) tracksByGenre[r.genre].push(r.spotify_id);
    }

    const empties = [...strictFinal, ...relaxedFinal].filter((g) => !tracksByGenre[g].length);
    if (empties.length) {
      console.log(`[cached-playlist] no tracks for: ${empties.join(', ')}`);
    }

    return res.status(200).json({ tracksByGenre });
  } catch (err) {
    console.error('[cached-playlist] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
