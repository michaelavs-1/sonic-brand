const SPOTIFY_PROXY = '/api/spotify';
const OPENAI_PROXY = '/api/openai';

async function spotifyProxy(body) {
  const r = await fetch(SPOTIFY_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Spotify proxy HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

export async function spotifyFetchUrl(url, { neutral = true } = {}) {
  return spotifyProxy({ action: 'fetch', url, neutral });
}

export async function spotifySearch(query, { neutral = true } = {}) {
  return spotifyProxy({ action: 'search', query, neutral });
}

export async function getPlaylistTracks(playlistId, { fields, limit = 50, offset = 0, neutral = true } = {}) {
  const params = new URLSearchParams();
  if (fields) params.set('fields', fields);
  params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return spotifyFetchUrl(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?${params}`, { neutral });
}

export async function getAudioFeatures(trackIds, { neutral = true } = {}) {
  if (!trackIds || !trackIds.length) return { audio_features: [] };
  const ids = trackIds.slice(0, 100).join(',');
  return spotifyFetchUrl(`https://api.spotify.com/v1/audio-features?ids=${ids}`, { neutral });
}

export async function getRecommendations(params, { neutral = true } = {}) {
  const qs = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  return spotifyFetchUrl(`https://api.spotify.com/v1/recommendations?${qs}`, { neutral });
}

export async function searchTrack(artist, title, { neutral = true, fallbackToken = null } = {}) {
  try {
    const j = await spotifySearch(`${artist} ${title}`, { neutral });
    if (j.tracks && j.tracks.items && j.tracks.items.length) return j.tracks.items[0];
  } catch (e) {}
  if (fallbackToken) {
    try {
      const r = await fetch('https://api.spotify.com/v1/search?' + new URLSearchParams({
        q: `${artist} ${title}`, type: 'track', limit: '1', market: 'IL',
      }), { headers: { 'Authorization': 'Bearer ' + fallbackToken } });
      if (r.ok) {
        const j = await r.json();
        if (j.tracks && j.tracks.items && j.tracks.items.length) return j.tracks.items[0];
      }
    } catch (e) {}
  }
  return null;
}

export async function callOpenAI(messages, opts = {}) {
  if (!opts.apiKey) throw new Error('callOpenAI: opts.apiKey is required');
  if (!opts.model) throw new Error('callOpenAI: opts.model is required');

  const body = {
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: opts.temperature ?? 0.6,
    messages,
    max_tokens: opts.max_tokens || 2500,
    response_format: opts.noJson ? undefined : { type: 'json_object' },
  };
  const hasJ = messages.some(m => (m.content || '').toLowerCase().includes('json'));
  if (!hasJ) {
    messages.push({ role: 'system', content: 'Return JSON only.' });
  }

  const r = await fetch(OPENAI_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.choices[0].message.content;
}
