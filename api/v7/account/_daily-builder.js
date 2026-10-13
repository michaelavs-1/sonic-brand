/* /api/v7/account/_daily-builder.js
   v7 daily-playlist planning + batch builders. Thin wrappers over the v6
   daily-builder primitives — v7 does NOT reimplement Spotify create/add, the
   expiry ledger, cross-day track history, or the business_playlists INSERT. It
   only decides WHICH directions/genres to build and at WHAT length, then hands
   v6-shaped direction objects to the v6 builders.

   Not an HTTP endpoint — the leading underscore signals "private helper".

   Consumed by:
     - api/cron/v7-generate-daily.js       (scheduled; buildOption1Batch / buildOption2Batch)
     - api/v7/account/generate-daily.js    (owner-triggered, streaming; planOption1 / planOption2
                                            + v6 buildOneDailyPlaylist per playlist)

   Exports:
     planOption1({ businessId, hours, now, onDemand })
       Option 1 — energy-tiered directions. Reads the business's active
       business_v7_directions rows (persisted at mode selection), splits by
       energy_tier, and fills the 4 fixed names ("אנרגיה גבוהה #1/#2",
       "אנרגיה רגועה #1/#2") with 2 directions per tier — the first random,
       the second the least like it, re-drawn every build/day (pickTierPair).
       The tier's requested genres go into both. Half-day target each. Songs
       from the tier's energy range (high 50–80, low 20–50).
       → { directions, target, expiryIso, labelDate, reason }  (directions [] +
         reason when there's nothing to build; labelDate = the business day
         for the dated dashboard names)

     planOption2({ businessId, hours, now, onDemand })
       Option 2 — NAIVE full-length FALLBACK. The real Option-2 builder (energy
       timeline, duration-based) is ./_option2-builder.js; it falls back to this
       only when the v7_timeline_pool RPC isn't deployed yet. Flat approved
       genre pool → 2 full-opening-day playlists, energy ignored.
       → { directions, target, expiryIso, reason }

     buildOption1Batch / buildOption2Batch({ ownerId, businessId, bizName, hours, origin, now })
       plan + buildBatch (v7 copy of v6's buildDailyBatch: serial, 3s stagger,
       single INSERT at the end — plus per-track genres). → { built, failures }.
       Used by the cron.

     attachTrackGenres(row) / insertPlaylistRows(rows)
       The playlist record: fill business_playlists.track_genres for a built
       row, and INSERT rows (falls back to no track_genres if the column is
       missing). Shared by buildBatch and the on-demand endpoint.

   `onDemand` (owner-triggered builds only): the owner may build on a day the
   hours mark closed ("המקום פתוח?") or after closing. Such days are sized as
   CLOSED_DAY_MINUTES (same as v6's closed-day flow), and the expiry never lands
   in the past (falls back to next 04:00 IL). With onDemand=false the window is
   computed exactly as before — the cron only builds on open, not-yet-closed
   days anyway.

   CRITICAL FK: business_playlists.direction_id is an FK → v6 business_directions.
   v7 directions live in business_v7_directions (a DIFFERENT table). Every
   direction object handed to the v6 builders therefore carries id:null so the
   built rows insert direction_id:null (passing a v7 direction id would violate
   the FK).

   v7 emits no tempo axis, so every direction carries a wide-open
   bpm_range:{min:0,max:300} (v6_direction_tracks_recent requires one);
   popularity/instrumentalness prefs (from the taste profile) and Option 1's
   energy range per tier (energy_range, 2026-10-13) do the narrowing.
   Bare imports only — this module is server-reachable.
*/

import { pgrSelect, pgrRpc, pgrInsert } from '../../v5/supabase-client.js';
import { buildOneDailyPlaylist } from '../../v6/account/_daily-builder.js';
import {
  AVG_TRACK_MINUTES,
  CLOSED_DAY_MINUTES,
  MIN_TARGET_TRACKS,
  computeTargetTracks,
  dayMinutesFromHours,
  dailyPlaylistExpiryIso,
  ilPartsFromDate,
  nextIl4amIso,
  datedLabel,
} from '../../../v7/generation/playlist-length.js';
import { businessWindowAt } from '../../../v7/generation/energy-timeline.js';
import { pickTierPair, requestedByTier, withRequested, tierOfLevel } from '../../../v7/generation/option1-draw.js';
import { option1EnergyWindow } from '../../../v7/generation/energy-windows.js';
import { applyOption1Picks } from '../../../v7/generation/daily-picks.js';
import { readDailyPicks } from './_daily-picks.js';

