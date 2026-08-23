/* /api/v4/ami-track-delete.js
   POST /api/v4/ami-track-delete
   Body: { spotifyId: "..." }

   Archives every trace of a Spotify track (its track_analyses row + all
   playlist_tracks rows) into the `deleted_tracks` table, then removes the
   live rows. Fully reversible via /api/v4/ami-track-restore for as long as
   the archive row exists.

   Fetches title + artist from Spotify separately so the archive is
   human-inspectable even if Spotify later removes the track from their
   catalog. All writes go through service_role.
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

        // 1. Resolve the market-canonical ID via Spotify relinking (market=IL
        //    matches our scan), then snapshot the live state under that ID.
        //    The dashboard passes the already-resolved ID from ami-track-lookup,
        //    so this is a no-op in the normal flow — but it makes direct API
        //    calls with a Spotify-app "copy link" ID work correctly too.
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
        const title   = spotifyData?.name || '(unknown)';
        const artists = (spotifyData?.artists || []).map((a) => a.name);

        const [analysisRows, playlistTracksRows] = await Promise.all([
            pgrSelect('track_analyses',  { spotify_id: `eq.${canonicalId}` }, { limit: 1 }),
            pgrSelect('playlist_tracks', { spotify_id: `eq.${canonicalId}` }, {}),
        ]);
        const analysisRow = (analysisRows && analysisRows[0]) || null;
        const ptRows      = playlistTracksRows || [];

        if (!analysisRow && ptRows.length === 0) {
            return res.status(404).json({
                error: 'Track not found in playlist_tracks or track_analyses — nothing to delete.',
                spotifyId: canonicalId,
                inputSpotifyId: spotifyId,
            });
        }

        // 2. Archive. Upsert so a repeat delete (post-restore) overwrites the
        //    previous archive rather than crashing on the PK.
        await pgrUpsert('deleted_tracks', [{
            spotify_id:           canonicalId,
            title,
            artist:               artists.join(', '),
            track_analyses_row:   analysisRow,
            playlist_tracks_rows: ptRows,
            deleted_at:           new Date().toISOString(),
        }]);

        // 3. Remove from the live tables.
        //    playlist_tracks first — track_analyses is the harder-to-recompute
        //    one (RapidAPI costs), and if the playlist_tracks delete fails, we
        //    haven't touched the audio-features cache yet.
        if (ptRows.length) {
            await pgrDelete('playlist_tracks', { spotify_id: `eq.${canonicalId}` });
        }
        if (analysisRow) {
            await pgrDelete('track_analyses', { spotify_id: `eq.${canonicalId}` });
        }

        return res.status(200).json({
            ok: true,
            spotifyId:      canonicalId,
            inputSpotifyId: spotifyId,
            title,
            artists,
            playlistTracksDeleted: ptRows.length,
            trackAnalysesDeleted:  analysisRow ? 1 : 0,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
