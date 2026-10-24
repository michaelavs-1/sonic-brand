// v7 provider switch — independent copy of v6/generation/ai-provider.js so
// v7 can A/B a different model or thinking level without touching v6.
// Currently identical to v6's version; drift is expected once we start
// tuning v7 in isolation.
//
// Gemini is the only provider: the Anthropic path and its /api/v5/anthropic
// proxy were removed on 2026-10-24 (unused since the switch to Gemini, and the
// proxy was a free Claude for anyone). PROVIDER stays as a label, shown in
// Ami's dashboard and checked by the server's event-playlist call.
//
// Callers: v7/generation/musical-directions.js, refined-directions.js,
// taste-profile.js, energy-directions.js, level-directions.js, and Ami's
// prompt dashboard. Model / thinking level are set here only. Redeploy to change.

import { serverWarn } from './server-log.js';

export const PROVIDER               = 'gemini';
export const MODEL_GEMINI           = 'gemini-3.6-flash';
// Gemini 3.x thinking depth. 'high' spends more thought tokens (slower, more
// deliberate). 'low' is fastest.
export const GEMINI_THINKING_LEVEL  = 'high';             // 'low' | 'medium' | 'high'

// Unified call entry point.
//   system:              full system prompt string
//   userMessage:         user turn string
//   maxTokens:           output cap (default 4000)
//   label:               string stored as gemini_call_log.label
//                        (v7 callers pass 'v7-onboarding' / 'v7-onboarding-refined').
//   businessId:          optional — passed to Gemini proxy for spend attribution.
//   onboardingSessionId: optional — passed to Gemini proxy for spend attribution
//                        during onboarding (backfilled to business_id on signup).
// Returns { text, usage, elapsed, provider }.
// history (optional): earlier turns, [{ role: 'user' | 'model', text }]
// — Ami's chat test benches (2026-10-21). thinkingLevel overrides the default.
export async function callModel({
  system, userMessage, maxTokens = 4000, label = 'call',
  businessId = null, onboardingSessionId = null, history = null, thinkingLevel = null,
}) {
  return callGemini({ system, userMessage, maxTokens, label, businessId, onboardingSessionId, history, thinkingLevel });
}

async function callGemini({ system, userMessage, maxTokens, label, businessId, onboardingSessionId, history = null, thinkingLevel = null }) {
  const t0 = Date.now();
  const r = await fetch('/api/v6/gemini', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:                  MODEL_GEMINI,
      max_output_tokens:      maxTokens,
      thinking_level:         thinkingLevel || GEMINI_THINKING_LEVEL,
      system,
      user:                   userMessage,
      ...(Array.isArray(history) && history.length ? { history } : {}),
      label,
      business_id:            businessId || null,
      onboarding_session_id:  onboardingSessionId || null,
    }),
  });
  const elapsed = Date.now() - t0;
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    const msg = errBody?.error?.message || errBody?.error || r.statusText;
    throw new Error(`gemini ${r.status}: ${msg}`);
  }
  const data = await r.json();
  const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  if (cand?.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
    throw new Error(`gemini: unexpected finishReason ${cand.finishReason}`);
  }
  const text = Array.isArray(cand?.content?.parts)
    ? cand.content.parts.find((p) => typeof p?.text === 'string')?.text
    : null;
  if (typeof text !== 'string') throw new Error('gemini: no text part in response');
  return { text, usage: data?.usage || null, elapsed, provider: 'gemini' };
}

// The model answers in JSON. Gemini (with responseMimeType) doesn't wrap it in
// ```json fences, but be defensive.
export function parseJSONFromText(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch (err) {
    serverWarn('[v7 ai-provider] parse failed:', {
      message: err?.message,
      textLen: body.length,
      head:    body.slice(0, 120),
      tail:    body.slice(-120),
    });
    throw err;
  }
}
