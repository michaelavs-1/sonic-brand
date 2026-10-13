// The admin's daily picks (the admin console, 2026-10-13): which direction
// plays in which daily playlist on a given business day, instead of the usual
// draw. Stored in business_v7_daily_picks (migration
// 2026-10-13-admin-console.sql), one row per (business, day, slot), with the
// direction's genres COPIED in — the library's rows are rewritten whenever it
// changes, so a pick can't point at them.
//
// Slots:
//   Option 1  'high-1' | 'high-2' | 'low-1' | 'low-2'
//             = "אנרגיה גבוהה #1/#2", "אנרגיה רגועה #1/#2"
//   Option 2  'mix-1:L3' = energy level 3 of "Daily Mix #1"
//             (each mix plays one direction per level, pickLevelDirections)
//
// Applied by the builders (api/v7/account/_daily-builder.js planOption1,
// _option2-builder.js planFromInputs) to the day's draw. A pick's genres are
// re-checked there against the CURRENT profile: genres no longer approved in
// that tier / at that level are dropped, and a pick left with none is ignored
// (the usual draw stands). Requested genres are still added to every Option 1
// playlist of their tier.
//
// Pure, no DB. Server-reachable (bare imports) + offline tests
// (scripts/test-daily-picks.mjs).

import { leastAlike } from './option1-draw.js';

export const OPTION1_SLOTS = ['high-1', 'high-2', 'low-1', 'low-2'];
export const OPTION1_SLOT_NAMES = {
  'high-1': 'אנרגיה גבוהה #1', 'high-2': 'אנרגיה גבוהה #2',
  'low-1': 'אנרגיה רגועה #1', 'low-2': 'אנרגיה רגועה #2',
};
export const OPTION2_MIXES = 2;
export const option2Slot = (mix, level) => `mix-${mix}:L${level}`;

// 'high-2' → { mode:'option1', tier:'high', n:2 }; 'mix-1:L3' → { mode:'option2', mix:1, level:3 }; junk → null.
export function parseSlot(slot) {
  const s = String(slot || '').trim().toLowerCase();
  let m = /^(high|low)-([12])$/.exec(s);
  if (m) return { mode: 'option1', tier: m[1], n: Number(m[2]), slot: s };
  m = /^mix-([12]):l([1-6])$/.exec(s);
  if (m) return { mode: 'option2', mix: Number(m[1]), level: Number(m[2]), slot: `mix-${m[1]}:L${m[2]}` };
  return null;
}

// A pick's genres, keeping only those `allowed` holds (Map lowercase → canonical).
export function keepAllowed(genres, allowed) {
  const out = [];
  for (const g of Array.isArray(genres) ? genres : []) {
    const c = allowed.get(String(g).toLowerCase());
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// A pick row → a direction object the builders take.
const asDirection = (pick, genres) => ({
  id: pick.source_direction_id || null,
  title_en: pick.title_en || '',
  genres,
  energy_range: Array.isArray(pick.energy_range) && pick.energy_range.length === 2 ? pick.energy_range : null,
  admin_pick: true,
});

// Option 1, one tier. pair = the usual draw ([] | [a, b]); pool = the tier's
// library; picks = this day's pick rows; allowed = Map lowercase → canonical of
// the genres approved in this tier.
//   - both slots picked → both picks;
//   - one slot picked → it, and the other slot gets the pool's direction least
//     like it (same rule as the usual draw);
//   - a pick whose genres are all gone is ignored.
// → [dirA, dirB] (each picked one carries admin_pick:true), or [] when the tier
//   has neither a library nor a pick.
export function applyOption1Picks(tier, pair, pool, picks, allowed, rng = Math.random) {
  const byN = new Map();
  for (const p of Array.isArray(picks) ? picks : []) {
    const s = parseSlot(p?.slot);
    if (!s || s.mode !== 'option1' || s.tier !== tier) continue;
    const genres = keepAllowed(p.genres, allowed);
    if (genres.length) byN.set(s.n, asDirection(p, genres));
  }
  if (!byN.size) return pair;
  const one = byN.get(1);
  const two = byN.get(2);
  if (one && two) return [one, two];
  const picked = one || two;
  const other = Array.isArray(pool) && pool.length ? leastAlike(pool, picked, rng) : picked;
  return one ? [one, other] : [other, two];
}

// Option 2. picks = pickLevelDirections' result (Array<Map<level, dir>>, one
// per mix); pickRows = this day's pick rows; genresByLevel = Map<level, [genre]>
// of approved genres; lib = the level library (Map<level, [dir]> in rotation
// order) the rotation came from. Returns a new array with the picked levels
// replaced. The mixes normally play different directions at each level; when
// an unpicked mix lands on the same genres as a pick at that level, it moves
// to the next direction of the rotation that differs (if the level has one).
export function applyOption2Picks(picks, pickRows, genresByLevel, lib = null) {
  if (!Array.isArray(picks)) return picks;
  const out = picks.map((m) => new Map(m));
  const picked = new Set();   // `${mix}:${level}`
  for (const p of Array.isArray(pickRows) ? pickRows : []) {
    const s = parseSlot(p?.slot);
    if (!s || s.mode !== 'option2' || !out[s.mix - 1]) continue;
    const allowed = new Map((genresByLevel.get(s.level) || []).map((g) => [String(g).toLowerCase(), g]));
    const genres = keepAllowed(p.genres, allowed);
    if (!genres.length) continue;
    out[s.mix - 1].set(s.level, asDirection(p, genres));
    picked.add(`${s.mix}:${s.level}`);
  }
  if (!picked.size || !lib) return out;
  const key = (d) => (d?.genres || []).map((g) => String(g).toLowerCase()).sort().join('|');
  for (const pk of picked) {
    const [mix, level] = pk.split(':').map(Number);
    const pickKey = key(out[mix - 1].get(level));
    const dirs = lib.get(level) || [];
    out.forEach((m, k) => {
      if (k === mix - 1 || picked.has(`${k + 1}:${level}`) || key(m.get(level)) !== pickKey) return;
      const taken = new Set(out.map((x) => key(x.get(level))));
      const from = Math.max(0, dirs.indexOf(m.get(level)));
      for (let i = 1; i <= dirs.length; i++) {
        const d = dirs[(from + i) % dirs.length];
        if (!taken.has(key(d))) { m.set(level, d); break; }
      }
    });
  }
  return out;
}
