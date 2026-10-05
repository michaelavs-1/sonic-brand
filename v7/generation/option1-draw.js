// Option 1's daily draw (4 playlists/day = 2 high-energy + 2 calm), shared by
// the builder (api/v7/account/_daily-builder.js planOption1) and Ami's prompt
// dashboard (v5/ami-prompt-dashboard/playlist-directions.js), so the
// dashboard's example day is drawn exactly the way production draws it.
//
// Rules (Ami, 2026-10-05):
//   - The two playlists of a tier are as different from each other as
//     possible: the first direction is random, the second is the one with the
//     fewest genres in common with it (pickTierPair).
//   - Every requested genre (super-liked, or asked for in the emphases —
//     business_taste_profiles.requested_genres) is in EVERY playlist of its
//     tier (withRequested). The directions generator already builds them into
//     every direction; the builder adds any that are missing, so the rule
//     holds for libraries built before it existed too.
//
// Pure, no imports — server-reachable and browser-loadable.

// Option 1's tier split: the upper half of the owner's own energy scale is
// "high", the rest "low" (same rule as v7/generation/energy-directions.js).
export const tierOfLevel = (level, n) => (Number(level) > n / 2 ? 'high' : 'low');

// requestedGenres: [string]; approvedGenres: [{genre, energy_level}].
// → { high: [genre], low: [genre] } — each requested genre in the tier of its
// approved energy level. A requested genre that isn't approved is skipped
// (the taste profile always approves them, so it means the data is stale).
export function requestedByTier(requestedGenres, approvedGenres, n) {
  const levelOf = new Map();
  for (const a of Array.isArray(approvedGenres) ? approvedGenres : []) {
    const g = typeof a === 'string' ? a : a?.genre;
    if (g) levelOf.set(String(g).toLowerCase(), { genre: g, level: Number(a?.energy_level) });
  }
  const out = { high: [], low: [] };
  const seen = new Set();
  for (const r of Array.isArray(requestedGenres) ? requestedGenres : []) {
    const hit = levelOf.get(String(r || '').toLowerCase());
    if (!hit || seen.has(hit.genre) || !Number.isFinite(hit.level)) continue;
    seen.add(hit.genre);
    out[tierOfLevel(hit.level, n)].push(hit.genre);
  }
  return out;
}

// A direction's genres plus any of `requested` it doesn't have yet.
export function withRequested(genres, requested) {
  const list = Array.isArray(genres) ? [...genres] : [];
  const have = new Set(list.map((g) => String(g).toLowerCase()));
  for (const r of Array.isArray(requested) ? requested : []) {
    if (!have.has(String(r).toLowerCase())) { list.push(r); have.add(String(r).toLowerCase()); }
  }
  return list;
}

// How alike two directions are, 0..1: shared genres / all genres, counting
// only genres that are NOT in every direction of the pool (requested genres
// sit in all of them, so they say nothing about how two directions differ).
function similarity(a, b, common) {
  const ga = new Set((a.genres || []).map((g) => String(g).toLowerCase()).filter((g) => !common.has(g)));
  const gb = new Set((b.genres || []).map((g) => String(g).toLowerCase()).filter((g) => !common.has(g)));
  const union = new Set([...ga, ...gb]);
  if (!union.size) return 1;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / union.size;
}

// Today's two directions for a tier's "#1" / "#2". The first is drawn at
// random; the second is the one least like it (ties broken at random), so the
// two playlists differ as much as the library allows while the days still
// vary. A pool of 1 fills both with the same direction: builds run serially
// and each playlist records its tracks before the next starts, so the second
// draws different tracks.
export function pickTierPair(pool, rng = Math.random) {
  if (!Array.isArray(pool) || !pool.length) return [];
  if (pool.length === 1) return [pool[0], pool[0]];
  const lower = (d) => (d.genres || []).map((g) => String(g).toLowerCase());
  const common = new Set(lower(pool[0]).filter((g) => pool.every((d) => lower(d).includes(g))));
  const first = pool[Math.floor(rng() * pool.length)];
  let best = Infinity;
  let candidates = [];
  for (const d of pool) {
    if (d === first) continue;
    const s = similarity(first, d, common);
    if (s < best - 1e-9) { best = s; candidates = [d]; }
    else if (Math.abs(s - best) <= 1e-9) candidates.push(d);
  }
  return [first, candidates[Math.floor(rng() * candidates.length)]];
}
