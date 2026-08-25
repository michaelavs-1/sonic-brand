/* /api/v4/ami-track-lookup.js
   POST /api/v4/ami-track-lookup
   Body: { input: "<spotify id, URL, or URI>" }

   Parses a Spotify track ID out of the input, fetches title + artist from
   Spotify (via the existing /api/v4/spotify get_track action), and reports
   whether the track is present in playlist_tracks and/or track_analyses.
   Used by the dashboard's "Track cleanup" input to populate the pre-delete
   confirmation card.

   Accepted input shapes:
     - Bare 22-char track ID           7DtbrNlYifGnJc7HY0fS9i
     - Track URL                       https://open.spotify.com/track/{id}?si=...
     - Locale-prefixed track URL       https://open.spotify.com/intl-he/track/{id}
     - Embed track URL                 https://open.spotify.com/embed/track/{id}
     - Track URI                       spotify:track:{id}
     - Mobile "share > copy link"      https://open.spotify.com/s/{shortcode}
       (iOS/Android's Spotify app hands out these short links — resolved
       server-side via HTTP redirect follow to the canonical /track/... URL)

   Non-track share links (album/artist/playlist/episode/show) are detected
   and rejected with a helpful error so Ami knows to share the individual
   track's link instead.

   Spotify's track-relinking is applied by asking Spotify for the track with
   market='IL' (matching what our scan uses). The market-canonical `id` in
   the response is what we compare against the DB — otherwise pasting a
   Spotify-app "copy link" ID would miss the row we stored under the relinked
   ID. The response's `spotifyId` field is always the canonical ID, so the
   dashboard's downstream delete/undo/re-lookup calls use the right key.
*/

import { pgrSelect, pgrSelectIn } from './supabase-client.js';

// Spotify's mobile share button (iOS + Android) hands out short links like
// https://open.spotify.com/s/{shortcode}. The shortcode is NOT a 22-char
// resource ID — it needs an HTTP redirect follow to resolve to the canonical
// /track/... URL. Default fetch UA is blocked/handled differently by
// Spotify's short-link service (curl-tested — 0 redirects with default UA,
// 3 redirects with a browser UA), so we send a mobile Safari UA.
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
        // Fall through — the extractor will fail with a helpful error.
        return s;
    }
}

// Recognizes: spotify:{type}:{id} URIs, open.spotify.com/[intl-xx/][embed/]
// {type}/{22id} URLs, and bare 22-char IDs. Returns { type, id } or null.
// Bare IDs are assumed to be tracks (backward-compat — Ami sometimes pastes
// just the ID from another dashboard, and pre-refactor callers did the same).
function extractSpotifyResource(input) {
    if (!input) return null;
    const s = String(input).trim();

    let m = s.match(/^spotify:(track|album|artist|playlist|episode|show):([a-zA-Z0-9]{22})\b/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2] };

    m = s.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(track|album|artist|playlist|episode|show)\/([a-zA-Z0-9]{22})\b/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2] };

    m = s.match(/^([a-zA-Z0-9]{22})$/);
    if (m) return { type: 'track', id: m[1] };

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

        // Resolve short mobile share links to their canonical URL first, then
        // extract {type, id}. Two failure modes we handle explicitly:
        //   1. /s/{shortcode} mobile share link — needs redirect follow.
        //   2. Non-track share link (album/artist/playlist/etc.) — the 22-char
        //      ID inside would previously be parsed as a track ID and the
        //      downstream get_track would 400 with an unhelpful error.
        const resolvedInput = await unshortenSpotifyLink(input);
        const resource      = extractSpotifyResource(resolvedInput);
        if (!resource) {
            return res.status(400).json({ error: 'Could not parse a Spotify ID or URL. Paste a track share link, a 22-char track ID, or a spotify:track:... URI.' });
        }
        if (resource.type !== 'track') {
            const article = /^[aeiou]/.test(resource.type) ? 'an' : 'a';
            return res.status(400).json({
                error: `That's ${article} ${resource.type} link, not a track. Open the specific track in Spotify and share its link instead.`,
            });
        }
        const spotifyId = resource.id;

        // Serialize Spotify → DB: the DB queries need the market-canonical ID
        // that Spotify returns (relinking), so we can't parallelize them.
        // x-sonic-internal: /api/v4/spotify is guarded by requireSiteOrInternal
        // — server-to-server calls from another Vercel function carry no
        // Origin header, so we pass the shared secret to satisfy the guard.
        const spotifyRes = await fetch(sameOriginUrl(req, '/api/v4/spotify'), {
            method:  'POST',
            headers: {
                'Content-Type':     'application/json',
                'x-sonic-internal': process.env.INTERNAL_API_KEY || '',
            },
            body:    JSON.stringify({ action: 'get_track', track_id: spotifyId, market: 'IL' }),
        });
        const spotifyData = await spotifyRes.json().catch(() => ({}));
        if (!spotifyRes.ok) {
            const msg = spotifyData?.error?.message || spotifyData?.error || `Spotify lookup failed: HTTP ${spotifyRes.status}`;
            return res.status(400).json({ error: msg, spotifyId });
        }

        const canonicalId = spotifyData?.id || spotifyId;

        const [playlistTrackRows, analysisRows] = await Promise.all([
            pgrSelect('playlist_tracks', { spotify_id: `eq.${canonicalId}` }, { select: 'playlist_id' }),
            pgrSelect('track_analyses', { spotify_id: `eq.${canonicalId}` }, { select: 'spotify_id', limit: 1 }),
        ]);

        const playlistIds = Array.from(new Set((playlistTrackRows || []).map((r) => r.playlist_id))).sort();

        // Genres this track is associated with = distinct genres of every
        // playlist it appears in (via playlist_genres). Chunked in pgrSelectIn
        // so a very-popular track's playlist list doesn't blow the URL limit.
        let genres = [];
        if (playlistIds.length) {
            const genreRows = await pgrSelectIn('playlist_genres', 'playlist_id', playlistIds, { select: 'genre' });
            genres = Array.from(new Set((genreRows || []).map((r) => r.genre))).sort();
        }

        return res.status(200).json({
            spotifyId:       canonicalId,
            inputSpotifyId:  spotifyId,
            title:           spotifyData?.name || '(unknown)',
            artists:         (spotifyData?.artists || []).map((a) => a.name),
            inPlaylistCount: playlistIds.length,
            playlistIds,
            genres,
            hasAnalysis:     (analysisRows || []).length > 0,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
