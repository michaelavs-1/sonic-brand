/* /api/v4/ami-playlist-delete.js
   POST /api/v4/ami-playlist-delete
   Body: { playlistId: "..." }

   Archives every trace of a playlist (its playlist_genres rows + all
   playlist_tracks rows) into the `deleted_playlists` table, then removes
   the live rows. Fully reversible via /api/v4/ami-playlist-restore.

   Does NOT touch track_analyses — the audio-features cache for the
   tracks inside this playlist is shared with any other playlists they
   also live in, and is expensive to rebuild via RapidAPI. Ami can delete
   individual tracks via /api/v4/ami-track-delete if she wants.

   Best-effort fetches name + owner from Spotify so the archive stays
   human-inspectable even if Spotify later removes the playlist. All
   writes go through service_role.
*/

import { pgrSelect, pgrUpsert, pgrDelete } from './supabase-client.js';

function sameOriginUrl(req, pathname) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${proto}://${host}${pathname}`;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { playlistId } = req.body || {};
        if (!playlistId || !/^[a-zA-Z0-9]{22}$/.test(playlistId)) {
            return res.status(400).json({ error: 'playlistId (22-char alphanumeric) required' });
        }

        // 1. Snapshot both mapping tables under this playlist_id.
        const [genreRows, trackRows] = await Promise.all([
            pgrSelect('playlist_genres', { playlist_id: `eq.${playlistId}` }, {}),
            pgrSelect('playlist_tracks', { playlist_id: `eq.${playlistId}` }, {}),
        ]);

        if ((genreRows || []).length === 0 && (trackRows || []).length === 0) {
            return res.status(404).json({
                error: 'Playlist not found in playlist_genres or playlist_tracks — nothing to delete.',
                playlistId,
            });
        }

        // Best-effort Spotify metadata (non-fatal — the DB delete goes through
        // even if Spotify has removed the playlist). Fetched AFTER the snapshot
        // so a slow / hung Spotify call doesn't delay the DB read.
        let name = null;
        let owner = null;
        try {
            const spotifyRes = await fetch(sameOriginUrl(req, '/api/v4/spotify'), {
                method:  'POST',
                headers: {
                    'Content-Type':     'application/json',
                    'x-sonic-internal': process.env.INTERNAL_API_KEY || '',
                },
                body:    JSON.stringify({ action: 'get_playlist', playlist_id: playlistId }),
            });
            const spotifyData = await spotifyRes.json().catch(() => ({}));
            if (spotifyRes.ok) {
                name  = spotifyData?.name || null;
                owner = spotifyData?.owner?.display_name || null;
            }
        } catch {
            // Non-fatal — archive without the metadata.
        }

        // 2. Archive. Upsert so a repeat delete (post-restore) overwrites the
        //    previous archive instead of crashing on the PK.
        await pgrUpsert('deleted_playlists', [{
            playlist_id:          playlistId,
            name,
            owner,
            playlist_genres_rows: genreRows || [],
            playlist_tracks_rows: trackRows || [],
            deleted_at:           new Date().toISOString(),
        }]);

        // 3. Hard delete from the live tables.
        //    Order doesn't strictly matter (no FK between them), but do
        //    playlist_tracks first because it's usually the larger table
        //    and is what the runtime pipeline reads more often.
        if ((trackRows || []).length) {
            await pgrDelete('playlist_tracks', { playlist_id: `eq.${playlistId}` });
        }
        if ((genreRows || []).length) {
            await pgrDelete('playlist_genres', { playlist_id: `eq.${playlistId}` });
        }

        return res.status(200).json({
            ok: true,
            playlistId,
            name,
            owner,
            playlistTracksDeleted: (trackRows || []).length,
            playlistGenresDeleted: (genreRows || []).length,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
