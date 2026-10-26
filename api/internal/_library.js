/* The admin console's view of a business's taste profile + direction
   libraries. Shared by business.js, directions.js and daily-picks.js.
   Not an HTTP endpoint. Bare imports only.

   Direction keys are the taste chat's (v7/generation/taste-ops.js
   stateFromRows): Option 1 "H1", "H2"… (high) and "C1"… (calm), in rank
   order within the tier; Option 2 "L2-1" = level 2, first in rank order.
   The library's rows are rewritten on every change (new ids), and deleting a
   direction renumbers the ones after it — always act on the latest list. */

import { pgrSelect } from '../v5/supabase-client.js';
import { selectOrEmpty } from './_admin.js';
import { tierOfLevel } from '../../v7/generation/option1-draw.js';
import { normLevels } from '../../v7/generation/energy-timeline.js';
import { levelEnergyWindow, OPTION1_ENERGY_WINDOWS } from '../../v7/generation/energy-windows.js';
import { levelProfileKey } from '../../v7/generation/timeline-assembler.js';

const TIER_KEY = { high: 'H', low: 'C' };

// Option 1 rows → [{ key, id, energy_tier, rank, title_en, genres, created_at }]
export function option1View(rows) {
  const n = { high: 0, low: 0 };
  return [...(rows || [])]
    .filter((r) => r && (r.energy_tier === 'high' || r.energy_tier === 'low'))
    .sort((a, b) => (a.energy_tier === b.energy_tier ? (a.rank ?? 1e9) - (b.rank ?? 1e9) : a.energy_tier === 'high' ? -1 : 1))
    .map((r) => ({
      key: `${TIER_KEY[r.energy_tier]}${++n[r.energy_tier]}`,
      id: r.id, energy_tier: r.energy_tier, rank: r.rank, title_en: r.title_en || '',
      genres: Array.isArray(r.genres) ? r.genres : [], created_at: r.created_at || null,
    }));
}

// Option 2 rows → [{ key, id, energy_level, rank, title_en, genres, energy_range, custom_range, created_at }]
export function option2View(rows, N) {
  const n = new Map();
  return [...(rows || [])]
    .filter((r) => r && Number.isInteger(Number(r.energy_level)))
    .sort((a, b) => (a.energy_level - b.energy_level) || ((a.rank ?? 1e9) - (b.rank ?? 1e9)))
    .map((r) => {
      const L = Math.min(N, Math.max(1, Number(r.energy_level)));
      n.set(L, (n.get(L) || 0) + 1);
      const def = levelEnergyWindow(L, N);
      const custom = Array.isArray(r.energy_range) && r.energy_range.length === 2 ? r.energy_range : null;
      return {
        key: `L${L}-${n.get(L)}`,
        id: r.id, energy_level: L, rank: r.rank, title_en: r.title_en || '',
        genres: Array.isArray(r.genres) ? r.genres : [],
        energy_range: custom || [def.min, def.max], custom_range: !!custom,
        profile_key: r.profile_key || null, created_at: r.created_at || null,
      };
    });
}

// The approved genres grouped by energy level, with the Option 1 tier each
// level falls in, the taste chat's weight (1 = normal) and whether it's a
// requested genre (the owner super-liked it or asked for it: it sits in the
// recipes it suits, and one of each day's playlists plays one of them).
export function approvedByLevel(profile) {
  const N = normLevels(profile?.energy_levels_total);
  const weights = profile?.genre_weights && typeof profile.genre_weights === 'object' ? profile.genre_weights : {};
  const requested = new Set((Array.isArray(profile?.requested_genres) ? profile.requested_genres : []).map((g) => String(g).toLowerCase()));
  const levels = Array.from({ length: N }, (_, i) => ({ level: i + 1, tier: tierOfLevel(i + 1, N), genres: [] }));
  for (const a of Array.isArray(profile?.approved_genres) ? profile.approved_genres : []) {
    const g = typeof a === 'string' ? a : a?.genre;
    if (!g) continue;
    const L = Math.min(N, Math.max(1, Math.round(Number(a?.energy_level) || 1)));
    levels[L - 1].genres.push({ genre: g, weight: Number(weights[g]) || 1, requested: requested.has(g.toLowerCase()) });
  }
  return levels;
}

// Everything the console shows about a business's taste + directions.
// → { profile, settings, mode, N, approved_by_level, option1, option2,
//     option2_matches_profile, energy_windows }
export async function readLibrary(businessId) {
  const [profiles, settings, option1Rows, levelRows] = await Promise.all([
    selectOrEmpty('business_taste_profiles', { business_id: `eq.${businessId}` }, { select: '*', limit: 1 }),
    selectOrEmpty('business_v7_settings', { business_id: `eq.${businessId}` }, { select: '*', limit: 1 }),
    pgrSelect('business_v7_directions', { business_id: `eq.${businessId}`, active: 'is.true' },
      { select: '*', order: 'energy_tier.asc,rank.asc.nullslast', useService: true }).catch(() => []),
    selectOrEmpty('business_v7_level_directions', { business_id: `eq.${businessId}`, active: 'is.true' },
      { select: '*', order: 'energy_level.asc,rank.asc.nullslast' }),
  ]);
  const profile = profiles[0] || null;
  const st = settings[0] || null;
  const N = normLevels(profile?.energy_levels_total);
  const option2 = option2View(levelRows, N);
  const key = profile ? levelProfileKey(profile) : null;
  const ew = st?.energy_windows || null;
  return {
    profile,
    settings: st,
    mode: st?.delivery_mode || null,
    N: profile ? N : null,
    approved_by_level: profile ? approvedByLevel(profile) : [],
    option1: option1View(option1Rows),
    option2,
    // Option 2's library is reused when the owner switches back to Option 2
    // only while it was built from the current profile; Option 1's is always
    // rebuilt at a switch.
    option2_matches_profile: option2.length ? option2.every((d) => d.profile_key === key) : null,
    energy_windows: {
      high: ew?.high || [OPTION1_ENERGY_WINDOWS.high.min, OPTION1_ENERGY_WINDOWS.high.max],
      low: ew?.low || [OPTION1_ENERGY_WINDOWS.low.min, OPTION1_ENERGY_WINDOWS.low.max],
      custom: !!ew,
    },
  };
}
