import { requireSiteOrInternal, setCors } from './origin-guard.js';
import { guard } from './ratelimit.js';
/* /api/v6/gemini.js
   Google Gemini generateContent proxy for v6.
   Key source: process.env.GEMINI_API_KEY. No body-supplied keys.

   Auth: requireSiteOrInternal — browsers on our site OR server-to-server
   callers carrying `x-sonic-internal: INTERNAL_API_KEY`. Model +
   max_output_tokens locked down server-side so a compromised browser
   can't ask for arbitrary spend.

   Request shape (client-side, kept small and provider-agnostic-ish):
     { model, system, user, history?, max_output_tokens?, thinking_budget? }

   `history` (optional): array of prior turns for multi-turn chat, e.g.
     [{ role: 'user',  text: '...' },
      { role: 'model', text: '...' }, ...]
   When present, the request builds a Gemini `contents` sequence with the
   history first and `user` appended as the final user turn. When absent
   the original single-turn shape is used (unaffects musical-directions).

   Response is Gemini's raw JSON, with an added top-level `usage` field
   normalized from `usageMetadata` for parity with the anthropic proxy.
*/

const ALLOWED_MODELS = new Set(['gemini-3.6-flash']);
const MAX_OUTPUT_TOKENS_CAP = 4096;

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sonic-internal');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSiteOrInternal(req, res)) return;
  if (!await guard(req, res, 'gemini', 20, 60)) return;

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const { model, system, user, history, max_output_tokens, thinking_level, label } = req.body || {};
  if (!model || typeof user !== 'string' || !user.length) {
    return res.status(400).json({ error: 'model and user are required' });
  }
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: `model "${model}" not in allowlist` });
  }

  // Build the contents sequence. Single-turn callers get the original
  // one-element array; multi-turn callers get history + final user turn.
  const contents = [];
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn || typeof turn.text !== 'string' || !turn.text.length) continue;
      const role = turn.role === 'model' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: turn.text }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: user }] });

  const payload = {
    contents,
    generationConfig: {
      maxOutputTokens:  Math.min(Number(max_output_tokens) || MAX_OUTPUT_TOKENS_CAP, MAX_OUTPUT_TOKENS_CAP),
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

    // Inner call: fires one Gemini request, normalizes usage, writes the
    // diagnostic log line. Reused by the initial call and the MAX_TOKENS
    // retry below so both paths log with identical shape.
    async function callAndLog(currentPayload, currentLevel, isRetry) {
      const r = await fetch(url, {
        method:  'POST',
        headers: {
          'x-goog-api-key': key,
          'content-type':   'application/json',
        },
        body: JSON.stringify(currentPayload),
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
      try {
        const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
        const text = Array.isArray(cand?.content?.parts)
          ? cand.content.parts.find((p) => typeof p?.text === 'string')?.text
          : null;
        const textStr = typeof text === 'string' ? text : '';
        const RESP_FULL_LIMIT = 8000;
        const respField = textStr.length <= RESP_FULL_LIMIT
          ? { text: textStr }
          : { textHead: textStr.slice(0, 400), textTail: textStr.slice(-400) };
        console.log('[gemini]', JSON.stringify({
          status:        r.status,
          model,
          thinkingLevel: currentLevel,
          retry:         !!isRetry,
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
      return { r, data };
    }

    let { r, data } = await callAndLog(payload, level, false);

    // Safety net: if Gemini hit MAX_TOKENS and thinking was 'high', retry
    // once with thinkingLevel='medium' to free some token budget for actual
    // JSON output while keeping most of the reasoning depth. Transparent to
    // the client — it sees the successful retry response. If the retry also
    // hits MAX_TOKENS we return it as-is; the client-side parse error path
    // will surface it.
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS' && level === 'high') {
      const retryPayload = {
        ...payload,
        generationConfig: {
          ...payload.generationConfig,
          thinkingConfig: { thinkingLevel: 'medium' },
        },
      };
      ({ r, data } = await callAndLog(retryPayload, 'medium', true));
    }

    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upstream fetch failed' });
  }
}
