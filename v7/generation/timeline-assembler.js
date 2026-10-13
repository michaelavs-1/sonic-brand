// v7 Option-2 playlist assembler — pure (no DB, no network, no Date.now).
// Given the owner's energy curve, the taste profile's genres per energy level
// and a candidate track pool per genre, lays tracks end to end BY DURATION so
// the playlist's energy follows the curve through the day (assuming play
// starts at the window start).
//
// Genre flow (Roni, 2026-09-28 — replaces the 2026-09-24 "3–5-song genre
// runs"): every track's genre is drawn at random from the genres the mix
// plays at that level, weighted by how many unused tracks each has left —
// the same odds as drawing one track from their combined pool, i.e. how
// Option 1 mixes a direction's genres. No runs, no alternation rule.
// Two mixes are built side by side (the one further behind in time advances
// next, so scarce genres are shared fairly) and never share a track.
//
// Level directions (Roni, 2026-09-28): each energy level has a LIBRARY of
// directions (business_v7_level_directions, v7/generation/level-directions.js).
// On a given day each mix plays ONE direction per level — the two mixes get
// different ones when the level has 2+ — and the next day every level moves
// on to its next direction (pickLevelDirections: a cycle computed from the
// business-day date, so a same-day rebuild keeps the day's directions). The
// assembler then takes one genre map PER MIX, so each track's genre comes
// from that mix's direction. levelProfileKey fingerprints the taste
// profile a library was built from, so the dashboard can tell whether a
// stored library still fits.
//
// Energy ranges (Roni, 2026-10-13): each level has a range of track energy
// (v7/generation/energy-windows.js). Every pool track carries a `ring` — how
// many 5-point steps outside its level's range its energy is (0 = inside,
// computed by the v7_timeline_pool RPC) — and which side of the range it's on.
// The genre draw only considers the level's genres whose next track is the
// most preferred one left: a level uses all its in-range songs, across all
// its genres, before the range widens, and widens fully before a song from
// the last 7 days comes back. When it widens, it takes ONE side at a time:
// the side the curve leans to at that moment (the upper half of the level's
// row → the slightly more energetic songs, the lower half → the calmer ones),
// nearest first, and the other side only once that one is used up — so a
// widened stretch doesn't swing between both edges. With every ring 0 (no
// ranges) the draw is exactly the one described above.
//
// Randomness comes only from the injected `rng` — tests pass a seeded
// mulberry32; the builder seeds from a random UUID and stores the seed.
//
// Server-reachable: bare imports only.

import { levelOf, effectiveLevel, normLevels } from './energy-timeline.js';

// ---- level directions: daily rotation + profile fingerprint ----

// 'YYYY-MM-DD' → days since 1970-01-01 (UTC calendar arithmetic, no clock).
export function dayNumber(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''));
  if (!m) return 0;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

// dirsByLevel: Map<level, direction[]> in rotation order (rank).
// → one Map<level, direction> per mix. For a level with K directions and
// d = dayNumber(isoDate), mix k plays dirs[(d + floor(k·K/mixes)) mod K]:
// with 2 mixes, #1 = d mod K and #2 = half a cycle ahead. Each mix moves to
// the next direction every day and goes through all K before repeating; the
// two mixes differ whenever K ≥ 2; K = 1 → both play the level's only one.
export function pickLevelDirections(dirsByLevel, isoDate, mixes = 2) {
  const d = dayNumber(isoDate);
  const out = Array.from({ length: mixes }, () => new Map());
  for (const [L, dirs] of dirsByLevel) {
    const K = Array.isArray(dirs) ? dirs.length : 0;
    if (!K) continue;
    for (let k = 0; k < mixes; k++) out[k].set(L, dirs[(d + Math.floor((k * K) / mixes)) % K]);
  }
  return out;
}

// Fingerprint of what a level library depends on: N + every approved genre
// with its level (read exactly like the builder reads them). Changes when a
// genre is added, removed or moved to another level; order-independent.
export function levelProfileKey(tasteProfile) {
  const N = normLevels(tasteProfile?.energy_levels_total);
  const items = new Set();
  for (const a of Array.isArray(tasteProfile?.approved_genres) ? tasteProfile.approved_genres : []) {
    const g = String((typeof a === 'string' ? a : a?.genre) || '').trim().toLowerCase();
    if (!g) continue;
    const L = Math.min(N, Math.max(1, Math.round(Number(a?.energy_level) || 1)));
    items.add(`${g}@${L}`);
  }
  const str = `${N}|${[...items].sort().join('|')}`;
  const hex = (x) => seedFrom(x).toString(16).padStart(8, '0');
  return `v1-${hex(str)}${hex(`#${str}`)}`;
}

