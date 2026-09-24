/* /api/v7/account/_replace-status.js
   "Replace today's playlists now?" — whether the question applies right now,
   and how many replacements the owner has left today.

   Asked after a timeline save or a playlist-type switch in the Profile tab
   (Roni, 2026-09-24). Applies only when today already has live daily
   playlists and the venue hasn't closed yet (before opening, or open — right
   up to closing time).
   Capped at REPLACE_CAP per business day; every replacement that built at
   least one playlist writes a business_settings_changes row
   (field 'daily_playlists_replaced'), which is what the cap counts.

   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect } from '../../v5/supabase-client.js';
import { businessWindowAt } from '../../../v7/generation/energy-timeline.js';

export const REPLACE_CAP = 2;
export const REPLACE_FIELD = 'daily_playlists_replaced';

// Daily playlists built for the current business day. The cron builds up to
// 2h before opening, so look back 3h before IL midnight of the business day
// (covers venues that open right after midnight).
export function businessDaySinceIso(w) {
  return new Date(Date.parse(w.dayStartIso) - 3 * 3600 * 1000).toISOString();
}

export async function liveDailyRows(businessId, sinceIso, now = new Date()) {
  const rows = await pgrSelect('business_playlists',
    { business_id: `eq.${businessId}`, event_id: 'is.null', created_at: `gte.${sinceIso}` },
    { select: 'spotify_id,label,created_at,expires_at', order: 'created_at.desc', limit: 20, useService: true });
  return (rows || []).filter((r) => !r.expires_at || Date.parse(r.expires_at) > now.getTime());
}

export async function replacementsUsedToday(businessId, w) {
  const rows = await pgrSelect('business_settings_changes',
    { business_id: `eq.${businessId}`, field: `eq.${REPLACE_FIELD}`, changed_at: `gte.${w.dayStartIso}` },
    { select: 'id', limit: 50, useService: true });
  return (rows || []).length;
}

// → { eligible, left, cap, reason }
//   eligible: there IS a live set today that could be replaced now (ask the
//             question). The question still shows at the cap — with the
//             button disabled and the "max reached" message.
//   left:     replacements remaining today (0 → cap reached).
//   reason:   why not eligible ('closed-today' | 'past-close' | 'no-live-playlists'),
//             'replace-cap' when eligible but out of replacements, else null.
export async function replaceStatus({ businessId, hours, now = new Date() }) {
  const w = businessWindowAt(hours, now);
  const used = await replacementsUsedToday(businessId, w).catch(() => 0);
  const left = Math.max(0, REPLACE_CAP - used);
  const base = { left, cap: REPLACE_CAP };
  if (w.phase !== 'before-open' && w.phase !== 'open') {
    return { ...base, eligible: false, reason: w.phase === 'closed' ? 'closed-today' : 'past-close' };
  }
  const live = await liveDailyRows(businessId, businessDaySinceIso(w), now);
  if (!live.length) return { ...base, eligible: false, reason: 'no-live-playlists' };
  return { ...base, eligible: true, reason: left ? null : 'replace-cap' };
}
