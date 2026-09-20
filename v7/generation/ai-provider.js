// v7 provider switch — independent copy of v6/generation/ai-provider.js so
// v7 can A/B a different model or thinking level without touching v6.
// Currently identical to v6's version; drift is expected once we start
// tuning v7 in isolation.
//
// Flipping PROVIDER changes which model handles ALL v7 callers of this
// module:
//   - v7/generation/musical-directions.js  (v7 onboarding)
//   - v7/generation/refined-directions.js  (v7 round 2 refinement)
//   - (future) v7's own Ami prompt-tuning surface if we set one up
//
// No URL override — provider is set here and only here. Redeploy to change.
export const PROVIDER               = 'gemini';           // 'anthropic' | 'gemini'
export const MODEL_ANTHROPIC        = 'claude-sonnet-4-6';
export const MODEL_GEMINI           = 'gemini-3.6-flash';
// Gemini 3.x thinking depth. 'high' spends more thought tokens (slower, more
// deliberate). 'low' is fastest. Only meaningful when PROVIDER is 'gemini'.
export const GEMINI_THINKING_LEVEL  = 'high';             // 'low' | 'medium' | 'high'

// Unified call entry point.
//   system:              full system prompt string
//   userMessage:         user turn string
//   maxTokens:           output cap (default 4000)
//   cache:               true → apply Anthropic ephemeral cache to the system prompt.
//                        No-op for Gemini. Default false.
//   label:               string used in the console log line AND gemini_call_log.label
//                        (v7 callers pass 'v7-onboarding' / 'v7-onboarding-refined').
//   businessId:          optional — passed to Gemini proxy for spend attribution.
//   onboardingSessionId: optional — passed to Gemini proxy for spend attribution
//                        during onboarding (backfilled to business_id on signup).
// Returns { text, usage, elapsed, provider }.
export async function callModel({
  system, userMessage, maxTokens = 4000, cache = false, label = 'call',
  businessId = null, onboardingSessionId = null,
}) {
  if (PROVIDER === 'gemini')    return callGemini   ({ system, userMessage, maxTokens, label, businessId, onboardingSessionId });
  if (PROVIDER === 'anthropic') return callAnthropic({ system, userMessage, maxTokens, cache, label });
  throw new Error(`ai-provider: unknown PROVIDER "${PROVIDER}"`);
}

async function callAnthropic({ system, userMessage, maxTokens, cache, label }) {
  const t0 = Date.now();
  const systemBlock = cache
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : [{ type: 'text', text: system }];
  const r = await fetch('/api/v5/anthropic', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:      MODEL_ANTHROPIC,
      max_tokens: maxTokens,
      system:     systemBlock,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });
  const elapsed = Date.now() - t0;
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    throw new Error(`anthropic ${r.status}: ${errBody.error?.message || errBody.error || r.statusText}`);
  }
  const data = await r.json();
  if (data?.usage) {
    console.log(`anthropic ${label} (${elapsed}ms):`, {
      input:       data.usage.input_tokens,
      cache_write: data.usage.cache_creation_input_tokens,
      cache_read:  data.usage.cache_read_input_tokens,
      output:      data.usage.output_tokens,
    });
  }
  if (data?.stop_reason === 'refusal') throw new Error('anthropic: model refused the request');
  const text = Array.isArray(data?.content)
    ? data.content.find((b) => b?.type === 'text')?.text
    : null;
  if (typeof text !== 'string') throw new Error('anthropic: no text block in response');
  return { text, usage: data?.usage || null, elapsed, provider: 'anthropic' };
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

// Both callers get JSON back from the model. Anthropic sometimes wraps it in
// ```json fences; Gemini (with responseMimeType) doesn't but be defensive.
export function parseJSONFromText(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch (err) {
    console.warn('[v7 ai-provider] parse failed:', {
      message: err?.message,
      textLen: body.length,
      head:    body.slice(0, 120),
      tail:    body.slice(-120),
    });
    throw err;
  }
}
