/* /api/v4/track-analysis.js
   SoundNet Track Analysis (RapidAPI) proxy for v4. Single action:
     - analyze_track: GET /pktx/spotify/{spotify_id} → audio features (energy, tempo, ...)
   Auth: process.env.TRACK_ANALYSIS_RAPIDAPI_KEY
*/

const RAPIDAPI_HOST = 'track-analysis.p.rapidapi.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callRapidApi(spotifyId, key) {
  return fetch(`https://${RAPIDAPI_HOST}/pktx/spotify/${encodeURIComponent(spotifyId)}`, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': key,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;
  if (!key) return res.status(500).json({ error: 'TRACK_ANALYSIS_RAPIDAPI_KEY not set' });

  try {
    const { action } = req.body || {};

    if (action === 'analyze_track') {
      const { spotify_id } = req.body;
      if (!spotify_id) return res.status(400).json({ error: 'spotify_id required' });

      let r = await callRapidApi(spotify_id, key);

      if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('retry-after') || '1', 10);
        await sleep(Math.min(retryAfter, 30) * 1000);
        r = await callRapidApi(spotify_id, key);
      }

      if (r.status === 404) {
        return res.status(200).json({ found: false, spotify_id });
      }

      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return res.status(502).json({ error: text.slice(0, 300) || r.statusText, status: r.status });
      }

      const data = await r.json().catch(() => ({}));
      return res.status(200).json({ found: true, ...data });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
