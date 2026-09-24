// v7 Option-2 playlist assembler — pure (no DB, no network, no Date.now).
// Given the owner's energy curve, the taste profile's genres per energy level
// and a candidate track pool per genre, lays tracks end to end BY DURATION so
// the playlist's energy follows the curve through the day (assuming play
// starts at the window start).
//
// Genre flow (Roni, 2026-09-24): SHORT RUNS — 3–5 songs from one genre, then
// another genre at the same level; a level change starts a new run; the next
// run avoids the genre that just played when there's an alternative.
// Two mixes are built side by side (the one further behind in time advances
// next, so scarce genres are shared fairly) and never share a track.
//
// Randomness comes only from the injected `rng` — tests pass a seeded
// mulberry32; the builder seeds from a random UUID and stores the seed.
//
// Server-reachable: bare imports only.

import { levelOf, effectiveLevel, normLevels } from './energy-timeline.js';

export const DEFAULT_TRACK_SEC = 250;     // unknown duration → ~catalog mean (4.16 min measured 2026-09-24)
export const RUN_MIN = 3;
export const RUN_MAX = 5;
export const MAX_TRACKS_PER_MIX = 400;

// ---- seeded RNG ----
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// String → 32-bit seed (xmur3).
export function seedFrom(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- demand → how many tracks to fetch per genre ----
// Samples the curve every 5 minutes over [startMin, endMin), converts minutes
// per (effective) level into tracks for all mixes, and spreads that over the
// level's genres with 1.5× headroom (+8). Every genre gets at least 10 so a
// level fallback has something to fall back on. `playlists` = how many random
// catalog playlists the pool RPC samples for that genre (3× when a hard
// instrumental/popularity filter will throw most tracks away).
export function estimateDemand({ startMin, endMin, energyAt, N, genresByLevel, mixes = 2, avgSec = DEFAULT_TRACK_SEC, hardPref = false }) {
  const n = normLevels(N);
  const has = (L) => (genresByLevel.get(L) || []).length > 0;
  const minsByLevel = new Map();
  const STEP = 5;
  for (let m = startMin; m < endMin; m += STEP) {
    const L = effectiveLevel(energyAt(m + STEP / 2), n, has);
    if (L == null) continue;
    minsByLevel.set(L, (minsByLevel.get(L) || 0) + Math.min(STEP, endMin - m));
  }
  const specs = [];
  for (const [L, genres] of genresByLevel) {
    if (!genres.length) continue;
    const need = Math.ceil(((minsByLevel.get(L) || 0) * 60 * mixes) / avgSec);
    const perGenre = Math.ceil((1.5 * need) / genres.length) + 8;
    for (const genre of genres) {
      const count = Math.min(600, Math.max(10, perGenre));
      const playlists = Math.min(200, (Math.ceil(count / 6) + 6) * (hardPref ? 3 : 1));
      specs.push({ genre, level: L, n: count, playlists });
    }
  }
  return { specs, minsByLevel };
}

function pickGenre(cands, { avoid, softAvoid, remaining, rng }) {
  let pool = cands.filter((g) => g !== avoid);
  if (!pool.length) pool = cands;
  const narrowed = pool.filter((g) => !softAvoid.includes(g));
  if (narrowed.length) pool = narrowed;
  const weights = pool.map((g) => Math.sqrt(Math.max(1, remaining(g))));
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

// ---- the assembler ----
//   startMin/endMin  window (minutes on the business day's clock)
//   energyAt(min)    → 0..1
//   N                profile energy levels (grid rows)
//   genresByLevel    Map<level, genre[]>   (taste profile's approved genres)
//   pools            Map<genre, [{ id, sec }]> in preference order (fresh
//                    tracks first, recently-served refill after) — already
//                    shuffled by the caller
//   → { mixes: [{ tracks: [{ id, genre, level, startMin, sec }], endMin }],
//       stats: { short, nullDurations, levelFallbacks } }
export function assembleMixes({
  startMin, endMin, energyAt, N, genresByLevel, pools, rng,
  mixes = 2, runMin = RUN_MIN, runMax = RUN_MAX, defaultSec = DEFAULT_TRACK_SEC, maxTracks = MAX_TRACKS_PER_MIX,
}) {
  const n = normLevels(N);
  const used = new Set();
  const ptr = new Map();
  const skipUsed = (g) => {
    const list = pools.get(g) || [];
    let i = ptr.get(g) || 0;
    while (i < list.length && used.has(list[i].id)) i++;
    ptr.set(g, i);
    return i;
  };
  const remaining = (g) => (pools.get(g) || []).length - skipUsed(g);
  const next = (g) => {
    const i = skipUsed(g);
    const list = pools.get(g) || [];
    if (i >= list.length) return null;
    ptr.set(g, i + 1);
    return list[i];
  };
  const levelGenres = (L) => (genresByLevel.get(L) || []).filter((g) => remaining(g) > 0);
  const available = (L) => levelGenres(L).length > 0;

  const state = Array.from({ length: mixes }, () => ({
    cursor: startMin, tracks: [], runGenre: null, runLeft: 0, runLevel: null, done: false,
  }));
  const stats = { short: false, nullDurations: 0, levelFallbacks: 0 };

  for (;;) {
    let k = -1;
    for (let i = 0; i < mixes; i++) if (!state[i].done && (k < 0 || state[i].cursor < state[k].cursor)) k = i;
    if (k < 0) break;
    const s = state[k];
    if (s.cursor >= endMin || s.tracks.length >= maxTracks) { s.done = true; continue; }

    // Sample ~half a minute into the next track: the level the listener
    // actually hears at that point of the day.
    const e = energyAt(s.cursor + 2);
    const L = effectiveLevel(e, n, available);
    if (L == null) { s.done = true; stats.short = true; continue; }

    if (s.runLevel !== L || s.runLeft <= 0 || !s.runGenre || remaining(s.runGenre) <= 0) {
      if (L !== levelOf(e, n)) stats.levelFallbacks++;
      const softAvoid = state.filter((_, i) => i !== k).map((o) => o.runGenre).filter(Boolean);
      s.runGenre = pickGenre(levelGenres(L), { avoid: s.runGenre, softAvoid, remaining, rng });
      s.runLevel = L;
      s.runLeft = runMin + Math.floor(rng() * (runMax - runMin + 1));
    }

    const t = next(s.runGenre);
    if (!t) { s.runLeft = 0; continue; }
    used.add(t.id);
    let sec = Number(t.sec);
    if (!Number.isFinite(sec) || sec <= 0) { sec = defaultSec; stats.nullDurations++; }
    s.tracks.push({ id: t.id, genre: s.runGenre, level: L, startMin: Math.round(s.cursor * 100) / 100, sec });
    s.cursor += sec / 60;
    s.runLeft--;
  }

  const out = state.map((s) => ({ tracks: s.tracks, endMin: s.cursor }));
  if (out.some((m) => m.endMin < endMin)) stats.short = true;
  return { mixes: out, stats };
}
