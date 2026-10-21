/* /api/v7/account/energy-nudge.js — "today only" energy for one Option 1
   playlist (Ami + Roni, 2026-10-21).

   Under each of the 4 daily playlists the owner sees three circles (calmer /
   as usual / more energetic). Tapping one swaps the songs of THAT playlist to
   the circle's energy window, for today only:
     - the windows: nudgeOptions in v7/generation/energy-windows.js — usual
       ±10, or, when the usual window is at an end of the scale, the usual
       one there and one / two steps the other way. The usual window is the
       playlist's own (the default, or the owner's as moved by the taste chat);
     - the SAME Spotify playlist is changed in place: the songs whose energy
       fits the new window stay (in their order), the rest are replaced by new
       songs of the same recipe drawn in the new window (put in at random
       places), and the playlist keeps its length. The no-repeat rule keeps
       out the songs it already played, so the new ones are new;
     - tomorrow's build is back to the usual windows. Nothing is saved to the
       taste profile (that's the chat's job).

   One change a day per business, across all 4 playlists: counted as
   business_settings_changes rows field 'daily_energy_nudge' since the start
   of the business day. Only while today's playlists are live and the venue
   hasn't closed (before opening or open), Option 1 only, one build at a time
   per business (_build-lock.js).

   POST { businessId, spotifyId, choice }   choice = the circle, 0..2, calmest first
   → { ok, playlist: { spotify_id, track_count, track_ids, expansion }, kept, added, removed }
   409 codes: not-option1 | past-close | nudge-used | not-adjustable | same | build-in-progress | no-tracks
   Owner-facing errors are Hebrew (`error`). */

import { pgrSelect, pgrPatch } from '../../v5/supabase-client.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import {
  fetchTracksWithHistory, recordTrackHistory, spotifyCall, addAllTracks,
} from '../../v6/account/_daily-builder.js';
import { verifyUser, readHours, readSettings, auditSetting } from './_settings-helpers.js';
import { ownedBusiness, selfOrigin } from './_special-events.js';
import { subscriptionEnded, SUBSCRIPTION_ENDED_MESSAGE } from './_subscription.js';
import { acquireBuildLock } from './_build-lock.js';
import { businessDaySinceIso } from './_replace-status.js';
import { readProfilePrefs, attachTrackGenres } from './_daily-builder.js';
import { businessWindowAt } from '../../../v7/generation/energy-timeline.js';
import { nudgeOptions, mergeAtRandom } from '../../../v7/generation/energy-windows.js';
import { tierPopularity } from '../../../v7/generation/option1-draw.js';
import { OPTION1_SLOT_NAMES } from '../../../v7/generation/daily-picks.js';
import { undatedLabel } from '../../../v7/generation/playlist-length.js';

export const NUDGE_FIELD = 'daily_energy_nudge';
const NUDGES_PER_DAY = 1;
const OPTION1_NAMES = new Set(Object.values(OPTION1_SLOT_NAMES));

const pair = (w) => {
  const lo = Number(Array.isArray(w) ? w[0] : w?.min);
  const hi = Number(Array.isArray(w) ? w[1] : w?.max);
  return Number.isFinite(lo) && Number.isFinite(hi) && lo < hi ? [Math.round(lo), Math.round(hi)] : null;
};
const sameWindow = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

const fail = (res, status, code, error) => res.status(status).json({ ok: false, code, error });

// Today's energy change, if the business made one (nudges since the start of
// the business day).
export async function nudgesUsedToday(businessId, w) {
  const rows = await pgrSelect('business_settings_changes',
    { business_id: `eq.${businessId}`, field: `eq.${NUDGE_FIELD}`, changed_at: `gte.${w.dayStartIso}` },
    { select: 'id', limit: 10, useService: true });
  return (rows || []).length;
}

