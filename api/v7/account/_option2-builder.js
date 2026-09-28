/* /api/v7/account/_option2-builder.js
   v7 Option 2 — two daily mixes ("Daily Mix #1/#2") whose energy follows the
   owner's timeline through the day. Replaces the naive planOption2 (flat genre
   pool, count-based) in ./_daily-builder.js, which stays as the fallback when
   the pool RPC isn't deployed yet.

   Not an HTTP endpoint (leading underscore = private helper).

   How a day is built:
     1. Window: businessWindowAt(hours, now) — overnight-aware. Start =
        max(now, opening) (a build after opening — first login mid-day, a late
        cron, "צור פלייליסטים", "replace now" — starts at the build time, so
        pressing play now matches the clock); end = closing + 30 min.
        On-demand on a closed day / after closing ("המקום פתוח?"): the main
        hours group's curve stretched over now → now + 12h, expiring next
        04:00 IL.
     2. Curve: the stored timeline reconciled to the current hours
        (v7/generation/energy-timeline.js), the group for today's weekday.
     3. Genres: business_taste_profiles.approved_genres grouped by
        energy_level (conditional genres ignored). The curve's grid row picks
        the level; a level with no genres falls back to the nearest one.
        Level directions (2026-09-28): when the business has a library in
        business_v7_level_directions, each mix plays ONE direction per level
        today — pickLevelDirections in timeline-assembler.js, a daily cycle
        from the business-day date; the two mixes differ when a level has 2+
        directions. A level with genres but no stored direction plays its
        genres as one implicit direction. No library (not generated yet,
        generation failed, table missing) → every genre of the level, as
        before.
     4. Pool: v7_timeline_pool RPC (migration 2026-09-24-v7-timeline-pool.sql)
        — random tracks per genre with durations, sized from the curve,
        excluding tracks served to this business in the last 7 days; wider
        sample for short genres; recently-served refill for levels still short.
     5. Assembly: v7/generation/timeline-assembler.js — tracks end to end by
        duration, each track's genre drawn at random from the mix's genres
        at that level (the day's direction; no genre runs since
        2026-09-28), two disjoint mixes. Seeded RNG; the seed and each mix's directions are
        stored on the row (expansion.v7_timeline).
     6. Each mix → Spotify create + add (v6 spotifyCall / addAllTracks: same
        retry + spotify_paused handling), history (direction_key
        'v7-option2'), expiry ledger, business_playlists row (+ track_genres).

   Bare imports only — server-reachable.
*/

import { randomUUID } from 'node:crypto';
import { pgrSelect, pgrRpc, pgrUpsert } from '../../v5/supabase-client.js';
import { spotifyCall, addAllTracks, recordTrackHistory, playlistName } from '../../v6/account/_daily-builder.js';
import { attachTrackGenres, insertPlaylistRows, buildOption2Batch as buildNaiveOption2Batch } from './_daily-builder.js';
import {
  reconcileTimeline, groupForDay, mainGroup, businessWindowAt, energyAtFn, windowOf, defaultPoints,
  normLevels, AFTER_CLOSE_MIN,
} from '../../../v7/generation/energy-timeline.js';
import {
  estimateDemand, estimateDemandPerMix, assembleMixes, pickLevelDirections, dayNumber,
  mulberry32, seedFrom, shuffle, DEFAULT_TRACK_SEC,
} from '../../../v7/generation/timeline-assembler.js';
import { CLOSED_DAY_MINUTES, nextIl4amIso, datedLabel } from '../../../v7/generation/playlist-length.js';

export const OPTION2_DIRECTION_KEY = 'v7-option2';
export const OPTION2_TITLES = ['Daily Mix #1', 'Daily Mix #2'];
const EXCLUDE_DAYS = 7;
const BUILD_STAGGER_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREF_SET = new Set(['none', 'soft', 'hard']);
const normPref = (v) => (PREF_SET.has(v) ? v : 'none');

// Missing RPC (migration not run yet) → PostgREST 404 PGRST202.
const isMissingRpc = (e) => e?.status === 404 || /PGRST202|Could not find the function/i.test(e?.detail || e?.message || '');