const PREF_SET = new Set(['none', 'soft', 'hard']);
const normPref = (v) => (PREF_SET.has(v) ? v : 'none');

// business_taste_profiles.genre_weights ({"Rnb": 0.5}) → the RPC's form
// ({"rnb": 0.5}; playlist_genres stores genres lowercase). Only weights other
// than 1; null when there are none.
export function lowercaseWeights(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [g, w] of Object.entries(raw)) {
    const n = Number(w);
    if (typeof g === 'string' && g.trim() && Number.isFinite(n) && n > 0 && n !== 1) out[g.trim().toLowerCase()] = n;
  }
  return Object.keys(out).length ? out : null;
}

// Option 1's energy windows (business_v7_settings.energy_windows, set by the
// taste chat; null / missing column → the defaults).
async function readEnergyWindows(businessId) {
  try {
    const rows = await pgrSelect('business_v7_settings', { business_id: `eq.${businessId}` },
      { select: '*', limit: 1, useService: true });
    return rows?.[0]?.energy_windows || null;
  } catch (e) {
    console.warn(`[v7 daily-builder] energy windows read failed for biz=${businessId}:`, e.message);
    return null;
  }
}

// Read the taste profile once: carry-through inst/pop prefs (used by both
// options), the approved genre pool (used by Option 2), and the requested
// genres + energy scale (Option 1 puts each requested genre in every playlist
// of its tier). Missing profile or a read error degrades to unfiltered
// defaults rather than throwing — the cron already gated on the profile's
// presence, so this is belt-and-suspenders. If requested_genres isn't there
// yet (migration 2026-10-05-v7-requested-genres.sql not run), it's read
// without it.
// '*' rather than a column list: requested_genres (2026-10-05) and
// genre_weights (2026-10-13, the taste chat) are read when their columns
// exist, and the read still works before those migrations.
async function readProfilePrefs(businessId) {
  const none = { inst_pref: 'none', pop_pref: 'none', approvedGenres: [], requestedGenres: [], energyLevelsTotal: null, genreWeights: null };
  try {
    const rows = await pgrSelect('business_taste_profiles',
      { business_id: `eq.${businessId}` }, { select: '*', useService: true, limit: 1 });
    const tp = rows?.[0];
    if (!tp) return none;
    return {
      inst_pref: normPref(tp.instrumentalness_preference),
      pop_pref:  normPref(tp.popularity_preference),
      approvedGenres: Array.isArray(tp.approved_genres) ? tp.approved_genres : [],
      requestedGenres: Array.isArray(tp.requested_genres) ? tp.requested_genres : [],
      energyLevelsTotal: Number(tp.energy_levels_total) || null,
      genreWeights: lowercaseWeights(tp.genre_weights),
    };
  } catch (e) {
    console.warn(`[v7 daily-builder] taste profile read failed for biz=${businessId}:`, e.message);
    return none;
  }
}

// Today's opening minutes + playlist expiry. See `onDemand` in the header.
function todayWindow({ hours, now, onDemand }) {
  const dayMins = dayMinutesFromHours(hours, ilPartsFromDate(now).dayIdx);
  if (!onDemand) return { dayMins, expiryIso: dailyPlaylistExpiryIso({ hours, now }) };
  const open = Number.isFinite(dayMins) && dayMins > 0;
  let expiryIso = open ? dailyPlaylistExpiryIso({ hours, now }) : null;
  if (!expiryIso || Date.parse(expiryIso) <= now.getTime()) expiryIso = nextIl4amIso({ now });
  return { dayMins: open ? dayMins : CLOSED_DAY_MINUTES, expiryIso };
}

// Owner-facing Option-1 names: fixed by energy tier + position within the tier
// ("אנרגיה גבוהה #1", "אנרגיה רגועה #2"). Gemini's descriptive title_en stays
// in business_v7_directions as an internal descriptor only — never shown.
const TIER_NAME_HE = { high: 'אנרגיה גבוהה', low: 'אנרגיה רגועה' };
const tierPlaylistName = (tier, n) => `${TIER_NAME_HE[tier] || 'פלייליסט'} #${n}`;

