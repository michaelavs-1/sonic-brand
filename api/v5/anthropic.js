/* /api/v5/anthropic.js
   Anthropic Messages API proxy for the v5 pipeline.
   Key source: process.env.ANTHROPIC_KEY. No body-supplied keys.
*/

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

  const { model, system, messages, max_tokens } = req.body || {};
  if (!model || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'model and non-empty messages are required' });
  }

  const payload = {
    model,
    max_tokens: max_tokens || 4096,
    messages,
  };
  if (system) payload.system = system;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upstream fetch failed' });
  }
}