// The business's active level directions. A missing table (migration
// 2026-09-28-v7-level-directions.sql not run) or a read error → [] (the
// builder then plays every genre of the level, as before).
export async function readLevelDirections(businessId) {
  try {
    return await pgrSelect('business_v7_level_directions',
      { business_id: `eq.${businessId}`, active: 'is.true' },
      { select: 'id,energy_level,rank,title_en,genres', order: 'energy_level.asc,rank.asc.nullslast', useService: true }) || [];
  } catch (e) {
    console.warn(`[v7 option2] level directions read failed for biz=${businessId}:`, e.message);
    return [];
  }
}

async function readInputs(businessId) {
  const [settings, profiles, levelDirections] = await Promise.all([
    pgrSelect('business_v7_settings', { business_id: `eq.${businessId}` },
      { select: 'timeline', limit: 1, useService: true }),
    pgrSelect('business_taste_profiles', { business_id: `eq.${businessId}` },
      { select: 'approved_genres,energy_levels_total,instrumentalness_preference,popularity_preference', limit: 1, useService: true }),
    readLevelDirections(businessId),
  ]);
  const tp = profiles?.[0] || null;
  return {
    timeline: settings?.[0]?.timeline || null,
    approved: Array.isArray(tp?.approved_genres) ? tp.approved_genres : [],
    N: normLevels(tp?.energy_levels_total),
    inst: normPref(tp?.instrumentalness_preference),
    pop: normPref(tp?.popularity_preference),
    levelDirections,
  };
}

// Stored level-direction rows → Map<level, [{ id, title_en, genres }]> in
// rank order, keeping only genres that are approved AT that level (the
// profile is the source of truth). A level with approved genres but no
// usable direction gets its genre list as one implicit direction (id null).
// No usable rows at all → null (no library).
export function levelLibrary(rows, genresByLevel) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const sorted = [...rows].sort((a, b) =>
    (a.energy_level - b.energy_level) || ((a.rank ?? 1e9) - (b.rank ?? 1e9)));
  const lib = new Map();
  for (const r of sorted) {
    const L = Number(r.energy_level);
    const allowed = new Map((genresByLevel.get(L) || []).map((g) => [g.toLowerCase(), g]));
    const genres = [...new Set((Array.isArray(r.genres) ? r.genres : [])
      .map((g) => allowed.get(String(g).toLowerCase())).filter(Boolean))];
    if (!genres.length) continue;
    if (!lib.has(L)) lib.set(L, []);
    lib.get(L).push({ id: r.id || null, title_en: r.title_en || '', genres });
  }
  if (!lib.size) return null;
  for (const [L, genres] of genresByLevel) {
    if (!lib.has(L) && genres.length) lib.set(L, [{ id: null, title_en: `(all level ${L} genres)`, genres }]);
  }
  return lib;
}

const directionsMeta = (picks) => Object.fromEntries([...picks].sort((a, b) => a[0] - b[0])
  .map(([L, d]) => [L, { id: d.id, title_en: d.title_en, genres: d.genres }]));

// Which stretch of the day to fill, and the energy curve over it.
export function planWindow({ hours, timeline, now = new Date(), onDemand = false }) {
  const tl = reconcileTimeline(timeline, hours);
  const w = businessWindowAt(hours, now);
  // Any time before closing builds the rest of today (a build a minute before
  // closing still gets its 30-minute tail); after closing → closed-day logic.
  if (w.phase === 'before-open' || w.phase === 'open') {
    const startMin = Math.max(w.nowMin, w.openMin);
    const endMin = w.closeMin + AFTER_CLOSE_MIN;
    const group = groupForDay(tl, w.dayIdx) || { ...w.group, days: [w.dayIdx], points: defaultPoints(w.group) };
    return {
      kind: 'day', startMin, endMin, expiryIso: w.expiryIso, dayIdx: w.dayIdx, isoDate: w.isoDate,
      group, energyAt: energyAtFn(group.points),
    };
  }
  if (!onDemand) return { reason: w.phase === 'closed' ? 'closed-today' : 'past-close' };

  // "המקום פתוח?" on a closed day / after closing.
  const fallback = { days: [], open: '10:00', close: '22:00' };
  const g = mainGroup(tl) || { ...fallback, points: defaultPoints(fallback) };
  const gw = windowOf(g);
  const curve = energyAtFn(g.points);
  const startMin = w.nowMin;
  const endMin = startMin + CLOSED_DAY_MINUTES;
  return {
    kind: 'closed-day', startMin, endMin, expiryIso: nextIl4amIso({ now }), dayIdx: w.dayIdx, isoDate: w.isoDate,
    group: g, energyAt: (m) => curve(gw.openMin + ((m - startMin) / (endMin - startMin)) * gw.total),
  };
}

