// v4 atmosphere → screening parameters.
//
// Input:  selectedNames (array of atmosphere names the user checked)
//         atmosphereRows (rows from /api/v4/databox-atmospheres)
//
// Output: { energy: [lo, hi] | null, danceability: …, … } — one entry per
//         parameter listed in PARAMS. `null` means the parameter is NOT part of
//         the filter (no selected atmosphere had a range for it).
//
// Formula:
//   1. For each parameter P:
//      Collect every range [L, R] that any selected atmosphere has for P.
//      Atmospheres whose cell is `null` (wildcard / no constraint) are skipped.
//   2. If zero ranges collected → screenParams[P] = null (parameter ignored).
//   3. Otherwise: take the encompassing union → midpoint = (minL + maxR) / 2.
//   4. Apply a per-parameter expansion rule (see PARAM_RULES below) to that
//      midpoint, producing a window of width 60 that is biased to reflect where
//      real tracks naturally cluster on that dimension. Clamp to [0, 100].

// Active screening parameters. `danceability`, `speechiness`, and
// `instrumentalness` are intentionally OMITTED — testing showed they reject
// most real music because their atmosphere-sheet ranges and the actual
// distributions of real tracks don't line up (instrumentalness ≈ 0 for vocal
// music, speechiness ≈ 0 for everything but rap, and danceability naturally
// peaks well below 70 for rock-leaning genres). Add them back here when those
// sheet entries are tuned to real-track reference values.
export const PARAMS = ['energy', 'happiness', 'popularity'];

// Per-parameter expansion rules. Width is 60; the BIAS reflects where real
// tracks naturally live on that dimension:
//   'symmetric' – midpoint −30 / +30
//   'low'       – midpoint −40 / +20  (real tracks skew low; loosen the lower bound)
//   'high'      – midpoint −20 / +40  (reserved; nothing currently skews high)
const PARAM_RULES = {
  energy:     'symmetric',
  happiness:  'symmetric',
  popularity: 'low',
};

function windowFor(skew, avg) {
  switch (skew) {
    case 'low':  return [avg - 40, avg + 20];
    case 'high': return [avg - 20, avg + 40];
    default:     return [avg - 30, avg + 30];
  }
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

export function deriveScreenParams(selectedNames, atmosphereRows) {
  const out = {};
  if (!Array.isArray(selectedNames) || !selectedNames.length) {
    for (const p of PARAMS) out[p] = null;
    return out;
  }

  const byName = new Map();
  for (const r of atmosphereRows || []) {
    if (r?.atmosphere) byName.set(r.atmosphere, r);
  }

  for (const param of PARAMS) {
    let minL = Infinity;
    let maxR = -Infinity;
    let count = 0;
    for (const name of selectedNames) {
      const row = byName.get(name);
      const range = row?.ranges?.[param];
      if (!range) continue;
      const [L, R] = range;
      if (L < minL) minL = L;
      if (R > maxR) maxR = R;
      count++;
    }
    if (!count) {
      out[param] = null;
      continue;
    }
    const avg = (minL + maxR) / 2;
    const [rawLo, rawHi] = windowFor(PARAM_RULES[param] || 'symmetric', avg);
    out[param] = [clamp(Math.round(rawLo)), clamp(Math.round(rawHi))];
  }
  return out;
}

// Returns the list of param names that actually constrain (non-null windows).
export function activeParams(screenParams) {
  return Object.entries(screenParams)
    .filter(([, v]) => v !== null)
    .map(([k]) => k);
}

// Does this analyzed track pass the screen? `analysis` is the track-analysis
// response (already on 0-100 scale for every parameter we use).
// Tracks missing a constrained field fail closed (so we don't accidentally
// include unscreened tracks in a strict filter).
export function trackPassesScreen(analysis, screenParams) {
  return evaluateTrack(analysis, screenParams).pass;
}

// Same check but returns `{ pass, reason? }` so callers can log WHY a track
// failed (which parameter and value vs which window).
export function evaluateTrack(analysis, screenParams) {
  if (!analysis) return { pass: false, reason: 'no analysis' };
  for (const param of PARAMS) {
    const window = screenParams[param];
    if (!window) continue;
    const v = analysis[param];
    if (typeof v !== 'number') {
      return { pass: false, reason: `${param} missing from analysis` };
    }
    const [lo, hi] = window;
    if (v < lo || v > hi) {
      return { pass: false, reason: `${param}=${v} ∉ [${lo},${hi}]` };
    }
  }
  return { pass: true };
}
