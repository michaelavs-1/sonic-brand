/* /api/v4/cached-preview.js
   v4 preview backed by the Supabase cache. Single endpoint that returns one
   track per genre for both column G and column H of the matched biz type,
   filtered by the user's atmosphere-derived screen params.

   Request body:
     {
       "business_type": "בית קפה",
       "screen_params": {
         "energy":       [lo, hi],   // 0–100 each; any of these is optional
         "danceability": [lo, hi],
         "popularity":   [lo, hi]
       }
     }

   Response:
     {
       "G": [{ genre, position, trackId, matched_screen }, ...],
       "H": [{ genre, position, trackId, matched_screen }, ...]
     }

   - matched_screen=false means no track from that genre fell inside the
     atmosphere windows, so any track from the genre was selected. The proxy
     logs that case to the Vercel function console.
   - Genres with zero tracks at all are absent from the response array.
   - Uncached biz_type yields { G: [], H: [] }.
*/

import { pgrRpc } from './supabase-client.js';

// Defaults for missing windows: the SQL function takes mandatory ints, so we
// expand any missing param to its full 0–100 range (effectively "no filter").
function range(param) {
    if (Array.isArray(param) && param.length === 2 && param.every((v) => Number.isFinite(v))) {
        return [Math.round(param[0]), Math.round(param[1])];
    }
    return [0, 100];
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { business_type, screen_params } = req.body || {};
        if (!business_type || typeof business_type !== 'string') {
            return res.status(400).json({ error: 'business_type required (string)' });
        }
        const sp = screen_params || {};
        const [e_lo, e_hi] = range(sp.energy);
        const [d_lo, d_hi] = range(sp.danceability);
        const [p_lo, p_hi] = range(sp.popularity);

        const rows = await pgrRpc('cached_preview', {
            p_business_type: business_type,
            p_energy_lo:     e_lo, p_energy_hi: e_hi,
            p_dance_lo:      d_lo, p_dance_hi:  d_hi,
            p_pop_lo:        p_lo, p_pop_hi:    p_hi,
        });

        const G = [];
        const H = [];
        for (const r of (rows || [])) {
            const card = {
                genre:          r.genre,
                position:       r.position_in_column,
                trackId:        r.spotify_id,
                matched_screen: r.matched_screen,
            };
            if (!card.matched_screen) {
                console.log(`[cached-preview] no track from genre "${card.genre}" passed atmospheric screening, selecting track`);
            }
            (r.column_letter === 'G' ? G : H).push(card);
        }

        return res.status(200).json({ G, H });
    } catch (err) {
        console.error('[cached-preview] failed:', err.message);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
