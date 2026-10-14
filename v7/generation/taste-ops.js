// v7 taste chat ("הטעם המוזיקלי שלכם") — the changes the chat may make, as
// pure operations: no DB, no network, no clock. Server-reachable + offline
// tests (scripts/test-taste-ops.mjs). Bare imports only.
//
// The chat (api/v7/account/taste-chat.js) proposes a list of ops; when the
// owner confirms, api/v7/account/taste-apply.js reads the business's current
// state (stateFromRows), runs applyOps, writes the result (stateToRows) and
// logs the before/after snapshots (business_taste_changes — what undo
// restores). An op that doesn't fit the current state is dropped, never
// guessed at; the rest still apply.
//
// The state covers what the chat may touch (design agreed with Roni,
// 2026-10-13):
//   - the taste profile: approved genres + their energy levels, conditional,
//     requested (super-liked), rejected ("turned down" — never offered again),
//     per-genre weights (1 = today's mix), instrumental / well-known prefs
//     (Option 1 can hold "well-known" per tier — popTiers, 2026-10-14);
//   - the library of the CURRENT delivery mode only (the other mode's library
//     is rebuilt from the profile when the owner switches): Option 1 =
//     high/calm recipes (business_v7_directions), Option 2 = recipes per
//     energy level (business_v7_level_directions) with an optional energy
//     range each;
//   - Option 1's two energy windows (business_v7_settings.energy_windows);
//   - the owner's own songs (business_allowed_tracks).
// Recipes have short keys the chat refers to: Option 1 "H1".. (high) and
// "C1".. (calm), Option 2 "L2-1" (level 2, first recipe).

import { GENRES } from '../../shared/genre-universe.js';
import { tierOfLevel, tierPopularity } from './option1-draw.js';
import { normLevels } from './energy-timeline.js';
import { OPTION1_ENERGY_WINDOWS, levelEnergyWindow } from './energy-windows.js';
import { levelProfileKey } from './timeline-assembler.js';

export const WEIGHT_STEPS = [0.25, 0.5, 1, 1.5, 2];
export const MAX_OPTION1_DIRECTIONS = 30;   // = MAX_DIRECTIONS in energy-directions.js
export const MAX_LEVEL_DIRECTIONS = 10;     // per level, = MAX_PER_LEVEL in level-directions.js
export const MIN_RANGE_WIDTH = 10;
export const MAX_WINDOW_SHIFT = 30;
export const MAX_OPS = 40;

const CANON = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
export const canonicalGenre = (g) => (typeof g === 'string' ? CANON.get(g.trim().toLowerCase()) || null : null);
const PREFS = new Set(['none', 'soft', 'hard']);
const normPref = (v) => (PREFS.has(v) ? v : 'none');
// Option 1's "well-known songs" per tier (business_taste_profiles.
// popularity_tiers): { high, low } when the two tiers differ, else null (both
// follow the account's popularity_preference).
const normPopTiers = (t, pop) => {
  if (!t || typeof t !== 'object') return null;
  const high = PREFS.has(t.high) ? t.high : pop;
  const low = PREFS.has(t.low) ? t.low : pop;
  return high === low ? null : { high, low };
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const uniq = (xs) => [...new Set(xs)];
const setKey = (genres) => [...genres].sort().join('|');

// Nearest weight step, or null for junk / zero / negative.
export function snapWeight(w) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return null;
  return WEIGHT_STEPS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), WEIGHT_STEPS[0]);
}

const window2 = (w, fallback) => {
  const lo = Number(Array.isArray(w) ? w[0] : w?.min);
  const hi = Number(Array.isArray(w) ? w[1] : w?.max);
  return Number.isFinite(lo) && Number.isFinite(hi) && lo < hi ? [Math.round(lo), Math.round(hi)] : [fallback.min, fallback.max];
};

