/* /api/new/spotify.js
   Lean Spotify proxy for the new pipeline. Three actions:
     - get_playlist_tracks: read tracks from public playlists (Client Credentials via Michael's app)
     - create_playlist:     create a playlist on the Rubin user's account (user token via Rubin app)
     - add_tracks:          add tracks to a playlist (user token via Rubin app)
   Token sources:
     - Client Credentials: SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET (Michael's app — grandfathered)
     - User token:         RUBIN_REFRESH_TOKEN + RUBIN_SPOTIFY_CLIENT_ID + RUBIN_SPOTIFY_CLIENT_SECRET
                           (seed RUBIN_REFRESH_TOKEN once via /api/new/rubin-oauth-callback)
*/

let ccToken  = null;
let ccExpiry = 0;

let userToken   = null;
let userExpiry  = 0;
let userRefresh = null;

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

async function refreshUserToken() {
  if (!userRefresh) {
    const envToken = process.env.RUBIN_REFRESH_TOKEN;
    if (!envToken) {
      throw new Error('RUBIN_REFRESH_TOKEN not set — seed it via /api/new/rubin-oauth-callback once, then add it to env.');
    }
    userRefresh = envToken;
  }

  const clientId     = process.env.RUBIN_SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('RUBIN_SPOTIFY_CLIENT_ID / RUBIN_SPOTIFY_CLIENT_SECRET not set');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: userRefresh,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Rubin user token refresh failed: ${r.status} ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  userToken  = data.access_token;
  userExpiry = Date.now() + (data.expires_in * 1000) - 60000;

  // Spotify may rotate the refresh_token. Use the new one in-process; if it persists,
  // update RUBIN_REFRESH_TOKEN env so the next cold start picks up the latest.
  if (data.refresh_token && data.refresh_token !== userRefresh) {
    console.warn('[rubin] Spotify rotated the refresh_token. Update RUBIN_REFRESH_TOKEN env var to:', data.refresh_token);
    userRefresh = data.refresh_token;
  }

  return userToken;
}

async function getUserToken() {
  if (userToken && Date.now() < userExpiry) return userToken;
  return refreshUserToken();
}

async function spotifyCall(url, init, tokenKind, override = null) {
  const getToken = async () => {
    if (override) return override;
    return tokenKind === 'user' ? getUserToken() : getCCToken();
  };
  const doFetch = (t) => fetch(url, {
    ...(init || {}),
    headers: { ...((init && init.headers) || {}), 'Authorization': `Bearer ${t}` },
  });

  let token = await getToken();
  let r = await doFetch(token);

  if (r.status === 429) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '1', 10);
    await sleep(Math.min(retryAfter, 30) * 1000);
    r = await doFetch(token);
  }

  // When an override token is supplied (test bypass), don't try to refresh on 401 — bubble up.
  if (r.status === 401 && !override) {
    if (tokenKind === 'user') { userToken = null; userExpiry = 0; }
    else                      { ccToken   = null; ccExpiry   = 0; }
    token = await getToken();
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
      const { playlist_id, offset = 0, limit = 50, fields } = req.body;
      if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });
      const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      if (fields) qs.set('fields', fields);
      const url = `https://api.spotify.com/v1/playlists/${playlist_id}/tracks?${qs}`;
      const r = await spotifyCall(url, { method: 'GET' }, 'cc');
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    if (action === 'create_playlist') {
      const { name, description, _user_access_token: override } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const r = await spotifyCall(`https://api.spotify.com/v1/me/playlists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || '', public: false, collaborative: true }),
      }, 'user', override);
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    if (action === 'add_tracks') {
      const { playlist_id, uris, _user_access_token: override } = req.body;
      if (!playlist_id || !Array.isArray(uris) || !uris.length) {
        return res.status(400).json({ error: 'playlist_id and non-empty uris required' });
      }
      const results = [];
      for (let i = 0; i < uris.length; i += 100) {
        const batch = uris.slice(i, i + 100);
        const r = await spotifyCall(`https://api.spotify.com/v1/playlists/${playlist_id}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: batch }),
        }, 'user', override);
        const data = await r.json().catch(() => ({}));
        results.push({ status: r.status, body: data });
      }
      return res.status(200).json({ results });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
