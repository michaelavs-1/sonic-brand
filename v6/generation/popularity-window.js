// v5 popularity-window derivation.
//
// Given the atmospheres the user picked, compute a single popularity window
// [lo, hi] the way v4 does for its atmosphere-derived params (see
// v4/generation/atmosphere-params.js — this is the popularity-only subset).
//
// Formula:
//   1. Collect every popularity range [L, R] the picked atmospheres declare.
//      Atmospheres whose popularity cell is null (wildcard) are skipped.
//   2. If no ranges collected → return null (caller should treat as "no filter").
//   3. Otherwise: midpoint = (minL + maxR) / 2, then window = midpoint −40 / +20
//      (real tracks skew low on popularity, so we loosen the lower bound).
//      Clamped to [0, 100].

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

export function derivePopularityWindow(selectedNames, atmosphereRows) {
  if (!Array.isArray(selectedNames) || !selectedNames.length) return null;

  const byName = new Map();
  for (const r of atmosphereRows || []) {
    if (r?.atmosphere) byName.set(r.atmosphere, r);
  }

  let minL = Infinity;
  let maxR = -Infinity;
  let count = 0;
  for (const name of selectedNames) {
    const row = byName.get(name);
    const range = row?.ranges?.popularity;
    if (!range) continue;
    const [L, R] = range;
    if (L < minL) minL = L;
    if (R > maxR) maxR = R;
    count++;
  }
  if (!count) return null;

  const avg  = (minL + maxR) / 2;
  const lo   = clamp(Math.round(avg - 40));
  const hi   = clamp(Math.round(avg + 20));
  return [lo, hi];
}