// ---- rows → state ----
//   profile      business_taste_profiles row
//   settings     business_v7_settings row (energy_windows)
//   option1Rows  active business_v7_directions rows
//   levelRows    active business_v7_level_directions rows
//   allowedRows  live business_allowed_tracks rows
export function stateFromRows({ mode, profile, settings = null, option1Rows = [], levelRows = [], allowedRows = [] }) {
  const N = normLevels(profile?.energy_levels_total);
  const clampL = (l) => Math.min(N, Math.max(1, Math.round(Number(l) || 1)));
  const approved = [];
  const seen = new Set();
  for (const a of Array.isArray(profile?.approved_genres) ? profile.approved_genres : []) {
    const g = canonicalGenre(typeof a === 'string' ? a : a?.genre);
    if (!g || seen.has(g)) continue;
    seen.add(g);
    approved.push({ genre: g, energy_level: clampL(a?.energy_level) });
  }
  const conditional = [];
  for (const c of Array.isArray(profile?.conditional_genres) ? profile.conditional_genres : []) {
    const g = canonicalGenre(c?.genre);
    if (!g || seen.has(g)) continue;
    seen.add(g);
    conditional.push({ genre: g, energy_level: clampL(c?.energy_level), note_en: typeof c?.note_en === 'string' ? c.note_en : '' });
  }
  const canonList = (xs) => uniq((Array.isArray(xs) ? xs : []).map(canonicalGenre).filter(Boolean));
  const weights = {};
  for (const [g, w] of Object.entries(profile?.genre_weights && typeof profile.genre_weights === 'object' ? profile.genre_weights : {})) {
    const cg = canonicalGenre(g);
    const sw = snapWeight(w);
    if (cg && sw != null && sw !== 1) weights[cg] = sw;
  }

  const pop = normPref(profile?.popularity_preference);
  const ew = settings?.energy_windows || {};
  const windows = {
    high: window2(ew.high, OPTION1_ENERGY_WINDOWS.high),
    low: window2(ew.low, OPTION1_ENERGY_WINDOWS.low),
  };

  const counters = { high: 0, low: 0 };
  const option1Dirs = [...(Array.isArray(option1Rows) ? option1Rows : [])]
    .filter((r) => r && (r.energy_tier === 'high' || r.energy_tier === 'low'))
    .sort((a, b) => (a.energy_tier === b.energy_tier ? (a.rank ?? 1e9) - (b.rank ?? 1e9) : a.energy_tier === 'high' ? -1 : 1))
    .map((r) => ({
      key: `${r.energy_tier === 'high' ? 'H' : 'C'}${++counters[r.energy_tier]}`,
      energy_tier: r.energy_tier,
      title_en: r.title_en || '',
      genres: canonList(r.genres),
    }));

  const perLevel = new Map();
  const levelDirs = [...(Array.isArray(levelRows) ? levelRows : [])]
    .filter((r) => r && Number.isInteger(Number(r.energy_level)))
    .sort((a, b) => (a.energy_level - b.energy_level) || ((a.rank ?? 1e9) - (b.rank ?? 1e9)))
    .map((r) => {
      const L = clampL(r.energy_level);
      perLevel.set(L, (perLevel.get(L) || 0) + 1);
      const range = Array.isArray(r.energy_range) && r.energy_range.length === 2 ? window2(r.energy_range, levelEnergyWindow(L, N)) : null;
      return { key: `L${L}-${perLevel.get(L)}`, energy_level: L, title_en: r.title_en || '', genres: canonList(r.genres), energy_range: range };
    });

  const allowed = (Array.isArray(allowedRows) ? allowedRows : [])
    .map((r) => ({
      spotify_id: String(r.spotify_id || ''),
      genre: canonicalGenre(r.genre),
      title: r.title || '',
      artist: r.artist || '',
      duration_sec: Number.isFinite(Number(r.duration_sec)) ? Number(r.duration_sec) : null,
    }))
    .filter((r) => r.spotify_id && r.genre);

  return {
    mode: mode === 'option2' ? 'option2' : 'option1',
    N,
    approved,
    conditional,
    requested: canonList(profile?.requested_genres).filter((g) => approved.some((a) => a.genre === g)),
    rejected: canonList(profile?.rejected_genres),
    weights,
    inst: normPref(profile?.instrumentalness_preference),
    pop,
    popTiers: normPopTiers(profile?.popularity_tiers, pop),
    windows,
    option1Dirs,
    levelDirs,
    allowed,
  };
}

