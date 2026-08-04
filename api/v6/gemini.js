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

  const { model, system, user, max_output_tokens, thinking_level, label } = req.body || {};
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
    // Diagnostic log — one line per call. Written to Vercel function logs so
    // client-side "JSON Parse error: Unexpected EOF" failures can be root-caused
    // after the fact (empty text vs truncated text vs MAX_TOKENS vs SAFETY)
    // WITHOUT needing to ask the user for anything — the full user prompt
    // (biz description + name + atmospheres + subset instruction) and the
    // full response text are both captured here.
    try {
      const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
      const text = Array.isArray(cand?.content?.parts)
        ? cand.content.parts.find((p) => typeof p?.text === 'string')?.text
        : null;
      const textStr = typeof text === 'string' ? text : '';
      // Response text: log in full up to 8KB; head+tail otherwise (enough to
      // see whether it's truncated and where).
      const RESP_FULL_LIMIT = 8000;
      const respField = textStr.length <= RESP_FULL_LIMIT
        ? { text: textStr }
        : { textHead: textStr.slice(0, 400), textTail: textStr.slice(-400) };
      console.log('[gemini]', JSON.stringify({
        status:        r.status,
        model,
        thinkingLevel: level,
        label:         label || null,
        finishReason:  cand?.finishReason || null,
        blockReason:   data?.promptFeedback?.blockReason || null,
        safetyRatings: cand?.safetyRatings || null,
        textLen:       textStr.length,
        ...respField,
        usage:         data?.usage || null,
        user,
      }));
    } catch (logErr) {
      console.log('[gemini] log failed:', logErr?.message);
    }
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upstream fetch failed' });
  }
}
