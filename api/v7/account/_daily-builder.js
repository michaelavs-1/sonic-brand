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
       "אנרגיה רגועה #1/#2") with a random pick of 2 directions per tier —
       re-drawn every build/day (pickTwo). Half-day target each.
       → { directions, target, expiryIso, reason }  (directions [] + reason when
         there's nothing to build)

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
   popularity/instrumentalness prefs (from the taste profile) do the narrowing.
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
} from '../../../v7/generation/playlist-length.js';
import { businessWindowAt } from '../../../v7/generation/energy-timeline.js';

const PREF_SET = new Set(['none', 'soft', 'hard']);
const normPref = (v) => (PREF_SET.has(v) ? v : 'none');

// Read the taste profile once: carry-through inst/pop prefs (used by both
// options) + the approved genre pool (used by Option 2). Missing profile or a
// read error degrades to unfiltered defaults rather than throwing — the cron
// already gated on the profile's presence, so this is belt-and-suspenders.
async function readProfilePrefs(businessId) {
  try {
    const rows = await pgrSelect('business_taste_profiles',
      { business_id: `eq.${businessId}` },
      { select: 'approved_genres,instrumentalness_preference,popularity_preference',
        useService: true, limit: 1 },
    );
    const tp = rows?.[0];
    if (!tp) return { inst_pref: 'none', pop_pref: 'none', approvedGenres: [] };
    return {
      inst_pref: normPref(tp.instrumentalness_preference),
      pop_pref:  normPref(tp.popularity_preference),
      approvedGenres: Array.isArray(tp.approved_genres) ? tp.approved_genres : [],
    };
  } catch (e) {
    console.warn(`[v7 daily-builder] taste profile read failed for biz=${businessId}:`, e.message);
    return { inst_pref: 'none', pop_pref: 'none', approvedGenres: [] };
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
// bpm_range, prefs from the taste profile. `name` is the owner-facing label;
// it rides in the v6 builder's `title_en` slot, which becomes the dashboard
// row label (business_playlists.label) and the Spotify playlist title/description.
function shapeV7Direction(d, name, inst_pref, pop_pref) {
  return {
    id: null,
    title_en: name,
    description_he: name,
    genres: Array.isArray(d.genres) ? d.genres : [],
    bpm_range: { min: 0, max: 300 },
    instrumentalness_preference: inst_pref,
    popularity_preference: pop_pref,
  };
}

const EMPTY = (reason) => ({ directions: [], target: 0, expiryIso: null, reason });

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
async function buildBatch({ ownerId, businessId, bizName, directions, target, expiryIso, origin }) {
  const built = [];
  const failures = [];
  for (let i = 0; i < directions.length; i++) {
    if (i > 0) await sleep(BUILD_STAGGER_MS);
    const direction = directions[i];
    try {
      const r = await buildOneDailyPlaylist({ origin, ownerId, businessId, direction, target, bizName, expiryIso });
      if (r.skipped) failures.push({ title: r.title, reason: r.reason });
      else built.push(await attachTrackGenres(r.row));
    } catch (err) {
      console.warn(`[v7 daily-builder] "${direction.title_en}" failed:`, err.message);
      failures.push({ title: direction.title_en, reason: err.message });
    }
  }
  if (built.length) await insertPlaylistRows(built);
  return { built, failures };
}

// Today's two directions for a tier's "#1" / "#2" names, drawn at RANDOM from
// that tier's active pool (the energy-directions step makes ≥ 2 per tier, often
// more). Each build — i.e. each day — re-draws, so every name gets a random
// direction of the right energy. A pool of 1 fills both names with the same
// direction: builds run serially and each playlist records its tracks to
// v6_daily_track_history before the next starts, so the second draws
// different tracks. The owner always sees two playlists per tier.
function pickTwo(pool) {
  if (!pool.length) return [];
  if (pool.length === 1) return [pool[0], pool[0]];
  const a = Math.floor(Math.random() * pool.length);
  let b = Math.floor(Math.random() * (pool.length - 1));
  if (b >= a) b += 1;
  return [pool[a], pool[b]];
}

// -------- Option 1: 2 high + 2 low energy directions (4 playlists/day) --------

// fromNow (the Profile tab's "replace today's playlists now"): size each
// playlist to half of the REMAINING opening time + 1.5h instead of half the
// whole day — the owner presses play on the new set right away.
export async function planOption1({ businessId, hours, now = new Date(), onDemand = false, fromNow = false }) {
  // 1. Active v7 directions, ordered by rank so the "first 2" selection below
  //    is deterministic.
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

  // 2. Carry-through prefs from the taste profile.
  const { inst_pref, pop_pref } = await readProfilePrefs(businessId);

  // 3. Fill the 4 fixed names — "אנרגיה גבוהה #1/#2", "אנרגיה רגועה #1/#2" —
  //    with a random pick of 2 directions per tier (pickTwo). No mixing between
  //    tiers. The TRACKS inside each direction also rotate day to day
  //    (fetchTracksWithHistory's random draw + 7-day cross-day dedup).
  const high = pickTwo(highTier);
  const low  = pickTwo(lowTier);
  if (!high.length && !low.length) return EMPTY('no-directions');

  const directions = [
    ...high.map((d, i) => shapeV7Direction(d, tierPlaylistName('high', i + 1), inst_pref, pop_pref)),
    ...low.map((d, i)  => shapeV7Direction(d, tierPlaylistName('low',  i + 1), inst_pref, pop_pref)),
  ];

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

  return { directions, target, expiryIso, reason: null };
}

export async function buildOption1Batch({ ownerId, businessId, bizName, hours, origin, now = new Date() }) {
  const { directions, target, expiryIso } = await planOption1({ businessId, hours, now });
  if (!directions.length) return { built: [], failures: [] };
  return buildBatch({ ownerId, businessId, bizName, directions, target, expiryIso, origin });
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

  return { directions: [mix(1), mix(2)], target, expiryIso, reason: null };
}

export async function buildOption2Batch({ ownerId, businessId, bizName, hours, origin, now = new Date() }) {
  const { directions, target, expiryIso } = await planOption2({ businessId, hours, now });
  if (!directions.length) return { built: [], failures: [] };
  return buildBatch({ ownerId, businessId, bizName, directions, target, expiryIso, origin });
}
