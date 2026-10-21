/* /api/v7/account/_taste-context.js
   Everything the v7 taste chat's model sees about this business on a turn,
   as the object v7/generation/taste-chat-prompt.js formatTasteContext()
   turns into text:
     - the time now + the venue's business day (Israel time, overnight-aware —
       the chat reads the clock on every message);
     - what actually played over the last 7 days (genre shares, from each
       playlist's per-track genre record);
     - today's live playlists: Option 1 — which recipe each one plays;
       Option 2 — each mix's window and the song planned for right now;
     - Option 2: today's energy curve, hour by hour (top / bottom flagged, so
       the chat never suggests raising a curve that's already at the top);
     - the songs the owner linked, with where each sits in today's playlists;
     - the changes made through this chat (for "undo" and Option 1's 10 → 5
       window steps) and how many replacements are left today.

   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect } from '../../v5/supabase-client.js';
import {
  businessWindowAt, reconcileTimeline, groupForDay, energyAtFn, levelOf, fmtHM,
} from '../../../v7/generation/energy-timeline.js';
import { ilPartsFromDate } from '../../../v7/generation/playlist-length.js';
import { rangeOf } from '../../../v7/generation/taste-ops.js';
import { replaceStatus } from './_replace-status.js';
import { songNames } from './_spotify-links.js';
import { latestPortrait } from './_taste-portrait.js';

const PLAYED_DAYS = 7;
const PLAYED_TOP = 16;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const ddmmyyyy = (p) => `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}.${p.year}`;

// Genre shares over the rows' songs. A song tagged with k genres counts 1/k
// for each.
export function playedShares(rows) {
  const count = new Map();
  let total = 0;
  for (const r of rows) {
    const tg = r.track_genres && typeof r.track_genres === 'object' ? r.track_genres : null;
    const ids = Array.isArray(r.track_ids) ? r.track_ids : [];
    const runGenres = r.expansion?.v7_timeline?.run_genres;
    ids.forEach((id, i) => {
      const gs = tg && Array.isArray(tg[id]) && tg[id].length ? tg[id]
        : Array.isArray(runGenres) && runGenres[i] ? [runGenres[i]] : [];
      if (!gs.length) return;
      total++;
      for (const g of gs) count.set(g, (count.get(g) || 0) + 1 / gs.length);
    });
  }
  if (!total) return [];
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, PLAYED_TOP).map(([genre, n]) => ({ genre, share: n / total }));
}

// The current recipe a playlist plays: Option 1 by genre set (ignoring the
// requested genres every playlist of the tier gets), Option 2 by level + set.
function option1Key(state, genres) {
  const req = new Set(state.requested);
  const core = genres.filter((g) => !req.has(g));
  return state.option1Dirs.find((d) => sameSet(d.genres.filter((g) => !req.has(g)), core))?.key || null;
}
function option2Key(state, level, genres) {
  return state.levelDirs.find((d) => d.energy_level === Number(level) && sameSet(d.genres, genres || []))?.key || null;
}

// Index of the song playing at `nowMin` in a mix (starts = per-track start
// minutes), or -1 outside the mix.
export function songAt(starts, endMin, nowMin) {
  if (!Array.isArray(starts) || !starts.length || nowMin < starts[0] || nowMin >= endMin) return -1;
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1] <= nowMin) i++;
  return i;
}

export async function buildTasteContext({ businessId, biz, state, settings, hours, linked = [], now = new Date(), origin }) {
  const w = businessWindowAt(hours || {}, now);
  const il = ilPartsFromDate(now);
  const nowCtx = {
    weekday: il.dayIdx, date: ddmmyyyy(il), time: fmtHM(il.hour * 60 + il.minute),
    phase: w.phase, open: w.group?.open || null, close: w.group?.close || null,
  };

  const since = new Date(now.getTime() - PLAYED_DAYS * 86400000).toISOString();
  const [rows, changeRows, replace, portrait] = await Promise.all([
    pgrSelect('business_playlists', { business_id: `eq.${businessId}`, event_id: 'is.null', created_at: `gte.${since}` },
      { select: 'spotify_id,label,genres,track_ids,track_genres,expansion,created_at,expires_at', order: 'created_at.desc', limit: 60, useService: true }).catch(() => []),
    // '*': `source` (2026-10-13) when the column exists. Changes made in the
    // admin console aren't the owner's, so the chat isn't shown them.
    pgrSelect('business_taste_changes', { business_id: `eq.${businessId}` },
      { select: '*', order: 'applied_at.desc', limit: 8, useService: true })
      .then((rs) => (rs || []).filter((c) => c.source !== 'admin')).catch(() => []),
    hours ? replaceStatus({ businessId, hours, now }).catch(() => null) : Promise.resolve(null),
    // The owner's musical portrait (2026-10-21) — read alongside the rest, so
    // it adds no wait. Null without the migration.
    latestPortrait(businessId),
  ]);
  const live = (rows || []).filter((r) => !r.expires_at || Date.parse(r.expires_at) > now.getTime());

  // Today's playlists.
  const today = {};
  const timelineRows = live.filter((r) => r.expansion?.v7_timeline && Array.isArray(r.expansion.v7_timeline.starts));
  if (state.mode === 'option2' && timelineRows.length) {
    const rowsByLabel = [...timelineRows].sort((a, b) => String(a.label).localeCompare(String(b.label)));
    const nowIdx = rowsByLabel.map((r) => {
      const t = r.expansion.v7_timeline;
      return songAt(t.starts, t.window?.[1] ?? Infinity, w.nowMin);
    });
    const names = await songNames(rowsByLabel.map((r, k) => (nowIdx[k] >= 0 ? r.track_ids?.[nowIdx[k]] : null)), { origin });
    today.option2 = rowsByLabel.map((r, k) => {
      const t = r.expansion.v7_timeline;
      const i = nowIdx[k];
      let planned_now = null;
      if (i >= 0) {
        const id = r.track_ids?.[i];
        const level = t.levels?.[i];
        const dir = t.directions?.[level];
        planned_now = {
          time: fmtHM(t.starts[i]), ...(names.get(id) || { title: '?', artist: '?' }),
          genre: t.run_genres?.[i] || '?', level, energy: t.energies?.[i] ?? null,
          recipe: dir ? option2Key(state, level, dir.genres) : null,
        };
      }
      return { label: r.label, start: fmtHM(t.window?.[0] ?? t.starts[0]), end: fmtHM(t.window?.[1] ?? t.starts[t.starts.length - 1]), planned_now };
    });
  } else if (state.mode === 'option1') {
    today.option1 = live.filter((r) => r.expansion?.direction).map((r) => {
      const genres = Array.isArray(r.genres) ? r.genres : [];
      // The owner's "today only" energy change (the circles, energy-nudge.js).
      const d = r.expansion.direction;
      const nudged = d.energy_nudge?.usual && d.energy_range
        ? (Number(d.energy_range.min) > Number(d.energy_nudge.usual.min) ? 'more energetic' : 'calmer') : null;
      return { label: r.label, recipe: option1Key(state, genres), genres, nudged };
    });
  }

  // Where each linked song sits in today's playlists.
  const linkedCtx = linked.map((t) => {
    if (!t.spotify_id) return t;
    const in_today = [];
    for (const r of live) {
      const i = (r.track_ids || []).indexOf(t.spotify_id);
      if (i < 0) continue;
      const tl = r.expansion?.v7_timeline;
      if (tl && Array.isArray(tl.starts)) {
        const level = tl.levels?.[i];
        const dir = tl.directions?.[level];
        const recipe = dir ? option2Key(state, level, dir.genres) : null;
        const cur = recipe ? state.levelDirs.find((d) => d.key === recipe) : null;
        in_today.push({
          label: r.label, time: fmtHM(tl.starts[i]), level, recipe, energy: tl.energies?.[i] ?? t.energy ?? null,
          range: cur ? rangeOf(cur, state.N) : (dir?.energy_range || tl.energy_windows?.[level] || null),
        });
      } else {
        in_today.push({ label: r.label });
      }
    }
    return { ...t, in_today };
  });

  // Option 2: today's curve, hour by hour.
  let curve = null;
  if (state.mode === 'option2' && w.group) {
    const tl = reconcileTimeline(settings?.timeline || null, hours);
    const g = groupForDay(tl, w.dayIdx);
    if (g) {
      const f = energyAtFn(g.points);
      const hrs = [];
      for (let m = Math.ceil(w.openMin / 60) * 60; m < w.closeMin; m += 60) {
        const level = levelOf(f(m), state.N);
        hrs.push({ time: fmtHM(m), level, top: level === state.N, bottom: level === 1 });
      }
      curve = { dots: g.points.map((p) => ({ time: fmtHM(p.m), e: Math.round(p.e * 100) / 100 })), hours: hrs };
    }
  }

  const changes = (changeRows || []).map((c) => {
    const p = ilPartsFromDate(new Date(c.applied_at));
    return {
      when: `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')} ${fmtHM(p.hour * 60 + p.minute)}`,
      summary_he: c.summary_he || '', ops: c.ops, undone: !!c.undone_at,
    };
  });

  return {
    business: { name: biz?.name || '', description: biz?.business_description || '', emphases: biz?.musical_emphases || '' },
    portrait: portrait?.portrait_he || null,
    mode: state.mode,
    state,
    now: nowCtx,
    played: playedShares(rows || []),
    today,
    curve,
    linked: linkedCtx,
    changes,
    replace: replace ? { eligible: !!replace.eligible, left: replace.left, cap: replace.cap } : null,
  };
}
