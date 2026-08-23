/* /api/v4/ami-track-restore.js
   POST /api/v4/ami-track-restore
   Body: { spotifyId: "..." }

   Reverses a delete performed by /api/v4/ami-track-delete. Reads the
   archive row from `deleted_tracks`, re-inserts the original track_analyses
   row (if there was one) and every original playlist_tracks row, then
   drops the archive row so the same track can be safely deleted again.

   Invoked either by the dashboard's Undo button or manually by Roni via a
   direct curl to this endpoint if he wants to restore something later.
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
        const { spotifyId } = req.body || {};
        if (!spotifyId || !/^[a-zA-Z0-9]{22}$/.test(spotifyId)) {
            return res.status(400).json({ error: 'spotifyId (22-char alphanumeric) required' });
        }

        // Resolve the market-canonical ID via Spotify relinking (see the same
        // note in ami-track-delete). Archive rows are always keyed by the
        // canonical ID because delete writes them under that ID.
        const spotifyRes = await fetch(sameOriginUrl(req, '/api/v4/spotify'), {
            method:  'POST',
            headers: {
                'Content-Type':     'application/json',
                'x-sonic-internal': process.env.INTERNAL_API_KEY || '',
            },
            body:    JSON.stringify({ action: 'get_track', track_id: spotifyId, market: 'IL' }),
        });
        const spotifyData = await spotifyRes.json().catch(() => ({}));
        const canonicalId = spotifyData?.id || spotifyId;

        const archiveRows = await pgrSelect('deleted_tracks',
            { spotify_id: `eq.${canonicalId}` },
            { limit: 1 },
        );
        if (!archiveRows.length) {
            return res.status(404).json({
                error: 'No archived row for this spotify_id (not previously deleted, or already restored).',
                spotifyId: canonicalId,
                inputSpotifyId: spotifyId,
            });
        }
        const archive = archiveRows[0];

        // 1. Restore track_analyses (if there was one).
        let trackAnalysesRestored = 0;
        if (archive.track_analyses_row && typeof archive.track_analyses_row === 'object') {
            await pgrUpsert('track_analyses', [archive.track_analyses_row]);
            trackAnalysesRestored = 1;
        }

        // 2. Restore all playlist_tracks rows.
        const ptRows = Array.isArray(archive.playlist_tracks_rows) ? archive.playlist_tracks_rows : [];
        if (ptRows.length) {
            await pgrUpsert('playlist_tracks', ptRows);
        }

        // 3. Drop the archive row — restore is one-shot.
        await pgrDelete('deleted_tracks', { spotify_id: `eq.${canonicalId}` });

        return res.status(200).json({
            ok: true,
            spotifyId:      canonicalId,
            inputSpotifyId: spotifyId,
            title:   archive.title || null,
            artists: archive.artist ? archive.artist.split(', ') : [],
            playlistTracksRestored: ptRows.length,
            trackAnalysesRestored,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
