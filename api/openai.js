// Supabase — for cross-device key storage
const SB_URL  = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

async function getKeyFromSupabase(){
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/app_settings?key=eq.openai_key&select=value&limit=1`,
      { headers:{ 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` } }
    );
    const rows = await res.json();
    if(Array.isArray(rows) && rows.length > 0 && rows[0].value) return rows[0].value;
  } catch(e){}
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { apiKey, model, messages, max_tokens, temperature, response_format } = req.body;
    // Priority: request body → env var → Supabase app_settings
    const key = apiKey || process.env.OPENAI_API_KEY || (await getKeyFromSupabase());

    if (!key) {
      return res.status(400).json({ error: 'Missing API key' });
    }

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages: messages,
        max_tokens: max_tokens || 3000,
        temperature: temperature || 0.7,
        response_format: response_format
      })
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
