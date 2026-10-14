/* /api/v7/account/_taste-state.js
   Read and write what the v7 taste chat ("הטעם המוזיקלי שלכם") may change, as
   one state object (v7/generation/taste-ops.js): the taste profile, the
   current delivery mode's recipe library, Option 1's energy windows and the
   owner's own songs. Shared by taste-chat.js (context) and taste-apply.js
   (apply / undo).

   Writes:
     - business_taste_profiles: genres, weights, prefs (PATCH);
     - business_v7_settings.energy_windows (Option 1 only, when they changed);
     - the current mode's library, replace-all when it changed (Option 1:
       business_v7_directions; Option 2: business_v7_level_directions, each row
       stamped with the new levelProfileKey so the dashboard keeps it);
     - business_allowed_tracks: added songs upserted, dropped ones get
       removed_at.
   The other mode's library is left alone: it's rebuilt from the profile when
   the owner switches (Option 1 always regenerates; Option 2 when its
   profile_key no longer matches).

   Needs migration 2026-10-13-v7-taste-chat.sql (new columns + tables).
   Option 1's per-tier "well-known songs" (popularity_tiers) needs
   2026-10-14-v7-popularity.sql; without it, every other change still saves.
   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect, pgrPatch, pgrDelete, pgrInsert, pgrUpsert } from '../../v5/supabase-client.js';
import { stateFromRows, stateToRows } from '../../../v7/generation/taste-ops.js';
import { readLevelDirections } from './_option2-builder.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const POPULARITY_TIERS_HINT = 'run migration 2026-10-14-v7-popularity.sql';

// The profile PATCH. Before migration 2026-10-14-v7-popularity.sql there's
// no popularity_tiers column: save without it, unless the change needs it.
async function patchProfile(businessId, profile) {
  try {
    await pgrPatch('business_taste_profiles', { business_id: `eq.${businessId}` }, profile);
  } catch (e) {
    if (!/popularity_tiers/.test(e.message || '')) throw e;
    if (profile.popularity_tiers) throw new Error(`business_taste_profiles.popularity_tiers is missing — ${POPULARITY_TIERS_HINT}`);
    console.warn(`[v7 taste-state] business_taste_profiles.popularity_tiers missing — ${POPULARITY_TIERS_HINT}. Saving without it.`);
    const { popularity_tiers, ...rest } = profile;
    await pgrPatch('business_taste_profiles', { business_id: `eq.${businessId}` }, rest);
  }
}

// → { state, profile, settings } | null (no taste profile / no delivery mode)
export async function readTasteState(businessId) {
  const [profiles, settings, option1Rows, levelRows, allowedRows] = await Promise.all([
    pgrSelect('business_taste_profiles', { business_id: `eq.${businessId}` }, { select: '*', limit: 1, useService: true }),
    pgrSelect('business_v7_settings', { business_id: `eq.${businessId}` }, { select: '*', limit: 1, useService: true }),
    pgrSelect('business_v7_directions', { business_id: `eq.${businessId}`, active: 'is.true' },
      { select: '*', order: 'energy_tier.asc,rank.asc.nullslast', useService: true }).catch(() => []),
    readLevelDirections(businessId),
    pgrSelect('business_allowed_tracks', { business_id: `eq.${businessId}`, removed_at: 'is.null' },
      { select: '*', order: 'added_at.asc', useService: true }).catch(() => []),
  ]);
  const profile = profiles?.[0] || null;
  const st = settings?.[0] || null;
  if (!profile || !st?.delivery_mode) return null;
  const state = stateFromRows({
    mode: st.delivery_mode, profile, settings: st,
    option1Rows: option1Rows || [], levelRows: levelRows || [], allowedRows: allowedRows || [],
  });
  return { state, profile, settings: st };
}

// Write `next`, comparing with `prev` to touch only what changed.
export async function writeTasteState(businessId, prev, next) {
  const rows = stateToRows(next, businessId);
  const before = stateToRows(prev, businessId);

  await patchProfile(businessId, rows.profile);

  if (next.mode === 'option1') {
    if (!same(rows.settings, before.settings)) {
      await pgrPatch('business_v7_settings', { business_id: `eq.${businessId}` }, rows.settings);
    }
    if (!same(rows.option1Rows, before.option1Rows)) {
      await pgrDelete('business_v7_directions', { business_id: `eq.${businessId}` });
      if (rows.option1Rows.length) await pgrInsert('business_v7_directions', rows.option1Rows);
    }
  } else if (!same(rows.levelRows, before.levelRows)) {
    await pgrDelete('business_v7_level_directions', { business_id: `eq.${businessId}` });
    if (rows.levelRows.length) await pgrInsert('business_v7_level_directions', rows.levelRows);
  }

  const nextIds = new Set(rows.allowed.map((a) => a.spotify_id));
  const changedAllowed = rows.allowed.filter((a) => !same(a, before.allowed.find((b) => b.spotify_id === a.spotify_id)));
  if (changedAllowed.length) {
    await pgrUpsert('business_allowed_tracks',
      changedAllowed.map((a) => ({ ...a, removed_at: null, added_at: new Date().toISOString() })),
      { onConflict: 'business_id,spotify_id' });
  }
  const gone = before.allowed.filter((b) => !nextIds.has(b.spotify_id)).map((b) => b.spotify_id);
  if (gone.length) {
    await pgrPatch('business_allowed_tracks',
      { business_id: `eq.${businessId}`, spotify_id: `in.(${gone.map((x) => `"${x}"`).join(',')})` },
      { removed_at: new Date().toISOString() });
  }
}
