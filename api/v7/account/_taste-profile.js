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
   inputs     = { superLikedGenres?, round2Emphases?, onboardingProbes? } —
                onboarding inputs, kept with the profile (2026-10-05; the swipe
                cards since 2026-10-13, for the admin console). Columns are
                only written when given, so a later profile update doesn't
                clear them.
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

// Columns added by later migrations — the row is saved without any that
// don't exist yet: 2026-10-05-v7-requested-genres.sql (the first three) and
// 2026-10-13-admin-console.sql (onboarding_probes).
const OPTIONAL_COLUMNS = ['requested_genres', 'super_liked_genres', 'round2_emphases', 'onboarding_probes'];

// The swipe cards from the onboarding page (v7/app.js onboardingProbes):
// [{ round, rank, title_en, description_he, genres, verdict }], trimmed.
const VERDICTS = new Set(['liked', 'disliked', 'not-swiped']);
function probeList(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 16).filter((p) => p && typeof p === 'object').map((p) => ({
    round: Number(p.round) === 2 ? 2 : 1,
    rank: Number.isFinite(Number(p.rank)) ? Number(p.rank) : null,
    title_en: String(p.title_en || '').slice(0, 160),
    description_he: String(p.description_he || '').slice(0, 600),
    genres: genreList(p.genres),
    verdict: VERDICTS.has(p.verdict) ? p.verdict : 'not-swiped',
  }));
}

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
  const probes = probeList(inputs.onboardingProbes);
  if (probes) row.onboarding_probes = probes;
  return row;
}

// Upsert a tasteProfileRow. If one of the optional columns isn't there yet
// (its migration not run), save the row without it — the profile itself is
// what every build needs — and say so loudly. Retries once per missing column.
export async function upsertTasteProfileRow(row) {
  let rest = { ...row };
  for (;;) {
    try {
      await pgrUpsert('business_taste_profiles', rest, { onConflict: 'business_id' });
      return;
    } catch (e) {
      const missing = OPTIONAL_COLUMNS.filter((c) => c in rest && (e.message || '').includes(c));
      if (!missing.length) throw e;
      console.error(`[v7 taste-profile] column(s) ${missing.join(', ')} missing — run the newer v7 migrations (2026-10-05-v7-requested-genres.sql, 2026-10-13-admin-console.sql). Saving the profile without them.`);
      rest = { ...rest };
      for (const c of missing) delete rest[c];
    }
  }
}