// What undo restores and the change log stores: every part the ops can touch.
export function snapshotOf(state) {
  const { approved, conditional, requested, rejected, weights, inst, pop, popTiers = null, windows, option1Dirs, levelDirs, allowed } = state;
  return clone({ approved, conditional, requested, rejected, weights, inst, pop, popTiers, windows, option1Dirs, levelDirs, allowed });
}

// A snapshot from before popTiers existed (2026-10-14) had no per-tier value.
export function stateFromSnapshot(base, snap) {
  return { ...clone(base), popTiers: null, ...clone(snap) };
}

// "Well-known songs" of one Option 1 tier ('high' | 'low').
export const popularityOfTier = (state, tier) => tierPopularity(state.pop, state.popTiers, tier);

// ---- lookups ----
const levelOfGenre = (s, g) => s.approved.find((a) => a.genre === g)?.energy_level ?? null;
const isApproved = (s, g) => s.approved.some((a) => a.genre === g);
const tierOf = (s, g) => {
  const L = levelOfGenre(s, g);
  return L == null ? null : tierOfLevel(L, s.N);
};
// Effective range of an Option 2 recipe: its own, or its level's default.
export function rangeOf(dir, N) {
  if (Array.isArray(dir?.energy_range)) return dir.energy_range;
  const w = levelEnergyWindow(dir.energy_level, N);
  return [w.min, w.max];
}
const library = (s) => (s.mode === 'option2' ? s.levelDirs : s.option1Dirs);
const findDir = (s, key) => library(s).find((d) => d.key === String(key || '').trim().toUpperCase());
const fitsDir = (s, dir, g) => (s.mode === 'option2'
  ? levelOfGenre(s, g) === dir.energy_level
  : tierOf(s, g) === dir.energy_tier);

function nextKey(s, { tier, level }) {
  if (s.mode === 'option2') {
    const n = s.levelDirs.filter((d) => d.energy_level === level).length;
    let i = n + 1;
    while (s.levelDirs.some((d) => d.key === `L${level}-${i}`)) i++;
    return `L${level}-${i}`;
  }
  const p = tier === 'high' ? 'H' : 'C';
  let i = s.option1Dirs.filter((d) => d.energy_tier === tier).length + 1;
  while (s.option1Dirs.some((d) => d.key === `${p}${i}`)) i++;
  return `${p}${i}`;
}

function addApproved(s, g, level) {
  const L = Math.min(s.N, Math.max(1, Math.round(Number(level) || Math.ceil(s.N / 2))));
  s.approved.push({ genre: g, energy_level: L });
  s.conditional = s.conditional.filter((c) => c.genre !== g);
  s.rejected = s.rejected.filter((x) => x !== g);
}

