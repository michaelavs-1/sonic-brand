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
//     business_taste_profiles.requested_genres) is heard at least once a day:
//     the pair must include a direction that plays it (Roni, 2026-10-26).
//     Until then a requested genre was forced into EVERY direction of its
//     tier, which bolted it onto recipes it didn't belong in; now it sits
//     only in the recipes it suits, and the DRAW is what guarantees the owner
//     hears it. When the tier's requested genres need more than two recipes,
//     the day covers as many as it can and the rest come first on the days
//     after (the priority order rotates with the business day).
//
// Pure, no imports — server-reachable and browser-loadable.

// Option 1's tier split: the upper half of the owner's own energy scale is
// "high", the rest "low" (same rule as v7/generation/energy-directions.js).
export const tierOfLevel = (level, n) => (Number(level) > n / 2 ? 'high' : 'low');

// "Well-known songs" for one tier (Ami, 2026-10-14): the taste chat can set it
// per tier (business_taste_profiles.popularity_tiers, {high, low}); a tier
// without its own value follows the whole account's popularity_preference.
// → 'none' | 'soft' | 'hard'
const POP_PREFS = new Set(['none', 'soft', 'hard']);
export function tierPopularity(accountPref, tiers, tier) {
  const own = tiers && typeof tiers === 'object' ? tiers[tier] : null;
  if (POP_PREFS.has(own)) return own;
  return POP_PREFS.has(accountPref) ? accountPref : 'none';
}

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

// How alike two directions are, 0..1: shared genres / all genres, counting
// only genres that are NOT in every direction of the pool (a genre all of
// them play says nothing about how two of them differ).
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
//
// `requested` (the tier's requested genres) narrows the draw to the pairs that
// play the most of them, so the owner hears every genre they asked for at
// least once a day through a recipe that holds it — rather than by having it
// stapled onto all of them. `day` (the business day as a day number) rotates
// which ones win when no pair can carry them all. Among the pairs that tie on
// coverage the rules above are unchanged.
export function pickTierPair(pool, rng = Math.random, { requested = [], day = 0 } = {}) {
  if (!Array.isArray(pool) || !pool.length) return [];
  if (pool.length === 1) return [pool[0], pool[0]];

  // Only genres some direction of the tier actually plays can be covered.
  const plays = (d, g) => (d.genres || []).some((x) => String(x).toLowerCase() === g);
  const want = [...new Set((Array.isArray(requested) ? requested : []).map((g) => String(g).toLowerCase()))]
    .filter((g) => pool.some((d) => plays(d, g)));

  if (!want.length) {
    const first = pool[Math.floor(rng() * pool.length)];
    return [first, leastAlike(pool, first, rng)];
  }

  // Today's priority order: a genre left out today comes first tomorrow. A
  // pair is scored by how many requested genres it plays, then by how early in
  // that order they are (a bitmask, the most urgent genre the highest bit).
  const n = want.length;
  const start = ((day % n) + n) % n;
  const order = want.map((_, i) => want[(start + i) % n]);
  const score = (a, b) => {
    let count = 0;
    let mask = 0;
    for (let i = 0; i < n; i++) {
      if (!plays(a, order[i]) && !plays(b, order[i])) continue;
      count++;
      mask += 2 ** (n - 1 - i);
    }
    return { count, mask };
  };

  let best = { count: -1, mask: -1 };
  let bestPairs = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const s = score(pool[i], pool[j]);
      if (s.count > best.count || (s.count === best.count && s.mask > best.mask)) {
        best = s;
        bestPairs = [];
      }
      if (s.count === best.count && s.mask === best.mask) bestPairs.push([pool[i], pool[j]]);
    }
  }

  // The usual flavour inside the winning pairs: the first direction at random
  // among those that appear in one, the second the least like it.
  const firsts = [...new Set(bestPairs.flat())];
  const first = firsts[Math.floor(rng() * firsts.length)];
  const partners = bestPairs
    .filter((p) => p.includes(first))
    .map((p) => (p[0] === first ? p[1] : p[0]));
  return [first, leastAlike(pool, first, rng, partners)];
}

// The direction of `pool` least like `first` (ties at random), never `first`
// itself — or, with a genre set equal to it, never one with the same genres
// (`first` may be a copy from outside the pool: an admin's daily pick,
// v7/generation/daily-picks.js). A pool with nothing else → `first`.
// `among` (optional) limits the answer to those directions — pickTierPair
// passes the partners that keep the day's requested-genre coverage — while
// how alike they are is still measured against the whole pool.
export function leastAlike(pool, first, rng = Math.random, among = null) {
  if (!Array.isArray(pool) || !pool.length) return first;
  const lower = (d) => (d.genres || []).map((g) => String(g).toLowerCase());
  const common = new Set(lower(pool[0]).filter((g) => pool.every((d) => lower(d).includes(g))));
  const firstKey = lower(first).sort().join('|');
  let best = Infinity;
  let candidates = [];
  for (const d of (Array.isArray(among) ? among : pool)) {
    if (d === first || lower(d).sort().join('|') === firstKey) continue;
    const s = similarity(first, d, common);
    if (s < best - 1e-9) { best = s; candidates = [d]; }
    else if (Math.abs(s - best) <= 1e-9) candidates.push(d);
  }
  return candidates.length ? candidates[Math.floor(rng() * candidates.length)] : first;
}