// spotify_id → energy (null when analysed without one); ids with no
// track_analyses row are left out (the owner's own songs not analysed yet).
async function trackEnergies(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = await pgrSelect('track_analyses',
      { spotify_id: `in.(${chunk.map((x) => `"${x}"`).join(',')})` },
      { select: 'spotify_id,energy', useService: true });
    for (const r of rows || []) out.set(r.spotify_id, r.energy == null ? null : Number(r.energy));
  }
  return out;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-energy-nudge', 10, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const { businessId, spotifyId, choice } = req.body || {};
    try { await ownedBusiness(businessId, user.id); } catch (e) { return res.status(e.status || 403).json({ error: e.message }); }
    if (await subscriptionEnded(businessId)) return fail(res, 403, 'subscription_ended', SUBSCRIPTION_ENDED_MESSAGE);

    const settings = await readSettings(businessId).catch(() => null);
    if (settings?.delivery_mode !== 'option1') return fail(res, 409, 'not-option1', 'אפשר לשנות אנרגיה כך רק בפלייליסטים של 4 ביום.');
    const hours = await readHours(businessId).catch(() => null);
    const now = new Date();
    const w = businessWindowAt(hours, now);
    if (w.phase !== 'before-open' && w.phase !== 'open') return fail(res, 409, 'past-close', 'המקום כבר נסגר להיום — הפלייליסטים של מחר ייבנו כרגיל.');
    if (await nudgesUsedToday(businessId, w) >= NUDGES_PER_DAY) {
      return fail(res, 409, 'nudge-used', 'כבר שיניתם היום את האנרגיה של אחד הפלייליסטים. אפשר לשנות שוב מחר.');
    }

    // Today's live playlist, one of the 4 fixed names, built with an energy window.
    const rows = await pgrSelect('business_playlists',
      { business_id: `eq.${businessId}`, spotify_id: `eq.${String(spotifyId || '')}` },
      { select: '*', limit: 1, useService: true });
    const row = rows?.[0];
    const dir = row?.expansion?.direction;
    const current = pair(dir?.energy_range);
    const live = row && !row.event_id && (!row.expires_at || Date.parse(row.expires_at) > now.getTime())
      && Date.parse(row.created_at) >= Date.parse(businessDaySinceIso(w));
    if (!live || !current || !OPTION1_NAMES.has(undatedLabel(row.label)) || !Array.isArray(row.track_ids)) {
      return fail(res, 409, 'not-adjustable', 'אי אפשר לשנות את הפלייליסט הזה.');
    }
    const usual = pair(dir.energy_nudge?.usual) || current;
    const { windows } = nudgeOptions(usual);
    const idx = Number(choice);
    const target = Number.isInteger(idx) && idx >= 0 && idx <= 2 ? windows[idx] : null;
    if (!target) return res.status(400).json({ error: 'choice must be 0, 1 or 2' });
    if (sameWindow(target, current)) return fail(res, 409, 'same', 'זה כבר מצב הפלייליסט.');

    const lock = await acquireBuildLock(businessId, 120);
    if (!lock.acquired) return fail(res, 409, 'build-in-progress', 'הפלייליסטים מתעדכנים עכשיו — נסו שוב בעוד דקה.');
    try {
      // The same recipe, with today's preferences and weights from the profile.
      const name = undatedLabel(row.label);
      const tier = name.startsWith(OPTION1_SLOT_NAMES['high-1'].replace(/ #\d$/, '')) ? 'high' : 'low';
      const prefs = await readProfilePrefs(businessId);
      const pop = tierPopularity(prefs.pop_pref, prefs.popTiers, tier);
      const direction = {
        id: null,
        title_en: name,
        description_he: name,
        genres: Array.isArray(dir.genres) ? dir.genres : (row.genres || []),
        bpm_range: { min: 0, max: 300 },
        instrumentalness_preference: prefs.inst_pref,
        popularity_preference: pop,
        ...(pop === 'hard' ? { popularity_fallback: 'soft' } : {}),
        energy_range: { min: target[0], max: target[1] },
        genre_weights: prefs.genreWeights,
      };

      // Keep what fits the new window (and the owner's own songs not analysed
      // yet, which count as inside any window); replace the rest.
      const ids = row.track_ids.filter(Boolean);
      const inPlaylist = new Set(ids);
      const energy = await trackEnergies(ids);
      const kept = ids.filter((id) => !energy.has(id) || (energy.get(id) != null && energy.get(id) >= target[0] && energy.get(id) <= target[1]));
      const need = Math.max(0, ids.length - kept.length);
      let fresh = [];
      let directionKey = null;
      if (need) {
        const got = await fetchTracksWithHistory({ businessId, direction, target: need + ids.length });
        directionKey = got.directionKey;
        fresh = got.ids.filter((id) => !inPlaylist.has(id)).slice(0, need);
      }
      const next = mergeAtRandom(kept, fresh);
      if (!next.length) return fail(res, 409, 'no-tracks', 'לא מצאנו שירים מתאימים — נסו כיוון אחר.');

      // Spotify: replace the items (100 per call), then add the rest.
      const origin = selfOrigin(req);
      await spotifyCall(origin, 'replace_tracks', {
        playlist_id: row.spotify_id, uris: next.slice(0, 100).map((id) => `spotify:track:${id}`),
      });
      if (next.length > 100) await addAllTracks(origin, row.spotify_id, next.slice(100));
      if (fresh.length) await recordTrackHistory({ businessId, directionKey, spotifyIds: fresh });

      const expansion = {
        ...row.expansion,
        direction: {
          ...dir,
          energy_range: { min: target[0], max: target[1] },
          energy_nudge: {
            usual: { min: usual[0], max: usual[1] },
            at: now.toISOString(),
            kept: kept.length, added: fresh.length, removed: ids.length - kept.length,
          },
        },
      };
      const patch = { track_ids: next, track_count: next.length, expansion };
      const withGenres = await attachTrackGenres({ ...row, track_ids: next });
      if (withGenres.track_genres) patch.track_genres = withGenres.track_genres;
      await pgrPatch('business_playlists', { spotify_id: `eq.${row.spotify_id}` }, patch);
      await auditSetting(businessId, NUDGE_FIELD,
        { playlist: name, window: current },
        { playlist: name, window: target, kept: kept.length, added: fresh.length });

      return res.status(200).json({
        ok: true,
        playlist: { spotify_id: row.spotify_id, track_count: next.length, track_ids: next, expansion },
        kept: kept.length, added: fresh.length, removed: ids.length - kept.length,
      });
    } finally {
      await lock.release();
    }
  } catch (err) {
    console.error('[v7 energy-nudge] failed:', err.message);
    const paused = String(err.message || '').includes('spotify_paused');
    return res.status(paused ? 503 : 500).json({
      ok: false, code: paused ? 'spotify-paused' : 'error',
      error: paused ? 'ספוטיפיי לא זמין כרגע — נסו שוב מאוחר יותר.' : 'משהו השתבש — נסו שוב.',
    });
  }
}