// Shape a business_v7_directions row into the v6-style direction object
// buildOneDailyPlaylist/fetchTracksWithHistory expect. id:null (FK), wide-open
// bpm_range, prefs from the taste profile, the tier's energy range. `name` is
// the owner-facing label; it rides in the v6 builder's `title_en` slot, which
// becomes the dashboard row label (business_playlists.label) and the Spotify
// playlist title/description.
// v7_source (2026-10-13) = which library direction the slot played, kept in the
// row's expansion.direction so the admin console can show what each day offered
// (admin_pick: the admin console picked it for the day).
function shapeV7Direction(d, name, inst_pref, pop_pref, energy_range, genre_weights = null) {
  return {
    id: null,
    title_en: name,
    description_he: name,
    genres: Array.isArray(d.genres) ? d.genres : [],
    bpm_range: { min: 0, max: 300 },
    instrumentalness_preference: inst_pref,
    popularity_preference: pop_pref,
    energy_range,
    genre_weights,
    v7_source: { direction_id: d.id || null, title_en: d.title_en || null, admin_pick: !!d.admin_pick },
  };
}

const EMPTY = (reason) => ({ directions: [], target: 0, expiryIso: null, labelDate: null, reason });

// ---------- the playlist record (v6 parity + v7 per-track genres) ----------
//
// Like v6, every built playlist gets a permanent business_playlists row (never
// deleted; expires_at only gates dashboard visibility) holding the ordered
// track_ids — after expiry the Spotify playlist is emptied, so this row is the
// record of what the owner was served. v7 adds track_genres next to it:
//   { "<spotify_id>": ["Bossa Nova"], ... }
// = which of the playlist's own genres each track belongs to in the catalog
// (canonical names; two entries when a track is tagged with two of them; []
// if the catalog no longer ties it to any). Looked up via the v7_track_genres
// RPC (migration 2026-09-24-v7-track-genres.sql). Best-effort: a failed lookup
// leaves track_genres unset rather than failing the build.
export async function attachTrackGenres(row) {
  const ids    = Array.isArray(row?.track_ids) ? row.track_ids : [];
  const genres = Array.isArray(row?.genres) ? row.genres : [];
  if (!ids.length || !genres.length) return row;
  try {
    const canonical = new Map(genres.map((g) => [String(g).toLowerCase(), g]));
    const pairs = await pgrRpc('v7_track_genres',
      { p_spotify_ids: ids, p_genres: genres }, { useService: true });
    const map = Object.fromEntries(ids.map((id) => [id, []]));
    for (const p of pairs || []) {
      const g = canonical.get(String(p.genre).toLowerCase());
      if (g && map[p.spotify_id] && !map[p.spotify_id].includes(g)) map[p.spotify_id].push(g);
    }
    // The owner's own songs (taste chat, business_allowed_tracks) aren't in
    // the catalog's genre playlists — they carry the genre they were added under.
    const missing = ids.filter((id) => !map[id].length);
    if (missing.length && row.business_id) {
      try {
        const own = await pgrSelect('business_allowed_tracks',
          { business_id: `eq.${row.business_id}`, spotify_id: `in.(${missing.map((x) => `"${x}"`).join(',')})` },
          { select: 'spotify_id,genre', useService: true });
        for (const o of own || []) {
          const g = canonical.get(String(o.genre).toLowerCase());
          if (g && map[o.spotify_id] && !map[o.spotify_id].includes(g)) map[o.spotify_id].push(g);
        }
      } catch { /* table missing before migration 2026-10-13-v7-taste-chat.sql */ }
    }
    row.track_genres = map;
  } catch (e) {
    console.warn(`[v7 daily-builder] track-genre lookup failed for playlist ${row.spotify_id}:`, e.message);
  }
  return row;
}

// INSERT business_playlists rows. If the track_genres column isn't there yet
// (migration not run), retry without it so the playlist record itself is never
// lost — and say so loudly.
export async function insertPlaylistRows(rows) {
  try {
    await pgrInsert('business_playlists', rows, { ignoreDuplicates: true });
  } catch (e) {
    if (!/track_genres/.test(e.message || '')) throw e;
    console.error('[v7 daily-builder] business_playlists.track_genres missing — run migration 2026-09-24-v7-track-genres.sql. Inserting without per-track genres.');
    await pgrInsert('business_playlists',
      rows.map(({ track_genres, ...rest }) => rest), { ignoreDuplicates: true });
  }
}

