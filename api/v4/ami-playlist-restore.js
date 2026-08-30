/* /api/v4/ami-playlist-restore.js
   POST /api/v4/ami-playlist-restore
   Body: { playlistId: "..." }

   Reverses a delete performed by /api/v4/ami-playlist-delete. Reads the
   archive row from `deleted_playlists`, re-inserts every original
   playlist_genres + playlist_tracks row, then drops the archive row so
   the same playlist can be safely deleted again later.

   Invoked either by the dashboard's Undo button or manually by Roni via
   a direct curl.
*/

import { pgrSelect, pgrUpsert, pgrDelete } from './supabase-client.js';

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

        // useService: true — deleted_playlists has RLS on with NO anon read
        // policy (dashboard-only via service_role, per the migration). Without
        // this flag the pgrSelect goes out as anon and always returns [] →
        // false "no archive" 404 even when the row exists.
        const archiveRows = await pgrSelect('deleted_playlists',
            { playlist_id: `eq.${playlistId}` },
            { limit: 1, useService: true },
        );
        if (!archiveRows.length) {
            return res.status(404).json({
                error: 'No archived row for this playlist_id (not previously deleted, or already restored).',
                playlistId,
            });
        }
        const archive = archiveRows[0];

        // 1. Restore playlist_genres.
        const genreRows = Array.isArray(archive.playlist_genres_rows) ? archive.playlist_genres_rows : [];
        if (genreRows.length) {
            await pgrUpsert('playlist_genres', genreRows);
        }

        // 2. Restore playlist_tracks.
        const trackRows = Array.isArray(archive.playlist_tracks_rows) ? archive.playlist_tracks_rows : [];
        if (trackRows.length) {
            await pgrUpsert('playlist_tracks', trackRows);
        }

        // 3. Drop the archive row — restore is one-shot.
        await pgrDelete('deleted_playlists', { playlist_id: `eq.${playlistId}` });

        return res.status(200).json({
            ok: true,
            playlistId,
            name:                   archive.name || null,
            owner:                  archive.owner || null,
            playlistGenresRestored: genreRows.length,
            playlistTracksRestored: trackRows.length,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
