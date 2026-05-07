const SUPABASE_URL = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const CLIENT_ID = 'b6404b5ae1684143b79d9a86bb4b6cba';
const CLIENT_SECRET = '158fe44d006a47209daa375898fd835e';

// User token cache (from refresh token)
let cachedToken = null;
let cachedExpiry = 0;
let cachedRefresh = null;

// Client Credentials token cache (always works, no user needed)
let ccToken = null;
let ccExpiry = 0;

async function getRefreshTokenFromSupabase() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/spotify_tokens?select=*&order=updated_at.desc&limit=1', {
    headers: {
      'apikey': SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.length) return null;
  return data[0];
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  if (data.refresh_token) cachedRefresh = data.refresh_token;
  return cachedToken;
}

// Client Credentials flow — ALWAYS works, no user login needed
// Good for: search, audio-features, recommendations, artists, tracks
// Cannot do: /me, create_playlist, add_tracks (those need user token)
async function getClientCredentialsToken() {
  if (ccToken && Date.now() < ccExpiry) return ccToken;
  const basic = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + basic
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  ccToken = data.access_token;
  ccExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  return ccToken;
}

// Try user token first (can do everything), fall back to CC token
async function getValidToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  if (cachedRefresh) {
    const token = await refreshAccessToken(cachedRefresh);
    if (token) return token;
  }

  const row = await getRefreshTokenFromSupabase();
  if (row && row.refresh_token) {
    cachedRefresh = row.refresh_token;
    if (row.access_token && row.expiry && Number(row.expiry) > Date.now() + 60000) {
      cachedToken = row.access_token;
      cachedExpiry = Number(row.expiry);
      return cachedToken;
    }
    const refreshed = await refreshAccessToken(row.refresh_token);
    if (refreshed) return refreshed;
  }

  // Fallback: Client Credentials (works for non-user endpoints)
  return await getClientCredentialsToken();
}

// For user-specific actions (me, playlists), we NEED the user token
async function getUserToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;
  if (cachedRefresh) {
    const token = await refreshAccessToken(cachedRefresh);
    if (token) return token;
  }
  const row = await getRefreshTokenFromSupabase();
  if (!row || !row.refresh_token) return null;
  cachedRefresh = row.refresh_token;
  if (row.access_token && row.expiry && Number(row.expiry) > Date.now() + 60000) {
    cachedToken = row.access_token;
    cachedExpiry = Number(row.expiry);
    return cachedToken;
  }
  return await refreshAccessToken(row.refresh_token);
}

async function spotifyFetchWithRetry(url, token, options) {
  const opts = Object.assign({}, options || {}, {
    headers: Object.assign({}, (options && options.headers) || {}, { 'Authorization': 'Bearer ' + token })
  });
  let spRes = await fetch(url, opts);
  if (spRes.status === 401) {
    // Token expired, try refresh
    cachedToken = null;
    cachedExpiry = 0;
    const newToken = await getValidToken();
    if (!newToken) return null;
    opts.headers['Authorization'] = 'Bearer ' + newToken;
    spRes = await fetch(url, opts);
  }
  return spRes;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, query, url, neutral } = req.body;

    if (action === 'save_token') {
      const { access_token, refresh_token, expiry } = req.body;
      if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
      await fetch(SUPABASE_URL + '/rest/v1/spotify_tokens?id=neq.00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON }
      });
      const saveRes = await fetch(SUPABASE_URL + '/rest/v1/spotify_tokens', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ access_token, refresh_token, expiry, updated_at: new Date().toISOString() })
      });
      const saved = await saveRes.json();
      cachedToken = access_token;
      cachedExpiry = Number(expiry) || 0;
      cachedRefresh = refresh_token;
      return res.status(200).json({ ok: true, saved });
    }

    // For user-specific actions, we need user token
    if (action === 'me' || action === 'create_playlist' || action === 'add_tracks') {
      const userToken = await getUserToken();
      if (!userToken) {
        return res.status(503).json({ error: 'No user Spotify token available. Admin must connect Spotify first.' });
      }

      if (action === 'me') {
        const spRes = await spotifyFetchWithRetry('https://api.spotify.com/v1/me', userToken);
        if (!spRes) return res.status(503).json({ error: 'Token refresh failed' });
        return res.status(spRes.status).json(await spRes.json());
      }

      if (action === 'create_playlist') {
        const { name, description } = req.body;
        const meRes = await spotifyFetchWithRetry('https://api.spotify.com/v1/me', userToken);
        if (!meRes) return res.status(503).json({ error: 'Token refresh failed' });
        const me = await meRes.json();
        if (!me.id) return res.status(500).json({ error: 'Cannot get user ID' });
        const currentToken = cachedToken || userToken;
        const spRes = await spotifyFetchWithRetry('https://api.spotify.com/v1/users/' + me.id + '/playlists', currentToken, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name || 'SonicBrand Mix', description: description || 'Generated by SonicBrand AI', public: true })
        });
        if (!spRes) return res.status(503).json({ error: 'Token refresh failed' });
        return res.status(spRes.status).json(await spRes.json());
      }

      if (action === 'add_tracks') {
        const { playlist_id, uris } = req.body;
        if (!playlist_id || !uris || !uris.length) return res.status(400).json({ error: 'Missing playlist_id or uris' });
        const results = [];
        for (let i = 0; i < uris.length; i += 100) {
          const batch = uris.slice(i, i + 100);
          const currentToken = cachedToken || userToken;
          const spRes = await spotifyFetchWithRetry('https://api.spotify.com/v1/playlists/' + playlist_id + '/tracks', currentToken, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: batch })
          });
          if (spRes) results.push(await spRes.json());
          else results.push({ error: 'Token refresh failed' });
        }
        return res.status(200).json({ results });
      }
    }

    // For non-user actions: use CC token when neutral=true (no personalization bias)
    const token = neutral ? await getClientCredentialsToken() : await getValidToken();
    if (!token) {
      return res.status(503).json({ error: 'No Spotify token available' });
    }

    if (action === 'search') {
      const spRes = await spotifyFetchWithRetry(
        'https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=track&limit=5',
        token
      );
      if (!spRes) return res.status(503).json({ error: 'Token refresh failed' });
      return res.status(spRes.status).json(await spRes.json());
    }

    if (action === 'fetch' && url) {
      const spRes = await spotifyFetchWithRetry(url, token);
      if (!spRes) return res.status(503).json({ error: 'Token refresh failed' });
      return res.status(spRes.status).json(await spRes.json());
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
