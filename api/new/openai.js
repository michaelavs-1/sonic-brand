/* /api/new/openai.js
   OpenAI Chat Completions proxy for the new pipeline.
   Key source: process.env.OPENAI_API_KEY, with Supabase app_settings fallback.
   No body-supplied keys.
*/

const SB_URL  = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

async function getKeyFromSupabase() {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/app_settings?key=eq.openai_key&select=value&limit=1`,
      { headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0 && rows[0].value) return rows[0].value;
  } catch {}
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.OPENAI_API_KEY || (await getKeyFromSupabase());
  if (!key) return res.status(500).json({ error: 'No OpenAI key: neither OPENAI_API_KEY nor Supabase app_settings row resolved' });

  const { model, messages, max_tokens, temperature, response_format } = req.body || {};
  if (!model || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'model and non-empty messages are required' });
  }

  const isNewModel = /^gpt-5/.test(model);
  const payload = {
    model,
    messages,
    [isNewModel ? 'max_completion_tokens' : 'max_tokens']: max_tokens || 3000,
  };
  if (!isNewModel && typeof temperature === 'number') payload.temperature = temperature;
  if (response_format) payload.response_format = response_format;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upstream fetch failed' });
  }
}
