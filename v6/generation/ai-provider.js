// v6's model settings for the musical-directions prompt. Gemini is the only
// provider: the Anthropic path and its /api/v5/anthropic proxy were removed on
// 2026-10-24 (unused since the switch to Gemini). PROVIDER stays as a label.
// Caller: v6/generation/musical-directions.js (v6 onboarding).
//
// No URL override — set here and only here. Redeploy to change.
export const PROVIDER               = 'gemini';
export const MODEL_GEMINI           = 'gemini-3.6-flash';
// Gemini 3.x thinking depth. 'high' spends more thought tokens (slower, more
// deliberate). 'low' is fastest.
export const GEMINI_THINKING_LEVEL  = 'high';             // 'low' | 'medium' | 'high'

// Unified call entry point.
//   system:              full system prompt string
//   userMessage:         user turn string
//   maxTokens:           output cap (default 4000)
//   label:               string used in the console log line
//   businessId:          optional — passed to Gemini proxy for spend attribution.
//   onboardingSessionId: optional — passed to Gemini proxy for spend attribution
//                        during onboarding (backfilled to business_id on signup).
// Returns { text, usage, elapsed, provider }.
export async function callModel({
  system, userMessage, maxTokens = 4000, label = 'call',
  businessId = null, onboardingSessionId = null,
}) {
  return callGemini({ system, userMessage, maxTokens, label, businessId, onboardingSessionId });
}

async function callGemini({ system, userMessage, maxTokens, label, businessId, onboardingSessionId }) {
  const t0 = Date.now();
  const r = await fetch('/api/v6/gemini', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:                  MODEL_GEMINI,
      max_output_tokens:      maxTokens,
      thinking_level:         GEMINI_THINKING_LEVEL,
      system,
      user:                   userMessage,
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
  if (data?.usage) {
    console.log(`gemini ${label} (${elapsed}ms):`, data.usage);
  }
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
    // Client-side mirror of the server log. Server log is the primary source
    // (users on mobile Safari can't open dev tools) but if someone with a
    // console attached hits it we get both sides.
    console.warn('[ai-provider] parse failed:', {
      message: err?.message,
      textLen: body.length,
      head:    body.slice(0, 120),
      tail:    body.slice(-120),
    });
    throw err;
  }
}
