// Energy windows for the v7 daily playlists (Roni, 2026-10-13).
//
// Every analysed track has an energy value 0–100 (track_analyses.energy). The
// daily builders take a playlist's songs from inside an energy window:
//   Option 1 — the high-energy playlists 50–80, the calm ones 30–60 (20–50
//              until 2026-10-21).
//   Option 2 — each level of the owner's energy scale gets a range from
//              LEVEL_ENERGY_WINDOWS: 20–80 split into N ranges whose
//              neighbours overlap by 20 points (Ami's 4-level proposal of
//              2026-10-05, stretched to fit 2–6 levels).
// When the window doesn't hold enough songs it widens by ENERGY_WIDEN_STEP on
// each side until it does; songs the business heard in the last 7 days come
// in only after that. The widening happens in SQL: v6_direction_tracks_recent
// (Option 1) and v7_timeline_pool (Option 2) rank each track by how many steps
// outside the window it is (migration 2026-10-13-v7-energy-windows.sql, which
// carries the same step of 5).
//
// These are the defaults. The taste chat (2026-10-13) moves them per owner:
// Option 1's windows (business_v7_settings.energy_windows, read through
// option1EnergyWindow's `stored`) and one Option 2 recipe's range
// (business_v7_level_directions.energy_range). Special playlists don't use
// energy; they stay on tempo.
//
// Pure, bare imports — browser + server.

import { normLevels } from './energy-timeline.js';

export const ENERGY_WIDEN_STEP = 5;

export const OPTION1_ENERGY_WINDOWS = Object.freeze({
  high: Object.freeze({ min: 50, max: 80 }),
  low:  Object.freeze({ min: 30, max: 60 }),
});

// [min, max] per level (index 0 = level 1), keyed by the owner's number of
// levels (business_taste_profiles.energy_levels_total, 2..6).
export const LEVEL_ENERGY_WINDOWS = Object.freeze({
  2: [[20, 60], [40, 80]],
  3: [[20, 53], [33, 67], [47, 80]],
  4: [[20, 50], [30, 60], [40, 70], [50, 80]],
  5: [[20, 48], [28, 56], [36, 64], [44, 72], [52, 80]],
  6: [[20, 47], [27, 53], [33, 60], [40, 67], [47, 73], [53, 80]],
});

// 'high' | 'low' → { min, max } (a copy), or null for an unknown tier.
// `stored` = business_v7_settings.energy_windows ({ high: [min, max], low:
// [min, max] }, set by the taste chat); a missing or malformed tier falls back
// to the default.
export function option1EnergyWindow(tier, stored = null) {
  const w = OPTION1_ENERGY_WINDOWS[tier];
  if (!w) return null;
  const s = stored && typeof stored === 'object' ? stored[tier] : null;
  const lo = Number(Array.isArray(s) ? s[0] : s?.min);
  const hi = Number(Array.isArray(s) ? s[1] : s?.max);
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi <= 100 && lo < hi) return { min: Math.round(lo), max: Math.round(hi) };
  return { min: w.min, max: w.max };
}

// Level L on an N-level scale → { min, max }. N is read with normLevels (the
// default when it isn't 2..6) and L clamped to 1..N, the way the Option-2
// builder reads them.
export function levelEnergyWindow(level, N) {
  const rows = LEVEL_ENERGY_WINDOWS[normLevels(N)];
  const L = Math.min(rows.length, Math.max(1, Math.round(Number(level) || 1)));
  const [min, max] = rows[L - 1];
  return { min, max };
}

// ---------- "today only" energy for one Option 1 playlist (Ami + Roni, 2026-10-21) ----------
// Under each of the 4 daily playlists the owner sees three circles: calmer /
// as usual / more energetic. A tap swaps the songs of THAT playlist, for today
// only, to a window one step (ENERGY_NUDGE_STEP) away from its usual one; one
// change a day per business (api/v7/account/energy-nudge.js). The usual window
// is the playlist's own (the default, or the owner's as moved by the chat).

export const ENERGY_NUDGE_STEP = 10;

// The three circles' windows, calmest first, and which one is the usual.
// Normally usual −10 / usual / usual +10. A usual window that can't move a full
// step one way (within 10 of 0 or 100) sits at that end, and the other two are
// one and two steps the other way.
//   usual — { min, max } or [min, max]
// → { windows: [[min, max] ×3], usualIndex: 0 | 1 | 2 }
export function nudgeOptions(usual) {
  const lo = Math.round(Number(Array.isArray(usual) ? usual[0] : usual?.min));
  const hi = Math.round(Number(Array.isArray(usual) ? usual[1] : usual?.max));
  const S = ENERGY_NUDGE_STEP;
  const at = (k) => [lo + k * S, hi + k * S];
  if (hi + S > 100) return { windows: [at(-2), at(-1), at(0)], usualIndex: 2 };
  if (lo - S < 0) return { windows: [at(0), at(1), at(2)], usualIndex: 0 };
  return { windows: [at(-1), at(0), at(1)], usualIndex: 1 };
}

// The playlist after a change: the songs kept (in their order) with the new
// ones put in at random places.
export function mergeAtRandom(kept, fresh, rand = Math.random) {
  const out = [...kept];
  for (const id of fresh) out.splice(Math.floor(rand() * (out.length + 1)), 0, id);
  return out;
}