async function callPool({ businessId, specs, inst, pop, excludeDays }) {
  if (!specs.length) return [];
  return await pgrRpc('v7_timeline_pool', {
    p_biz_id: businessId,
    p_specs: specs.map(({ genre, n, playlists }) => ({ genre, n, playlists })),
    p_inst_pref: inst,
    p_pop_pref: pop,
    p_exclude_days: excludeDays,
  }, { useService: true }) || [];
}

// Plan today's two mixes for a business (reads its timeline + taste profile).
//   → { fallback:true }                        pool RPC missing → use the naive builder
//   → { slots:[], reason }                     nothing to build
//   → { slots:[{ key, title, tracks }], expiryIso, meta, stats, reason:null }
export async function planOption2Timeline({ businessId, hours, now = new Date(), onDemand = false }) {
  const inputs = await readInputs(businessId);
  return planFromInputs({ businessId, hours, now, onDemand, ...inputs });
}

// Same, from explicit inputs (scripts/_v7-option2-dryrun.mjs plans for fixture
// profiles with this). Read-only: the only DB access is the pool RPC.
// levelDirections = business_v7_level_directions rows ([] → no library).
export async function planFromInputs({ businessId, hours, timeline, approved, N, inst = 'none', pop = 'none', levelDirections = [], now = new Date(), onDemand = false }) {
  N = normLevels(N);
  const genresByLevel = new Map();
  const canonical = new Map();
  for (const a of approved) {
    const genre = typeof a === 'string' ? a : a?.genre;
    if (!genre) continue;
    const L = Math.min(N, Math.max(1, Math.round(Number(a?.energy_level) || 1)));
    if (!genresByLevel.has(L)) genresByLevel.set(L, []);
    if (!genresByLevel.get(L).includes(genre)) genresByLevel.get(L).push(genre);
    canonical.set(genre.toLowerCase(), genre);
  }
  if (!canonical.size) return { slots: [], reason: 'no-approved-genres' };

  const win = planWindow({ hours, timeline, now, onDemand });
  if (win.reason) return { slots: [], reason: win.reason };

  // Today's direction per level for each mix (null → no library: every mix
  // plays every genre of the level).
  const MIXES = OPTION2_TITLES.length;
  const lib = levelLibrary(levelDirections, genresByLevel);
  const picks = lib ? pickLevelDirections(lib, win.isoDate, MIXES) : null;
  const perMix = picks ? picks.map((m) => new Map([...m].map(([L, d]) => [L, d.genres]))) : null;
  if (!lib && levelDirections?.length) console.warn(`[v7 option2] biz=${businessId}: stored level directions don't match the taste profile — playing every genre of each level`);

  const hardPref = inst === 'hard' || pop === 'hard';
  const demandArgs = { startMin: win.startMin, endMin: win.endMin, energyAt: win.energyAt, N, hardPref };
  const { specs, minsByLevel, minsByLevelPerMix } = perMix
    ? estimateDemandPerMix({ ...demandArgs, genresByLevelPerMix: perMix })
    : estimateDemand({ ...demandArgs, genresByLevel, mixes: MIXES });

  // Tier 1 + tier 2 (wider playlist sample for genres that came back short).
  const t0 = Date.now();
  let fresh;
  try {
    fresh = await callPool({ businessId, specs, inst, pop, excludeDays: EXCLUDE_DAYS });
  } catch (e) {
    if (isMissingRpc(e)) {
      console.error('[v7 option2] v7_timeline_pool missing — run migration 2026-09-24-v7-timeline-pool.sql. Falling back to the naive Option-2 build.');
      return { fallback: true };
    }
    throw e;
  }
  const byGenre = new Map([...canonical.values()].map((g) => [g, new Map()]));
  const add = (rows, into) => {
    for (const r of rows) {
      const g = canonical.get(String(r.genre).toLowerCase());
      if (!g || into.get(g)?.has(r.spotify_id)) continue;
      into.get(g).set(r.spotify_id, { id: r.spotify_id, sec: r.duration_sec });
    }
  };
  add(fresh, byGenre);
  const short = specs.filter((s) => (byGenre.get(s.genre)?.size || 0) < s.n);
  if (short.length) {
    add(await callPool({ businessId, specs: short.map((s) => ({ ...s, playlists: 200 })), inst, pop, excludeDays: EXCLUDE_DAYS }), byGenre);
  }

  // Refill: a genre group whose fresh supply is under 1.1× what it has to
  // cover gets recently-served tracks too, queued AFTER the fresh ones.
  // Groups: each level's genres for both mixes (no library), or each mix's
  // direction at each level plus the two directions together (library —
  // they may share genres).
  const groups = [];
  const trackNeed = (mins, mixes = 1) => Math.ceil(((mins || 0) * 60 * mixes) / DEFAULT_TRACK_SEC);
  if (perMix) {
    for (const L of genresByLevel.keys()) {
      let needAll = 0;
      const union = new Set();
      perMix.forEach((m, k) => {
        const genres = m.get(L) || [];
        const need = trackNeed(minsByLevelPerMix[k].get(L));
        groups.push({ need, genres });
        needAll += need;
        genres.forEach((g) => union.add(g));
      });
      groups.push({ need: needAll, genres: [...union] });
    }
  } else {
    for (const [L, genres] of genresByLevel) groups.push({ need: trackNeed(minsByLevel.get(L), MIXES), genres });
  }
  const refillGenres = new Set();
  for (const grp of groups) {
    const supply = grp.genres.reduce((n, g) => n + (byGenre.get(g)?.size || 0), 0);
    if (grp.need && supply < grp.need * 1.1) grp.genres.forEach((g) => refillGenres.add(g));
  }
  const refill = new Map([...canonical.values()].map((g) => [g, new Map()]));
  const refillSpecs = specs.filter((s) => refillGenres.has(s.genre));
  if (refillSpecs.length) {
    add(await callPool({ businessId, specs: refillSpecs, inst, pop, excludeDays: 0 }), refill);
  }
  const poolMs = Date.now() - t0;

  const seed = randomUUID();
  const rng = mulberry32(seedFrom(seed));
  const pools = new Map();
  for (const g of canonical.values()) {
    const freshList = shuffle([...byGenre.get(g).values()], rng);
    const freshIds = new Set(freshList.map((t) => t.id));
    const refillList = shuffle([...refill.get(g).values()].filter((t) => !freshIds.has(t.id)), rng);
    pools.set(g, [...freshList, ...refillList]);
  }

  const { mixes, stats } = assembleMixes({
    startMin: win.startMin, endMin: win.endMin, energyAt: win.energyAt, N, genresByLevel: perMix || genresByLevel, pools, rng,
    mixes: MIXES,
  });

  const meta = {
    v: 2,
    kind: win.kind,
    day_idx: win.dayIdx,
    il_date: win.isoDate,
    open: win.group.open,
    close: win.group.close,
    points: win.group.points,
    levels_total: N,
    window: [Math.round(win.startMin), Math.round(win.endMin)],
    seed,
    // 'level-directions' = each mix played one direction per level (each
    // slot's meta.directions); 'level-genres' = no library, every genre of
    // the level.
    source: picks ? 'level-directions' : 'level-genres',
    day_number: dayNumber(win.isoDate),
  };
  const slotMeta = (i) => ({ ...meta, directions: picks ? directionsMeta(picks[i]) : null });
  const pickLog = picks
    ? ' picks=' + picks.map((m, i) => `#${i + 1}{${[...m].sort((a, b) => a[0] - b[0]).map(([L, d]) => `L${L}:${d.title_en}`).join(', ')}}`).join(' ')
    : ' picks=none(level-genres)';
  console.log(`[v7 option2] biz=${businessId} window=${meta.window.join('-')} kind=${win.kind} pool=${poolMs}ms tracks=${mixes.map((m) => m.tracks.length).join('+')} stats=${JSON.stringify(stats)}${pickLog}`);
  return {
    reason: null,
    slots: mixes.map((m, i) => ({ key: `slot-${i}`, title: OPTION2_TITLES[i], tracks: m.tracks, meta: slotMeta(i) })),
    expiryIso: win.expiryIso,
    meta,
    stats,
  };
}

