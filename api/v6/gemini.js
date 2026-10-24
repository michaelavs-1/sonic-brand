import { requireSiteOrInternal, isInternal, setCors } from './origin-guard.js';
import { guard } from './ratelimit.js';
import { computeCostUsd } from './gemini-pricing.js';
import { BROWSER_DAILY_USD, browserSpendToday, addBrowserSpend } from './_gemini-ceiling.js';
import { pgrInsert } from '../v5/supabase-client.js';
/* /api/v6/gemini.js
   Google Gemini generateContent proxy for v6.
   Key source: process.env.GEMINI_API_KEY. No body-supplied keys.

   Auth: requireSiteOrInternal — browsers on our site OR server-to-server
   callers carrying `x-sonic-internal: INTERNAL_API_KEY`. Model +
   max_output_tokens locked down server-side so a compromised browser
   can't ask for arbitrary spend.

   Browser calls (no internal key) take whole prompts, and the Origin check
   is trivial to fake, so since 2026-10-24 they're also capped: output at
   BROWSER_MAX_OUTPUT_TOKENS, prompt size at BROWSER_MAX_PROMPT_CHARS, and
   the day's spend at a ceiling (_gemini-ceiling.js) → 413 prompt_too_large /
   429 daily_limit. Server calls are untouched.

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
// Gemini 3.6-flash's hard output-token limit is 65536; values above are
// silently clamped by Google. We match that here — a lower cap would
// silently truncate legit calls (esp. under thinkingLevel='high' where
// thinking tokens eat a big share of the budget), which is what caused
// "sometimes 4 previews instead of 8" and Ami's cut-off JSON symptoms.
// Per-call spend is still bounded by the model's own cap + the /gemini
// rate limit above (20/min per IP).
const MAX_OUTPUT_TOKENS_CAP = 65536;
// Browser calls: the biggest real call so far used 14,884 output tokens
// (thinking included, v7 taste profile / Option 1 directions; measured
// 2026-10-24 from gemini_call_log) — about half this cap. The biggest real
// prompt was ~14.7k tokens, roughly 50k characters.
const BROWSER_MAX_OUTPUT_TOKENS = 32768;
const BROWSER_MAX_PROMPT_CHARS  = 150000;

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

  const {
    model, system, user, history, max_output_tokens, thinking_level, label,
    business_id, onboarding_session_id,
  } = req.body || {};
  if (!model || typeof user !== 'string' || !user.length) {
    return res.status(400).json({ error: 'model and user are required' });
  }
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: `model "${model}" not in allowlist` });
  }

  const fromBrowser = !isInternal(req);
  if (fromBrowser) {
    const textLen = (t) => (typeof t === 'string' ? t.length : 0);
    const promptChars = textLen(system) + textLen(user)
      + (Array.isArray(history) ? history.reduce((n, turn) => n + textLen(turn?.text), 0) : 0);
    if (promptChars > BROWSER_MAX_PROMPT_CHARS) {
      return res.status(413).json({ error: 'prompt_too_large' });
    }
    if (await browserSpendToday() >= BROWSER_DAILY_USD) {
      return res.status(429).json({ error: 'daily_limit' });
    }
  }
  const outputCap = fromBrowser ? BROWSER_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS_CAP;

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
      maxOutputTokens:  Math.min(Number(max_output_tokens) || outputCap, outputCap),
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
          // Prompt tokens served from Google's implicit cache (part of
          // `input`), billed at the cache rate — see gemini-pricing.js.
          cached:   data.usageMetadata.cachedContentTokenCount || 0,
        };
      }
      const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
      try {
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

      // Spend-log write. AWAITED (was fire-and-forget in the first pass
      // — that dropped rows on Vercel because the function suspends
      // immediately after res.json() and any in-flight fetch gets
      // killed). Adds ~50-200ms per call which is negligible next to
      // Gemini's own latency. Failures here must NEVER surface to the
      // client so we swallow with a warning.
      const usage = data?.usage;
      const costUsd = usage ? computeCostUsd(model, usage) : 0;
      if (fromBrowser) await addBrowserSpend(costUsd);
      if (usage) {
        const row = {
          model,
          label:                  label || null,
          input_tokens:           usage.input    || 0,
          output_tokens:          usage.output   || 0,
          thinking_tokens:        usage.thinking || 0,
          total_tokens:           usage.total    || 0,
          cached_tokens:          usage.cached   || 0,
          cost_usd:               costUsd,
          business_id:            typeof business_id === 'string' ? business_id : null,
          onboarding_session_id:  typeof onboarding_session_id === 'string' ? onboarding_session_id : null,
          http_status:            r.status,
          finish_reason:          cand?.finishReason || null,
        };
        try {
          try {
            await pgrInsert('gemini_call_log', row);
          } catch (err) {
            // cached_tokens arrives with migration 2026-10-13-admin-console.sql;
            // until then, log the row without it (cost_usd already counts it).
            if (!/cached_tokens/.test(err?.message || '')) throw err;
            const { cached_tokens, ...rest } = row;
            await pgrInsert('gemini_call_log', rest);
          }
          console.log('[gemini] spend-log OK cost=', row.cost_usd, 'label=', row.label, 'cached=', row.cached_tokens);
        } catch (err) {
          console.warn('[gemini] spend-log insert failed:', err?.message || err);
        }
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
