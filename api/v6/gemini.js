/* /api/v6/gemini.js
   Google Gemini generateContent proxy for v6.
   Key source: process.env.GEMINI_API_KEY. No body-supplied keys.

   Request shape (client-side, kept small and provider-agnostic-ish):
     { model, system, user, max_output_tokens?, thinking_budget? }

   Response is Gemini's raw JSON, with an added top-level `usage` field
   normalized from `usageMetadata` for parity with the anthropic proxy.
*/

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const { model, system, user, max_output_tokens, thinking_level } = req.body || {};
  if (!model || typeof user !== 'string' || !user.length) {
    return res.status(400).json({ error: 'model and user are required' });
  }

  const payload = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens:  max_output_tokens || 4096,
      // Force pure JSON so we don't have to strip ```json fences.
      responseMimeType: 'application/json',
    },
  };
  // Gemini 3.x uses `thinkingLevel: 'low' | 'medium' | 'high'`. Default 'low'
  // for the fast-flash behavior we want in the A/B. 2.x models used the older
  // `thinkingBudget` integer — 3.x rejects it with 400.
  const level = (thinking_level === 'medium' || thinking_level === 'high' || thinking_level === 'low')
    ? thinking_level : 'low';
  payload.generationConfig.thinkingConfig = { thinkingLevel: level };

  if (typeof system === 'string' && system.length) {
    payload.systemInstruction = { parts: [{ text: system }] };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const r = await fetch(url, {
      method:  'POST',
      headers: {
        'x-goog-api-key': key,
        'content-type':   'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data?.usageMetadata) {
      data.usage = {
        input:    data.usageMetadata.promptTokenCount,
        output:   data.usageMetadata.candidatesTokenCount,
        thinking: data.usageMetadata.thoughtsTokenCount || 0,
        total:    data.usageMetadata.totalTokenCount,
      };
    }
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upstream fetch failed' });
  }
}
