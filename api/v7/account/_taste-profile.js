/* /api/v7/account/_taste-profile.js
   Shared shaping of a generateTasteProfile() result into a
   business_taste_profiles row. Private helper (leading underscore — not an
   HTTP endpoint).

   Used by:
     - signup.js              (onboarding: the profile is saved by signup itself,
                               BEFORE the verification email goes out, so the
                               owner's first click on the magic link lands on an
                               account whose taste profile already exists)
     - save-taste-profile.js  (owner-authenticated update; not used by
                               onboarding since 2026-09-24)

   profile    = { energy_levels_total, approved_genres, conditional_genres,
                  excluded_genres, requested_genres, instrumentalness_preference,
                  popularity_preference, reasoning_en }
   genreTally = [{ genre, like, dislike }]   (analytics only)
   inputs     = { superLikedGenres?, round2Emphases? } — onboarding inputs,
                kept with the profile (2026-10-05). Columns are only written
                when given, so a later profile update doesn't clear them.
*/

import { pgrUpsert } from '../../v5/supabase-client.js';
import { GENRES } from '../../../shared/genre-universe.js';

const PREF_SET = new Set(['none', 'soft', 'hard']);
const normPref = (v) => (PREF_SET.has(v) ? v : 'none');
const arrOrNull = (v) => (Array.isArray(v) ? v : null);

// Canonical, deduped genre names (unknown names dropped) — a crafted request
// can't store junk the builders would then try to match.
const CANONICAL_BY_LOWER = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
function genreList(v) {
  const out = [];
  for (const g of Array.isArray(v) ? v : []) {
    const c = typeof g === 'string' ? CANONICAL_BY_LOWER.get(g.trim().toLowerCase()) : null;
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// Columns added by migration 2026-10-05-v7-requested-genres.sql.
const REQUESTED_COLUMNS = ['requested_genres', 'super_liked_genres', 'round2_emphases'];

// True when `profile` looks like a usable taste profile — at minimum an
// approved-genre list (the daily builders read nothing else to build).
export function isUsableTasteProfile(profile) {
  return !!profile && typeof profile === 'object' && Array.isArray(profile.approved_genres);
}

export function tasteProfileRow(businessId, profile, genreTally, inputs = {}) {
  // Clamp energy_levels_total into the documented 2..6 range; anything out of
  // range (or missing) becomes null rather than failing the write.
  let energyTotal = Number(profile.energy_levels_total);
  energyTotal = Number.isFinite(energyTotal)
    ? Math.min(6, Math.max(2, Math.round(energyTotal)))
    : null;

  const row = {
    business_id:                 businessId,
    energy_levels_total:         energyTotal,
    approved_genres:             arrOrNull(profile.approved_genres),
    conditional_genres:          arrOrNull(profile.conditional_genres),
    excluded_genres:             arrOrNull(profile.excluded_genres),
    instrumentalness_preference: normPref(profile.instrumentalness_preference),
    popularity_preference:       normPref(profile.popularity_preference),
    reasoning_en:                typeof profile.reasoning_en === 'string' ? profile.reasoning_en : null,
    audit_tally:                 arrOrNull(genreTally),
    updated_at:                  new Date().toISOString(),
  };
  if (Array.isArray(profile.requested_genres)) row.requested_genres = genreList(profile.requested_genres);
  if (Array.isArray(inputs.superLikedGenres)) row.super_liked_genres = genreList(inputs.superLikedGenres);
  if (typeof inputs.round2Emphases === 'string') {
    row.round2_emphases = inputs.round2Emphases.trim().slice(0, 2000) || null;
  }
  return row;
}

// Upsert a tasteProfileRow. If the 2026-10-05 columns aren't there yet
// (migration not run), save the row without them — the profile itself is
// what every build needs — and say so loudly.
export async function upsertTasteProfileRow(row) {
  try {
    await pgrUpsert('business_taste_profiles', row, { onConflict: 'business_id' });
  } catch (e) {
    if (!REQUESTED_COLUMNS.some((c) => (e.message || '').includes(c))) throw e;
    console.error('[v7 taste-profile] requested-genre columns missing — run migration 2026-10-05-v7-requested-genres.sql. Saving the profile without them.');
    const rest = { ...row };
    for (const c of REQUESTED_COLUMNS) delete rest[c];
    await pgrUpsert('business_taste_profiles', rest, { onConflict: 'business_id' });
  }
}