// ---- the ops ----
// Each handler mutates the working state, or returns a reason it can't apply.
const HANDLERS = {
  set_weight(s, op) {
    const g = canonicalGenre(op.genre);
    if (!g || !isApproved(s, g)) return 'not one of the approved genres';
    const w = snapWeight(op.weight);
    if (w == null) return 'weight must be one of 0.25, 0.5, 1, 1.5, 2';
    if (w === 1) delete s.weights[g];
    else s.weights[g] = w;
    return null;
  },

  remove_genre(s, op, ctx) {
    const g = canonicalGenre(op.genre);
    if (!g) return 'unknown genre';
    if (!isApproved(s, g) && !s.conditional.some((c) => c.genre === g)) return 'not in the profile';
    s.approved = s.approved.filter((a) => a.genre !== g);
    s.conditional = s.conditional.filter((c) => c.genre !== g);
    s.requested = s.requested.filter((x) => x !== g);
    delete s.weights[g];
    if (!s.rejected.includes(g)) s.rejected.push(g);
    for (const d of [...s.option1Dirs, ...s.levelDirs]) d.genres = d.genres.filter((x) => x !== g);
    ctx.touched.delete(g);
    return null;
  },

  reject_genre(s, op) {
    const g = canonicalGenre(op.genre);
    if (!g) return 'unknown genre';
    if (isApproved(s, g)) return 'approved — use remove_genre';
    s.conditional = s.conditional.filter((c) => c.genre !== g);
    if (!s.rejected.includes(g)) s.rejected.push(g);
    return null;
  },

  add_genre(s, op, ctx) {
    const g = canonicalGenre(op.genre);
    if (!g) return 'not a genre from the catalog';
    if (isApproved(s, g)) return 'already approved';
    const L = Number(op.energy_level);
    if (!Number.isInteger(L) || L < 1 || L > s.N) return `energy_level must be 1..${s.N}`;
    addApproved(s, g, L);
    ctx.touched.add(g);
    return null;
  },

  move_genre(s, op, ctx) {
    const g = canonicalGenre(op.genre);
    if (!g || !isApproved(s, g)) return 'not one of the approved genres';
    const L = Number(op.energy_level);
    if (!Number.isInteger(L) || L < 1 || L > s.N) return `energy_level must be 1..${s.N}`;
    const a = s.approved.find((x) => x.genre === g);
    if (a.energy_level === L) return 'already at that level';
    a.energy_level = L;
    ctx.touched.add(g);
    return null;
  },

  set_requested(s, op, ctx) {
    const g = canonicalGenre(op.genre);
    if (!g) return 'not a genre from the catalog';
    if (!isApproved(s, g)) {
      const L = Number(op.energy_level);
      if (!Number.isInteger(L) || L < 1 || L > s.N) return `not approved yet — energy_level 1..${s.N} needed`;
      addApproved(s, g, L);
      ctx.touched.add(g);
    }
    if (!s.requested.includes(g)) s.requested.push(g);
    return null;
  },

  dir_add(s, op) {
    const d = findDir(s, op.dir);
    if (!d) return 'no such recipe';
    const g = canonicalGenre(op.genre);
    if (!g || !isApproved(s, g)) return 'not one of the approved genres';
    if (!fitsDir(s, d, g)) return s.mode === 'option2' ? 'genre is at another energy level' : 'genre is in the other energy tier';
    if (!d.genres.includes(g)) d.genres.push(g);
    return null;
  },

  dir_remove(s, op) {
    const d = findDir(s, op.dir);
    if (!d) return 'no such recipe';
    const g = canonicalGenre(op.genre);
    if (!g || !d.genres.includes(g)) return 'genre is not in that recipe';
    d.genres = d.genres.filter((x) => x !== g);
    return null;
  },

  dir_new(s, op) {
    const genres = uniq((Array.isArray(op.genres) ? op.genres : []).map(canonicalGenre).filter(Boolean));
    if (s.mode === 'option2') {
      const L = Number(op.energy_level);
      if (!Number.isInteger(L) || L < 1 || L > s.N) return `energy_level must be 1..${s.N}`;
      if (s.levelDirs.filter((d) => d.energy_level === L).length >= MAX_LEVEL_DIRECTIONS) return 'that level already has the most recipes allowed';
      const fit = genres.filter((g) => levelOfGenre(s, g) === L);
      if (!fit.length) return 'no approved genre of that level';
      s.levelDirs.push({ key: nextKey(s, { level: L }), energy_level: L, title_en: String(op.title_en || '').slice(0, 120), genres: fit, energy_range: null });
      return null;
    }
    const tier = op.tier === 'high' || op.tier === 'low' ? op.tier : null;
    if (!tier) return 'tier must be "high" or "low"';
    if (s.option1Dirs.length >= MAX_OPTION1_DIRECTIONS) return 'the library already has the most recipes allowed';
    const fit = genres.filter((g) => tierOf(s, g) === tier);
    if (!fit.length) return 'no approved genre of that tier';
    s.option1Dirs.push({ key: nextKey(s, { tier }), energy_tier: tier, title_en: String(op.title_en || '').slice(0, 120), genres: fit });
    return null;
  },

  dir_delete(s, op) {
    const d = findDir(s, op.dir);
    if (!d) return 'no such recipe';
    if (s.mode === 'option2') s.levelDirs = s.levelDirs.filter((x) => x !== d);
    else s.option1Dirs = s.option1Dirs.filter((x) => x !== d);
    return null;
  },

  // popularity also takes a tier in Option 1 (Ami, 2026-10-14): "high" or
  // "low" sets that tier only; no tier sets the whole account and clears the
  // per-tier values. Two equal tiers fold back into the account's value.
  set_pref(s, op) {
    const v = PREFS.has(op.value) ? op.value : null;
    if (!v) return 'value must be none, soft or hard';
    const tier = op.tier == null || op.tier === '' || op.tier === 'both' ? null : op.tier;
    if (op.field === 'instrumentalness') {
      if (tier) return 'tier is for popularity only';
      s.inst = v;
      return null;
    }
    if (op.field !== 'popularity') return 'field must be instrumentalness or popularity';
    if (!tier) {
      s.pop = v;
      s.popTiers = null;
      return null;
    }
    if (tier !== 'high' && tier !== 'low') return 'tier must be "high" or "low", or left out for both';
    if (s.mode !== 'option1') return 'tier is for Option 1 only';
    const t = { high: popularityOfTier(s, 'high'), low: popularityOfTier(s, 'low'), [tier]: v };
    if (t.high === t.low) { s.pop = t.high; s.popTiers = null; }
    else s.popTiers = t;
    return null;
  },

  // Option 1: shift one tier's window, keeping its width, inside 0–100.
  shift_window(s, op) {
    if (s.mode !== 'option1') return 'Option 1 only';
    const tier = op.tier === 'high' || op.tier === 'low' ? op.tier : null;
    if (!tier) return 'tier must be "high" or "low"';
    const delta = Math.round(Number(op.delta));
    if (!Number.isFinite(delta) || !delta || Math.abs(delta) > MAX_WINDOW_SHIFT) return `delta must be a non-zero whole number up to ${MAX_WINDOW_SHIFT}`;
    let [lo, hi] = s.windows[tier];
    lo += delta;
    hi += delta;
    if (hi > 100) { lo -= hi - 100; hi = 100; }
    if (lo < 0) { hi -= lo; lo = 0; }
    if (lo === s.windows[tier][0]) return 'the window is already at the edge of the scale';
    s.windows[tier] = [lo, hi];
    return null;
  },

  // Option 2: one recipe's range.
  set_range(s, op) {
    if (s.mode !== 'option2') return 'Option 2 only';
    const d = findDir(s, op.dir);
    if (!d) return 'no such recipe';
    const lo = Math.round(Number(op.min));
    const hi = Math.round(Number(op.max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi > 100 || hi - lo < MIN_RANGE_WIDTH) {
      return `min/max must be within 0–100 and at least ${MIN_RANGE_WIDTH} apart`;
    }
    const def = levelEnergyWindow(d.energy_level, s.N);
    d.energy_range = lo === def.min && hi === def.max ? null : [lo, hi];
    return null;
  },

  // A song the owner sent as a Spotify link (resolved by the server this
  // session — ctx.linkedTracks), under one of their approved genres.
  allow_track(s, op, ctx) {
    const id = String(op.spotify_id || '').trim();
    const t = ctx.linkedTracks.get(id);
    if (!t) return 'not a song the owner linked in this conversation';
    const g = canonicalGenre(op.genre);
    if (!g || !isApproved(s, g)) return 'genre must be one of the approved genres';
    s.allowed = s.allowed.filter((a) => a.spotify_id !== id);
    s.allowed.push({ spotify_id: id, genre: g, title: t.title || '', artist: t.artist || '', duration_sec: t.duration_sec ?? null });
    ctx.allowedAdded.push(id);
    return null;
  },
};

export const OP_NAMES = Object.keys(HANDLERS);

// After the ops: keep every recipe consistent with the profile.
//   - drop genres no longer approved, or now in another tier / level;
//   - drop empty recipes and repeated genre sets;
//   - a genre the ops added or moved that no recipe of its tier/level plays
//     gets a recipe of its own (Option 1: requested genres are exempt — every
//     playlist of their tier gets them at build time);
//   - Option 1: a tier with approved genres but no recipe gets one with them;
//   - requested / weights / rejected / conditional stay consistent.
function finalize(s, ctx) {
  const lv = new Map(s.approved.map((a) => [a.genre, a.energy_level]));
  const clean = (dirs, fits) => {
    const seen = new Set();
    return dirs
      .map((d) => ({ ...d, genres: uniq(d.genres.filter((g) => lv.has(g) && fits(d, g))) }))
      .filter((d) => {
        if (!d.genres.length) return false;
        const k = `${d.energy_tier || d.energy_level}|${setKey(d.genres)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  };
  s.option1Dirs = clean(s.option1Dirs, (d, g) => tierOfLevel(lv.get(g), s.N) === d.energy_tier);
  s.levelDirs = clean(s.levelDirs, (d, g) => lv.get(g) === d.energy_level);

  for (const g of ctx.touched) {
    if (!lv.has(g)) continue;
    if (s.mode === 'option2') {
      const L = lv.get(g);
      const atLevel = s.levelDirs.filter((d) => d.energy_level === L);
      if (atLevel.length && !atLevel.some((d) => d.genres.includes(g)) && atLevel.length < MAX_LEVEL_DIRECTIONS) {
        s.levelDirs.push({ key: nextKey(s, { level: L }), energy_level: L, title_en: g, genres: [g], energy_range: null });
        ctx.notes.push(`gave ${g} a recipe of its own`);
      }
    } else if (!s.requested.includes(g)) {
      const tier = tierOfLevel(lv.get(g), s.N);
      if (!s.option1Dirs.some((d) => d.energy_tier === tier && d.genres.includes(g)) && s.option1Dirs.length < MAX_OPTION1_DIRECTIONS) {
        s.option1Dirs.push({ key: nextKey(s, { tier }), energy_tier: tier, title_en: g, genres: [g] });
        ctx.notes.push(`gave ${g} a recipe of its own`);
      }
    }
  }
  if (s.mode === 'option1') {
    for (const tier of ['high', 'low']) {
      const genres = s.approved.filter((a) => tierOfLevel(a.energy_level, s.N) === tier).map((a) => a.genre);
      if (genres.length && !s.option1Dirs.some((d) => d.energy_tier === tier)) {
        s.option1Dirs.push({ key: nextKey(s, { tier }), energy_tier: tier, title_en: `All ${tier} genres`, genres });
        ctx.notes.push(`the ${tier} tier had no recipe left — made one from all its genres`);
      }
    }
  }
  s.requested = s.requested.filter((g) => lv.has(g));
  for (const g of Object.keys(s.weights)) if (!lv.has(g)) delete s.weights[g];
  s.rejected = uniq(s.rejected.filter((g) => !lv.has(g)));
  s.conditional = s.conditional.filter((c) => !lv.has(c.genre));
}

// Run a proposal's ops on a copy of the state.
//   ops          [{ op, ...fields }]
//   linkedTracks Map<spotify_id, { title, artist, duration_sec }> — songs the
//                server resolved from links in this conversation
// → { state, applied: [op], dropped: [{ op, reason }], allowedAdded: [id],
//     notes: [string], changed: boolean }
export function applyOps(state, ops, { linkedTracks = new Map() } = {}) {
  const s = clone(state);
  const ctx = { touched: new Set(), linkedTracks, allowedAdded: [], notes: [] };
  const applied = [];
  const dropped = [];
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, MAX_OPS)) {
    const fn = op && typeof op === 'object' ? HANDLERS[op.op] : null;
    if (!fn) { dropped.push({ op, reason: 'unknown op' }); continue; }
    const reason = fn(s, op, ctx);
    if (reason) dropped.push({ op, reason });
    else applied.push(op);
  }
  finalize(s, ctx);
  const changed = JSON.stringify(snapshotOf(s)) !== JSON.stringify(snapshotOf(state));
  return { state: s, applied, dropped, allowedAdded: ctx.allowedAdded, notes: ctx.notes, changed };
}

// ---- state → rows to write ----
//   profile   patch for business_taste_profiles (excluded = the rest of the catalog)
//   settings  patch for business_v7_settings (Option 1's windows; null when default)
//   option1Rows / levelRows  the current mode's library, replace-all (the
//             other one is null — untouched)
//   allowed   the live business_allowed_tracks set
export function stateToRows(state, businessId) {
  const approvedSet = new Set(state.approved.map((a) => a.genre));
  const condSet = new Set(state.conditional.map((c) => c.genre));
  const profile = {
    approved_genres: state.approved.map((a) => ({ genre: a.genre, energy_level: a.energy_level })),
    conditional_genres: state.conditional.map((c) => ({ genre: c.genre, energy_level: c.energy_level, note_en: c.note_en || '' })),
    excluded_genres: GENRES.filter((g) => !approvedSet.has(g) && !condSet.has(g)),
    requested_genres: state.requested,
    rejected_genres: state.rejected,
    genre_weights: Object.keys(state.weights).length ? state.weights : null,
    instrumentalness_preference: state.inst,
    popularity_preference: state.pop,
    popularity_tiers: state.popTiers || null,
  };
  const d = OPTION1_ENERGY_WINDOWS;
  const isDefault = state.windows.high[0] === d.high.min && state.windows.high[1] === d.high.max
    && state.windows.low[0] === d.low.min && state.windows.low[1] === d.low.max;
  const settings = { energy_windows: isDefault ? null : { high: state.windows.high, low: state.windows.low } };

  let option1Rows = null;
  let levelRows = null;
  if (state.mode === 'option1') {
    const rank = { high: 0, low: 0 };
    option1Rows = state.option1Dirs.map((x) => ({
      business_id: businessId, energy_tier: x.energy_tier, rank: ++rank[x.energy_tier],
      title_en: x.title_en || '(untitled)', genres: x.genres, active: true,
    }));
  } else {
    const key = levelProfileKey({ energy_levels_total: state.N, approved_genres: state.approved });
    const rank = new Map();
    levelRows = state.levelDirs.map((x) => {
      rank.set(x.energy_level, (rank.get(x.energy_level) || 0) + 1);
      return {
        business_id: businessId, energy_level: x.energy_level, rank: rank.get(x.energy_level),
        title_en: x.title_en || '(untitled)', genres: x.genres, profile_key: key,
        energy_range: x.energy_range, active: true,
      };
    });
  }
  const allowed = state.allowed.map((a) => ({
    business_id: businessId, spotify_id: a.spotify_id, genre: a.genre,
    title: a.title || null, artist: a.artist || null, duration_sec: a.duration_sec ?? null,
  }));
  return { profile, settings, option1Rows, levelRows, allowed };
}
