const SUPABASE_URL = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const CLIENT_ID = 'b6404b5ae1684143b79d9a86bb4b6cba';

let cachedToken = null;
let cachedExpiry = 0;
let cachedRefresh = null;

async function getRefreshTokenFromSupabase() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/user_spotify?select=*&order=updated_at.desc&limit=1', {
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

async function getValidToken() {
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, query, url } = req.body;
    const token = await getValidToken();

    if (!token) {
      return res.status(503).json({ error: 'No Spotify token available. Admin must connect Spotify first.' });
    }

    if (action === 'search') {
      const spRes = await fetch(
        'https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=track&limit=5',
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
      if (spRes.status === 401) {
        cachedToken = null;
        cachedExpiry = 0;
        const newToken = await getValidToken();
        if (!newToken) return res.status(503).json({ error: 'Token refresh failed' });
        const retry = await fetch(
          'https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=track&limit=5',
          { headers: { 'Authorization': 'Bearer ' + newToken } }
        );
        return res.status(retry.status).json(await retry.json());
      }
      return res.status(spRes.status).json(await spRes.json());
    }

    if (action === 'fetch' && url) {
      const spRes = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (spRes.status === 401) {
        cachedToken = null;
        cachedExpiry = 0;
        const newToken = await getValidToken();
        if (!newToken) return res.status(503).json({ error: 'Token refresh failed' });
        const retry = await fetch(url, { headers: { 'Authorization': 'Bearer ' + newToken } });
        return res.status(retry.status).json(await retry.json());
      }
      return res.status(spRes.status).json(await spRes.json());
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