export const DEFAULT_TRACK_SEC = 250;     // unknown duration → ~catalog mean (4.16 min measured 2026-09-24)
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

// estimateDemand when every mix has its own genres per level (level
// directions): demand per mix (mixes: 1), merged per genre. Each approved
// genre sits in exactly one level, so a merged spec keeps a single level.
// → { specs, minsByLevelPerMix }
export function estimateDemandPerMix({ startMin, endMin, energyAt, N, genresByLevelPerMix, avgSec = DEFAULT_TRACK_SEC, hardPref = false }) {
  const merged = new Map();
  const minsByLevelPerMix = [];
  for (const genresByLevel of genresByLevelPerMix) {
    const { specs, minsByLevel } = estimateDemand({ startMin, endMin, energyAt, N, genresByLevel, mixes: 1, avgSec, hardPref });
    minsByLevelPerMix.push(minsByLevel);
    for (const sp of specs) {
      const prev = merged.get(sp.genre);
      merged.set(sp.genre, prev ? { ...prev, n: prev.n + sp.n } : { ...sp });
    }
  }
  const specs = [...merged.values()].map((sp) => {
    const n = Math.min(600, sp.n);
    return { ...sp, n, playlists: Math.min(200, (Math.ceil(n / 6) + 6) * (hardPref ? 3 : 1)) };
  });
  return { specs, minsByLevelPerMix };
}

// A random genre among `cands` (all with unused tracks left), weighted by
// how many each has left — the odds of one track drawn from their combined pool.
function pickGenre(cands, remaining, rng) {
  const weights = cands.map((g) => remaining(g));
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) { r -= weights[i]; if (r < 0) return cands[i]; }
  return cands[cands.length - 1];
}

