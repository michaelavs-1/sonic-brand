/* The admin console's view of a business's DAILY playlists (business_playlists
   rows with no event): which business day each belongs to, which slot it
   filled, which direction(s) it played, and how often the owner opened it.
   Shared by business.js and daily-picks.js. Not an HTTP endpoint. */

import { undatedLabel } from '../../v7/generation/playlist-length.js';
import { OPTION1_SLOT_NAMES } from '../../v7/generation/daily-picks.js';
import { ilDateOf } from './_admin.js';

const SLOT_BY_NAME = new Map([
  ...Object.entries(OPTION1_SLOT_NAMES).map(([slot, name]) => [name, slot]),
  ['Daily Mix #1', 'mix-1'],
  ['Daily Mix #2', 'mix-2'],
]);
const DATE_IN_LABEL = /·\s*(\d{2})\.(\d{2})\.(\d{4})\s*$/;

// The business day a daily row was built for: Option 2's own record, else the
// date in the dashboard name ("… · 13.10.2026"), else its Israel creation date.
export function businessDayOf(row) {
  const tl = row?.expansion?.v7_timeline;
  if (tl?.il_date) return tl.il_date;
  const m = DATE_IN_LABEL.exec(String(row?.label || ''));
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return ilDateOf(row?.created_at);
}

// What a daily row played.
//   Option 1 → { kind:'option1', direction: { id, title_en, admin_pick } | null, genres }
//              (direction recorded since 2026-10-13; older rows: genres only)
//   Option 2 → { kind:'option2', by_level: [{ level, title_en, genres, admin_pick }], source }
export function playedOf(row) {
  const tl = row?.expansion?.v7_timeline;
  if (tl) {
    const dirs = tl.directions && typeof tl.directions === 'object' ? tl.directions : null;
    return {
      kind: 'option2',
      source: tl.source || null,
      by_level: dirs
        ? Object.entries(dirs).map(([L, d]) => ({ level: Number(L), id: d?.id || null, title_en: d?.title_en || '', genres: d?.genres || [], admin_pick: !!d?.admin_pick }))
          .sort((a, b) => a.level - b.level)
        : [],
    };
  }
  const src = row?.expansion?.direction?.v7_source || null;
  return { kind: 'option1', direction: src, genres: Array.isArray(row?.genres) ? row.genres : [] };
}

// Daily rows + click rows → [{ il_date, playlists: [...], opens_total }],
// newest day first. Each playlist: { spotify_id, url, name, label, slot,
// track_count, created_at, expires_at, live, replaced, opens, played }.
// `replaced` = hidden before its normal expiry ("replace now" / admin rebuild).
export function dailyByDay(rows, opens = [], now = new Date()) {
  const opensBy = new Map();
  for (const o of opens) opensBy.set(o.spotify_id, (opensBy.get(o.spotify_id) || 0) + 1);
  const days = new Map();
  for (const r of rows || []) {
    if (r.event_id) continue;
    const day = businessDayOf(r);
    const name = undatedLabel(r.label);
    const exp = r.expires_at ? Date.parse(r.expires_at) : null;
    const item = {
      spotify_id: r.spotify_id, url: r.url, name, label: r.label, slot: SLOT_BY_NAME.get(name) || null,
      track_count: r.track_count, created_at: r.created_at, expires_at: r.expires_at,
      live: !exp || exp > now.getTime(),
      opens: opensBy.get(r.spotify_id) || 0,
      played: playedOf(r),
    };
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(item);
  }
  // A row hidden by a rebuild expires at the rebuild time, well before the
  // rest of its day's set — flag it.
  for (const list of days.values()) {
    const maxExp = Math.max(...list.map((p) => (p.expires_at ? Date.parse(p.expires_at) : 0)));
    for (const p of list) p.replaced = !!p.expires_at && Date.parse(p.expires_at) < maxExp - 60 * 60 * 1000;
    list.sort((a, b) => String(a.slot || a.name).localeCompare(String(b.slot || b.name)) || String(a.created_at).localeCompare(String(b.created_at)));
  }
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([il_date, playlists]) => ({ il_date, playlists, opens_total: playlists.reduce((n, p) => n + p.opens, 0) }));
}

