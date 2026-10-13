// Energy windows for the v7 daily playlists (Roni, 2026-10-13).
//
// Every analysed track has an energy value 0–100 (track_analyses.energy). The
// daily builders take a playlist's songs from inside an energy window:
//   Option 1 — the high-energy playlists 50–80, the calm ones 20–50.
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
  low:  Object.freeze({ min: 20, max: 50 }),
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
