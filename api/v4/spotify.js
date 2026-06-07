/* /api/v4/spotify.js
   Lean Spotify proxy for v4 preview phase. One action:
     - get_playlist_tracks: read tracks from public playlists (Client Credentials via Michael's app)
   Token source: SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET.
*/

let ccToken  = null;
let ccExpiry = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getCCToken() {
  if (ccToken && Date.now() < ccExpiry) return ccToken;
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Client Credentials token fetch failed: ${r.status}`);
  const data = await r.json();
  ccToken  = data.access_token;
  ccExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  return ccToken;
}

async function spotifyCall(url, init) {
  const doFetch = (t) => fetch(url, {
    ...(init || {}),
    headers: { ...((init && init.headers) || {}), 'Authorization': `Bearer ${t}` },
  });

  let token = await getCCToken();
  let r = await doFetch(token);

  if (r.status === 429) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '1', 10);
    await sleep(Math.min(retryAfter, 30) * 1000);
    r = await doFetch(token);
  }

  if (r.status === 401) {
    ccToken = null; ccExpiry = 0;
    token = await getCCToken();
    r = await doFetch(token);
  }

  return r;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action } = req.body || {};

    if (action === 'get_playlist_tracks') {
      const { playlist_id, offset = 0, limit = 50, fields, market } = req.body;
      if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });
      const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      if (fields) qs.set('fields', fields);
      if (market) qs.set('market', market);
      const url = `https://api.spotify.com/v1/playlists/${playlist_id}/tracks?${qs}`;
      const r = await spotifyCall(url, { method: 'GET' });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    if (action === 'get_track') {
      const { track_id, market } = req.body;
      if (!track_id) return res.status(400).json({ error: 'track_id required' });
      const qs = new URLSearchParams();
      if (market) qs.set('market', market);
      const url = `https://api.spotify.com/v1/tracks/${track_id}${qs.toString() ? '?' + qs : ''}`;
      const r = await spotifyCall(url, { method: 'GET' });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
