/* /api/v4/ami-playlist-lookup.js
   POST /api/v4/ami-playlist-lookup
   Body: { input: "<spotify id, URL, or URI>" }

   Sibling of /api/v4/ami-track-lookup — same shape, playlist edition.
   Parses a Spotify playlist ID out of the input, fetches name + owner +
   Spotify-side track count (best-effort — 404 fine if Spotify has removed
   the playlist), and reports the DB state: how many playlist_genres rows,
   how many playlist_tracks rows, distinct genres list, and how many of
   those tracks currently have a track_analyses row (useful signal for
   Ami before deciding to delete).

   Accepted input shapes:
     - Bare 22-char playlist ID       37i9dQZF1DXcBWIGoYBM5M
     - Playlist URL                   https://open.spotify.com/playlist/{id}?si=...
     - Locale-prefixed URL            https://open.spotify.com/intl-he/playlist/{id}
     - Embed URL                      https://open.spotify.com/embed/playlist/{id}
     - Playlist URI                   spotify:playlist:{id}
     - Mobile share short link        https://open.spotify.com/s/{shortcode}
       (iOS/Android Spotify app — resolved via HTTP redirect follow)

   Non-playlist share links (track/album/artist/etc.) are detected and
   rejected with a helpful error so Ami knows to share the playlist link.
*/

import { pgrSelect, pgrSelectIn } from './supabase-client.js';

async function unshortenSpotifyLink(input) {
    const s = String(input || '').trim();
    if (!/^https?:\/\/open\.spotify\.com\/s\//i.test(s)) return s;
    try {
        const r = await fetch(s, {
            method:   'GET',
            redirect: 'follow',
            headers:  {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            },
        });
        return r.url || s;
    } catch {
        return s;
    }
}

// Same parser as ami-track-lookup — accepts any Spotify resource shape.
// Bare 22-char IDs default to `playlist` here (this is the playlist tool).
function extractSpotifyResource(input) {
    if (!input) return null;
    const s = String(input).trim();

    let m = s.match(/^spotify:(track|album|artist|playlist|episode|show):([a-zA-Z0-9]{22})\b/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2] };

    m = s.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(track|album|artist|playlist|episode|show)\/([a-zA-Z0-9]{22})\b/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2] };

    m = s.match(/^([a-zA-Z0-9]{22})$/);
    if (m) return { type: 'playlist', id: m[1] };

    return null;
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

        const resolvedInput = await unshortenSpotifyLink(input);
        const resource      = extractSpotifyResource(resolvedInput);
        if (!resource) {
            return res.status(400).json({ error: 'Could not parse a Spotify ID or URL. Paste a playlist share link, a 22-char playlist ID, or a spotify:playlist:... URI.' });
        }
        if (resource.type !== 'playlist') {
            const article = /^[aeiou]/.test(resource.type) ? 'an' : 'a';
            return res.status(400).json({
                error: `That's ${article} ${resource.type} link, not a playlist. Open the specific playlist in Spotify and share its link instead.`,
            });
        }
        const playlistId = resource.id;

        // Spotify metadata — best-effort. If the playlist has been deleted
        // from Spotify's side, we still want Ami to be able to clean the DB
        // record, so a 404 here is fine; we just report unknown metadata.
        // x-sonic-internal to satisfy /api/v4/spotify's requireSiteOrInternal.
        let spotifyMeta = null;
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
                spotifyMeta = {
                    name:          spotifyData?.name || null,
                    owner:         spotifyData?.owner?.display_name || null,
                    spotifyTotal:  spotifyData?.tracks?.total ?? null,
                };
            }
            // Non-OK responses (404 / 400) are non-fatal — spotifyMeta stays null.
        } catch {
            // Swallow — DB-only lookup still works.
        }

        // DB state.
        const [genreRows, trackRows] = await Promise.all([
            pgrSelect('playlist_genres', { playlist_id: `eq.${playlistId}` }, { select: 'genre,position_in_genre' }),
            pgrSelect('playlist_tracks', { playlist_id: `eq.${playlistId}` }, { select: 'spotify_id,position' }),
        ]);

        const spotifyIds = (trackRows || []).map((r) => r.spotify_id).filter(Boolean);
        const genres     = Array.from(new Set((genreRows || []).map((r) => r.genre))).sort();

        // How many of the playlist's tracks are analyzed? Chunk via
        // pgrSelectIn so a big playlist doesn't blow the URL length limit.
        let analyzedCount = 0;
        if (spotifyIds.length) {
            const analyzedRows = await pgrSelectIn('track_analyses', 'spotify_id', spotifyIds, { select: 'spotify_id' });
            analyzedCount = (analyzedRows || []).length;
        }

        return res.status(200).json({
            playlistId,
            name:                spotifyMeta?.name || null,
            owner:               spotifyMeta?.owner || null,
            spotifyTotal:        spotifyMeta?.spotifyTotal ?? null,
            spotifyMissing:      spotifyMeta === null,   // true if Spotify said 404 / call failed
            playlistGenresCount: (genreRows || []).length,
            playlistTracksCount: spotifyIds.length,
            analyzedCount,
            genres,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