// ---- the assembler ----
//   startMin/endMin  window (minutes on the business day's clock)
//   energyAt(min)    → 0..1
//   N                profile energy levels (grid rows)
//   genresByLevel    Map<level, genre[]>   (taste profile's approved genres),
//                    or an array of such Maps, one per mix (today's level
//                    directions — mix k only plays genres from its own Map)
//   pools            Map<genre, [{ id, sec, energy?, ring?, side?, refill? }]>
//                    shuffled by the caller. ring = 5-point steps outside the
//                    level's energy range (missing = 0 = inside); side = -1
//                    below the range / 1 above it; refill = recently served.
//   → { mixes: [{ tracks: [{ id, genre, level, startMin, sec, energy }], endMin }],
//       stats: { short, nullDurations, levelFallbacks, widened, repeats } }
//   (levelFallbacks = tracks placed at a nearby level because the curve's
//   own level had nothing left for that mix; widened = fresh tracks from
//   outside their level's energy range; repeats = refill tracks)
export function assembleMixes({
  startMin, endMin, energyAt, N, genresByLevel, pools, rng,
  mixes = 2, defaultSec = DEFAULT_TRACK_SEC, maxTracks = MAX_TRACKS_PER_MIX,
}) {
  const n = normLevels(N);
  const used = new Set();
  const ringOf = (t) => Number(t?.ring) || 0;
  // Each genre's tracks in queues: fresh / refill × inside the range / below
  // it / above it / outside with no known side; each queue in ring order
  // (stable, so a ring keeps the caller's shuffle).
  const sideOf = (t) => (ringOf(t) === 0 ? 'in' : t.side < 0 ? 'below' : t.side > 0 ? 'above' : 'unknown');
  const queues = new Map();
  for (const [g, list] of pools) {
    const byKey = new Map();
    for (const t of list) {
      const tier = t.refill ? 1 : 0;
      const side = sideOf(t);
      const key = `${tier}|${side}`;
      if (!byKey.has(key)) byKey.set(key, { tier, side, list: [], ptr: 0 });
      byKey.get(key).list.push(t);
    }
    for (const q of byKey.values()) q.list.sort((a, b) => ringOf(a) - ringOf(b));
    queues.set(g, [...byKey.values()]);
  }
  const head = (q) => {
    while (q.ptr < q.list.length && used.has(q.list[q.ptr].id)) q.ptr++;
    return q.ptr < q.list.length ? q.list[q.ptr] : null;
  };
  const remaining = (g) => (queues.get(g) || []).reduce((sum, q) => (head(q), sum + q.list.length - q.ptr), 0);
  // Preference of a queue's next track: fresh before refill; inside the range,
  // then the side the curve leans to (`pref`: 1 = above, -1 = below), then the
  // other side, then no known side; then the nearer ring.
  const rank = (side, pref) => (side === 'in' ? 0 : side === (pref > 0 ? 'above' : 'below') ? 1 : side === 'unknown' ? 3 : 2);
  const keyOf = (q, pref) => [q.tier, rank(q.side, pref), ringOf(head(q))];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const bestQueue = (g, pref) => {
    let best = null;
    for (const q of queues.get(g) || []) {
      if (!head(q)) continue;
      const key = keyOf(q, pref);
      if (!best || cmp(key, best.key) < 0) best = { q, key };
    }
    return best;
  };
  // How many tracks follow the queue's next one at the same ring (= the whole
  // pool when nothing has a ring).
  const atHead = (q) => {
    const r = ringOf(head(q));
    let j = q.ptr;
    while (j < q.list.length && ringOf(q.list[j]) === r) j++;
    return j - q.ptr;
  };
  const mapFor = (k) => (Array.isArray(genresByLevel) ? genresByLevel[k] || genresByLevel[0] : genresByLevel);
  const levelGenres = (L, k) => (mapFor(k).get(L) || []).filter((g) => remaining(g) > 0);
  const availableFor = (k) => (L) => levelGenres(L, k).length > 0;

  const state = Array.from({ length: mixes }, () => ({ cursor: startMin, tracks: [], done: false }));
  const stats = { short: false, nullDurations: 0, levelFallbacks: 0, widened: 0, repeats: 0 };

  for (;;) {
    let k = -1;
    for (let i = 0; i < mixes; i++) if (!state[i].done && (k < 0 || state[i].cursor < state[k].cursor)) k = i;
    if (k < 0) break;
    const s = state[k];
    if (s.cursor >= endMin || s.tracks.length >= maxTracks) { s.done = true; continue; }

    // Sample ~half a minute into the next track: the level the listener
    // actually hears at that point of the day.
    const e = energyAt(s.cursor + 2);
    const L = effectiveLevel(e, n, availableFor(k));
    if (L == null) { s.done = true; stats.short = true; continue; }

    if (L !== levelOf(e, n)) stats.levelFallbacks++;

    // When the range has to widen, take the side the curve leans to: the
    // upper half of level L's row → slightly more energetic songs, the lower
    // half → slightly calmer ones (a fallback level above the curve → calmer,
    // below it → more energetic).
    const pref = e * n >= L - 0.5 ? 1 : -1;
    // effectiveLevel only returns a level with tracks left, so every genre
    // here has a queue. Only the genres whose best next track ties for the
    // most preferred take part in the draw.
    const best = new Map(levelGenres(L, k).map((g) => [g, bestQueue(g, pref)]));
    let top = null;
    for (const b of best.values()) if (!top || cmp(b.key, top) < 0) top = b.key;
    const cands = [...best].filter(([, b]) => cmp(b.key, top) === 0).map(([g]) => g);
    const genre = pickGenre(cands, (g) => atHead(best.get(g).q), rng);
    const q = best.get(genre).q;
    const t = head(q);
    q.ptr++;
    used.add(t.id);
    if (t.refill) stats.repeats++;
    else if (ringOf(t) > 0) stats.widened++;
    let sec = Number(t.sec);
    if (!Number.isFinite(sec) || sec <= 0) { sec = defaultSec; stats.nullDurations++; }
    // floor, not round: a track starting at 1049.997 must not be recorded
    // at 1050 (= the window's end).
    s.tracks.push({
      id: t.id, genre, level: L, startMin: Math.floor(s.cursor * 100) / 100, sec,
      energy: t.energy == null ? null : Number(t.energy),
    });
    s.cursor += sec / 60;
  }

  const out = state.map((s) => ({ tracks: s.tracks, endMin: s.cursor }));
  if (out.some((m) => m.endMin < endMin)) stats.short = true;
  return { mixes: out, stats };
}