// v7 copy of v6's buildDailyBatch (api/v6/account/_daily-builder.js) — same
// serial build, same 3s stagger between playlists (Spotify pacing, 2026-08-22),
// same per-playlist error isolation and single INSERT at the end — plus the
// per-track genre record. v6's function is left untouched.
const BUILD_STAGGER_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// labelDate: the business day (YYYY-MM-DD) appended to each row's dashboard
// name (datedLabel) — the Spotify name already carries a date.
async function buildBatch({ ownerId, businessId, bizName, directions, target, expiryIso, labelDate, origin }) {
  const built = [];
  const failures = [];
  for (let i = 0; i < directions.length; i++) {
    if (i > 0) await sleep(BUILD_STAGGER_MS);
    const direction = directions[i];
    try {
      const r = await buildOneDailyPlaylist({ origin, ownerId, businessId, direction, target, bizName, expiryIso });
      if (r.skipped) failures.push({ title: r.title, reason: r.reason });
      else {
        r.row.label = datedLabel(r.row.label, labelDate);
        built.push(await attachTrackGenres(r.row));
      }
    } catch (err) {
      console.warn(`[v7 daily-builder] "${direction.title_en}" failed:`, err.message);
      failures.push({ title: direction.title_en, reason: err.message });
    }
  }
  if (built.length) await insertPlaylistRows(built);
  return { built, failures };
}

// -------- Option 1: 2 high + 2 low energy directions (4 playlists/day) --------

// fromNow (the Profile tab's "replace today's playlists now"): size each
// playlist to half of the REMAINING opening time + 1.5h instead of half the
// whole day — the owner presses play on the new set right away.
export async function planOption1({ businessId, hours, now = new Date(), onDemand = false, fromNow = false }) {
  // 1. Active v7 directions (the library). Order doesn't matter — the draw
  //    below is random.
  let dirRows = [];
  try {
    dirRows = await pgrSelect('business_v7_directions',
      { business_id: `eq.${businessId}`, active: 'is.true' },
      { select: 'id,energy_tier,rank,title_en,genres',
        order: 'rank.asc.nullslast', useService: true },
    );
  } catch (e) {
    console.warn(`[v7 daily-builder] business_v7_directions read failed for biz=${businessId}:`, e.message);
    return EMPTY('directions-read-failed');
  }
  if (!dirRows?.length) return EMPTY('no-directions');

  const highTier = dirRows.filter((d) => d.energy_tier === 'high');
  const lowTier  = dirRows.filter((d) => d.energy_tier === 'low');

  // 2. Carry-through prefs + requested genres + genre weights from the taste
  //    profile, and the tiers' energy windows.
  const [{ inst_pref, pop_pref, approvedGenres, requestedGenres, energyLevelsTotal, genreWeights }, storedWindows] =
    await Promise.all([readProfilePrefs(businessId), readEnergyWindows(businessId)]);
  const requested = energyLevelsTotal
    ? requestedByTier(requestedGenres, approvedGenres, energyLevelsTotal)
    : { high: [], low: [] };

  // 3. Fill the 4 fixed names — "אנרגיה גבוהה #1/#2", "אנרגיה רגועה #1/#2" —
  //    with 2 directions per tier: the first at random, the second the one
  //    least like it (pickTierPair, v7/generation/option1-draw.js). No mixing
  //    between tiers. Every requested genre of the tier goes into both
  //    playlists (withRequested — the library already has them; this covers
  //    libraries built before the rule). The TRACKS inside each direction also
  //    rotate day to day (fetchTracksWithHistory's random draw + 7-day dedup).
  //    Each tier's songs come from its energy range (high 50–80, low 20–50,
  //    v7/generation/energy-windows.js — or the owner's own, moved by the
  //    taste chat), widened by 5 on each side only when the range is short of
  //    songs. Genre weights (the taste chat) scale how often a genre's songs
  //    are drawn.
  //    The admin console can pick a slot's direction for the day instead
  //    (business_v7_daily_picks, v7/generation/daily-picks.js); a picked
  //    slot's partner is then the direction least like the pick.
  const labelDate = businessWindowAt(hours, now).isoDate;
  const picks = energyLevelsTotal ? await readDailyPicks(businessId, labelDate, 'option1') : [];
  const tierAllowed = (tier) => new Map(approvedGenres
    .filter((a) => a?.genre && tierOfLevel(a.energy_level, energyLevelsTotal) === tier)
    .map((a) => [String(a.genre).toLowerCase(), a.genre]));
  const high = applyOption1Picks('high', pickTierPair(highTier), highTier, picks, tierAllowed('high'));
  const low  = applyOption1Picks('low',  pickTierPair(lowTier),  lowTier,  picks, tierAllowed('low'));
  if (!high.length && !low.length) return EMPTY('no-directions');

  const shape = (tier) => (d, i) => shapeV7Direction(
    { ...d, genres: withRequested(d.genres, requested[tier]) },
    tierPlaylistName(tier, i + 1), inst_pref, pop_pref, option1EnergyWindow(tier, storedWindows), genreWeights);
  const directions = [...high.map(shape('high')), ...low.map(shape('low'))];

  // 4. Per-playlist length (Roni's spec, 2026-09-24): HALF the day's opening
  //    time + 1.5 hours IN TOTAL — no additional buffer on top (so NOT
  //    computeTargetTracks, which adds its own 60 min). Converted to a track
  //    count at AVG_TRACK_MINUTES, floored at MIN_TARGET_TRACKS.
  const { dayMins, expiryIso } = todayWindow({ hours, now, onDemand });
  let spanMins = Number.isFinite(dayMins) && dayMins > 0 ? dayMins : 0;
  if (fromNow) {
    const w = businessWindowAt(hours, now);
    if (w.phase === 'open') spanMins = Math.max(0, w.closeMin - w.nowMin);
  }
  const target = Math.max(MIN_TARGET_TRACKS, Math.ceil((spanMins / 2 + 90) / AVG_TRACK_MINUTES));

  return { directions, target, expiryIso, labelDate, reason: null };
}

