/* /api/v4/ami-track-lookup.js
   POST /api/v4/ami-track-lookup
   Body: { input: "<spotify id, URL, or URI>" }

   Parses a Spotify track ID out of the input (accepts a raw 22-char ID, a
   full open.spotify.com/track/... URL, or a spotify:track:... URI), fetches
   title + artist from Spotify (via the existing /api/v4/spotify get_track
   action), and reports whether the track is present in playlist_tracks
   and/or track_analyses. Used by the dashboard's "Track cleanup" input to
   populate the pre-delete confirmation card.

   Spotify's track-relinking is applied by asking Spotify for the track with
   market='IL' (matching what our scan uses). The market-canonical `id` in
   the response is what we compare against the DB — otherwise pasting a
   Spotify-app "copy link" ID would miss the row we stored under the relinked
   ID. The response's `spotifyId` field is always the canonical ID, so the
   dashboard's downstream delete/undo/re-lookup calls use the right key.
*/

import { pgrSelect, pgrCount } from './supabase-client.js';

// Spotify track IDs are exactly 22 alphanumeric characters. This regex
// matches them inside a URL, URI, or bare form.
function extractSpotifyId(input) {
    if (!input) return null;
    const m = String(input).match(/([a-zA-Z0-9]{22})/);
    return m ? m[1] : null;
}

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
        const { input } = req.body || {};
        const spotifyId = extractSpotifyId(input);
        if (!spotifyId) {
            return res.status(400).json({ error: 'Invalid Spotify track ID or URL. Expected a 22-char ID, an open.spotify.com/track/... URL, or a spotify:track:... URI.' });
        }

        // Serialize Spotify → DB: the DB queries need the market-canonical ID
        // that Spotify returns (relinking), so we can't parallelize them.
        const spotifyRes = await fetch(sameOriginUrl(req, '/api/v4/spotify'), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ action: 'get_track', track_id: spotifyId, market: 'IL' }),
        });
        const spotifyData = await spotifyRes.json().catch(() => ({}));
        if (!spotifyRes.ok) {
            const msg = spotifyData?.error?.message || spotifyData?.error || `Spotify lookup failed: HTTP ${spotifyRes.status}`;
            return res.status(400).json({ error: msg, spotifyId });
        }

        const canonicalId = spotifyData?.id || spotifyId;

        const [playlistCount, analysisRows] = await Promise.all([
            pgrCount('playlist_tracks', { spotify_id: `eq.${canonicalId}` }),
            pgrSelect('track_analyses', { spotify_id: `eq.${canonicalId}` }, { select: 'spotify_id', limit: 1 }),
        ]);

        return res.status(200).json({
            spotifyId:       canonicalId,
            inputSpotifyId:  spotifyId,
            title:           spotifyData?.name || '(unknown)',
            artists:         (spotifyData?.artists || []).map((a) => a.name),
            inPlaylistCount: playlistCount || 0,
            hasAnalysis:     (analysisRows || []).length > 0,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
