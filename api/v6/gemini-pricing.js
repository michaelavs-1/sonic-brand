/* Date-aware Gemini pricing table.

   Google's public rates for gemini-3.6-flash (paid Standard tier):
     Through 2026-12-31: $0.75 / 1M input,  $3.75 / 1M output,  $0.075 / 1M cached input
     From   2027-01-01: $1.50 / 1M input,  $7.50 / 1M output,  $0.15  / 1M cached input
   (source: https://ai.google.dev/gemini-api/docs/pricing — re-checked
   2026-10-13; check periodically for changes.)

   Cached input (2026-10-13): Google serves repeated prompt prefixes (our long
   system prompts) from its implicit cache and bills those tokens at a tenth
   of the input rate. They're part of the prompt count (`input`) and reported
   separately as `cached` (usageMetadata.cachedContentTokenCount), so the
   uncached part pays the input rate and the cached part the cache rate.
   Before this, every prompt token was priced at the full input rate, so
   logged costs ran high — at most ~17% (90% of input's ~19% share of the
   cost, Aug–Oct 2026).

   Output rate INCLUDES thinking tokens per Google's pricing page — so
   for cost purposes we add thinking tokens to output tokens and apply
   the single output rate. thinking_tokens is still logged separately
   in gemini_call_log for analytics.

   Rates are stored newest-first per model. computeCostUsd() picks the
   first tier whose effective_from is <= the call's timestamp, so on
   2027-01-01 the new rates take over automatically without a deploy.

   If a call comes in for a model NOT in the table, computeCostUsd
   returns null and the row is still logged (with cost_usd = null) so
   the token counts survive for retroactive backfill once rates are
   added.
*/

const PRICING = {
  'gemini-3.6-flash': [
    { effective_from: '2027-01-01T00:00:00Z', input_per_million: 1.50, output_per_million: 7.50, cached_input_per_million: 0.15 },
    { effective_from: '0001-01-01T00:00:00Z', input_per_million: 0.75, output_per_million: 3.75, cached_input_per_million: 0.075 },
  ],
};

// usage: { input, output, thinking, total, cached? } (as normalized by api/v6/gemini.js;
//        cached ⊆ input).
// at: Date the call happened. Defaults to now — pass the call's created_at
//     for accurate retroactive cost computation.
export function computeCostUsd(model, usage, at = new Date()) {
  const tiers = PRICING[model];
  if (!tiers || !usage) return null;
  const atMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const tier = tiers.find((t) => atMs >= new Date(t.effective_from).getTime());
  if (!tier) return null;
  const inputTokens  = Number(usage.input)  || 0;
  const cachedTokens = Math.min(inputTokens, Math.max(0, Number(usage.cached) || 0));
  // Thinking tokens are billed at the output rate — add them here so
  // the single per-1M output rate covers both.
  const outputTokens = (Number(usage.output) || 0) + (Number(usage.thinking) || 0);
  const cost =
      ((inputTokens - cachedTokens) * tier.input_per_million
     + cachedTokens * (tier.cached_input_per_million ?? tier.input_per_million)
     + outputTokens * tier.output_per_million)
      / 1_000_000;
  // Round to 8 decimal places to match the numeric(12, 8) column.
  return Number(cost.toFixed(8));
}