export async function buildOption1Batch({ ownerId, businessId, bizName, hours, origin, now = new Date() }) {
  const { directions, target, expiryIso, labelDate } = await planOption1({ businessId, hours, now });
  if (!directions.length) return { built: [], failures: [] };
  return buildBatch({ ownerId, businessId, bizName, directions, target, expiryIso, labelDate, origin });
}

// -------- Option 2: 2 full-length energy-shifting playlists (NAIVE) --------

export async function planOption2({ businessId, hours, now = new Date(), onDemand = false }) {
  const { inst_pref, pop_pref, approvedGenres } = await readProfilePrefs(businessId);

  // approved_genres is [{genre, energy_level}] — flatten to a canonical name pool.
  const genrePool = approvedGenres
    .map((g) => (typeof g === 'string' ? g : g?.genre))
    .filter(Boolean);
  if (!genrePool.length) {
    console.warn(`[v7 daily-builder] option2: no approved genres for biz=${businessId} — nothing to build`);
    return EMPTY('no-approved-genres');
  }

  // NAIVE v1: two full-opening-day playlists, both drawn from ONE flat
  // approved-genre pool. Energy ordering (by the profile's per-genre
  // energy_level) and the duration-clock / interactive timeline are DEFERRED
  // (see build-sheet OPEN QUESTIONS). Built serially with each served track
  // recorded to v6_daily_track_history before the next starts, so the second
  // playlist automatically avoids the first's tracks — the two mixes differ
  // from each other and day-to-day via the RPC's random() ordering + 7-day dedup.
  const { dayMins, expiryIso } = todayWindow({ hours, now, onDemand });
  const target = computeTargetTracks(dayMins);

  // Owner-facing names "Daily Mix #1" / "Daily Mix #2" (same numbering idea
  // as Option 1's fixed energy names) — dashboard label + Spotify title.
  const mix = (n) => ({
    id: null,
    title_en: `Daily Mix #${n}`,
    description_he: '',
    genres: genrePool,
    bpm_range: { min: 0, max: 300 },
    instrumentalness_preference: inst_pref,
    popularity_preference: pop_pref,
  });

  return { directions: [mix(1), mix(2)], target, expiryIso, labelDate: businessWindowAt(hours, now).isoDate, reason: null };
}

export async function buildOption2Batch({ ownerId, businessId, bizName, hours, origin, now = new Date() }) {
  const { directions, target, expiryIso, labelDate } = await planOption2({ businessId, hours, now });
  if (!directions.length) return { built: [], failures: [] };
  return buildBatch({ ownerId, businessId, bizName, directions, target, expiryIso, labelDate, origin });
}
