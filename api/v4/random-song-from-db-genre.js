/* /api/v4/random-song-from-db-genre.js
   Backs the /v4/random-song-from-db-genre page.

   Actions (POST body):
     { action: 'list_genres' }
       → { genres: [...sorted distinct genres] }
     { action: 'random_track', genre: '<genre>' }
       → { spotify_id, genre, pool_size }
       (404 if no tracks exist for that genre)

   Random pick reuses the `cached_playlist` RPC with the genre placed in the
   relaxed bucket and energy/dance/pop windows wide-open, then takes the first
   row — the RPC already does ORDER BY random() server-side.
*/

import { pgrSelect, pgrRpc } from './supabase-client.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action, genre } = req.body || {};

    try {
        if (action === 'list_genres') {
            const rows = await pgrSelect('playlist_genres', {}, { select: 'genre' });
            const set = new Set();
            for (const r of rows || []) {
                const g = (r?.genre || '').trim();
                if (g) set.add(g);
            }
            const genres = [...set].sort((a, b) => a.localeCompare(b));
            return res.status(200).json({ genres });
        }

        if (action === 'random_track') {
            const g = (genre || '').trim();
            if (!g) return res.status(400).json({ error: 'genre is required' });

            const rows = await pgrRpc('cached_playlist', {
                p_strict_genres: [],
                p_relaxed_genres: [g],
                p_energy_lo: 0, p_energy_hi: 100,
                p_dance_lo: 0, p_dance_hi: 100,
                p_pop_lo: 0, p_pop_hi: 100,
                p_per_genre: 1,
            });

            const row = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!row?.spotify_id) {
                return res.status(404).json({ error: 'no tracks found for that genre', genre: g });
            }
            return res.status(200).json({ spotify_id: row.spotify_id, genre: g });
        }

        return res.status(400).json({ error: 'unknown action' });
    } catch (err) {
        console.error('[random-song-from-db-genre] failed:', err.message);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
