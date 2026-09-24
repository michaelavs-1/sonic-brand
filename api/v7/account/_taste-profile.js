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
                  excluded_genres, instrumentalness_preference,
                  popularity_preference, reasoning_en }
   genreTally = [{ genre, like, dislike }]   (analytics only)
*/

const PREF_SET = new Set(['none', 'soft', 'hard']);
const normPref = (v) => (PREF_SET.has(v) ? v : 'none');
const arrOrNull = (v) => (Array.isArray(v) ? v : null);

// True when `profile` looks like a usable taste profile — at minimum an
// approved-genre list (the daily builders read nothing else to build).
export function isUsableTasteProfile(profile) {
  return !!profile && typeof profile === 'object' && Array.isArray(profile.approved_genres);
}

export function tasteProfileRow(businessId, profile, genreTally) {
  // Clamp energy_levels_total into the documented 2..6 range; anything out of
  // range (or missing) becomes null rather than failing the write.
  let energyTotal = Number(profile.energy_levels_total);
  energyTotal = Number.isFinite(energyTotal)
    ? Math.min(6, Math.max(2, Math.round(energyTotal)))
    : null;

  return {
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
}