// One mix → Spotify playlist + ledger + history + business_playlists-shaped row.
// → { skipped:true, reason, title } | { skipped:false, row }  (row NOT inserted)
export async function createTimelineMix({ origin, ownerId, businessId, bizName, title, tracks, expiryIso, meta }) {
  const ids = tracks.map((t) => t.id);
  if (!ids.length) return { skipped: true, reason: 'no tracks matched', title };

  const name = playlistName(bizName, { title_en: title });
  const created = await spotifyCall(origin, 'create_playlist', { name, description: title });
  if (!created?.id) throw new Error('create_playlist returned no id');
  await addAllTracks(origin, created.id, ids);
  await recordTrackHistory({ businessId, directionKey: OPTION2_DIRECTION_KEY, spotifyIds: ids });

  const expiresAtIso = expiryIso || nextIl4amIso();
  try {
    await pgrUpsert('created_playlists', {
      spotify_id: created.id, name, expires_at: expiresAtIso, deleted_at: null, error: null,
      owner_id: ownerId || null, business_id: businessId,
    }, { onConflict: 'spotify_id' });
  } catch (e) {
    console.warn(`[v7 option2] ledger upsert failed for ${created.id}:`, e.message);
  }

  const nowIso = new Date().toISOString();
  const genres = [...new Set(tracks.map((t) => t.genre))];
  const row = {
    spotify_id: created.id,
    business_id: businessId,
    url: created.external_urls?.spotify || '',
    label: datedLabel(title, meta?.il_date),   // "Daily Mix #1 · 28.09.2026"
    ico: '🎵',
    track_count: ids.length,
    genres,
    bpm_range: null,
    // `v7_timeline`, not `direction`: the dashboard's expansion logic keys on
    // expansion.direction, and these playlists are born at full length.
    expansion: {
      v7_timeline: {
        ...meta,
        starts: tracks.map((t) => t.startMin),
        levels: tracks.map((t) => t.level),
        run_genres: tracks.map((t) => t.genre),   // each track's genre (name kept from the genre-runs era)
      },
    },
    event_id: null,
    direction_id: null,              // FK → v6 business_directions; v7 has none
    track_ids: ids,
    expanded_at: nowIso,
    expires_at: expiresAtIso,
    created_at: nowIso,
  };
  await attachTrackGenres(row);
  return { skipped: false, row };
}

// Cron entry point (same contract as buildOption2Batch).
export async function buildOption2TimelineBatch({ ownerId, businessId, bizName, hours, origin, now = new Date() }) {
  const plan = await planOption2Timeline({ businessId, hours, now });
  if (plan.fallback) return buildNaiveOption2Batch({ ownerId, businessId, bizName, hours, origin, now });
  const built = [];
  const failures = [];
  for (let i = 0; i < plan.slots.length; i++) {
    if (i > 0) await sleep(BUILD_STAGGER_MS);
    const slot = plan.slots[i];
    try {
      const r = await createTimelineMix({
        origin, ownerId, businessId, bizName, title: slot.title, tracks: slot.tracks, expiryIso: plan.expiryIso, meta: slot.meta,
      });
      if (r.skipped) failures.push({ title: r.title, reason: r.reason });
      else built.push(r.row);
    } catch (err) {
      console.warn(`[v7 option2] "${slot.title}" failed:`, err.message);
      failures.push({ title: slot.title, reason: err.message });
    }
  }
  if (built.length) await insertPlaylistRows(built);
  return { built, failures };
}
