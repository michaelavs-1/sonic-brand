/* /api/v7/account/_daily-picks.js
   Read the admin's daily picks for one business day (business_v7_daily_picks,
   migration 2026-10-13-admin-console.sql; what they mean and how the builders
   apply them: v7/generation/daily-picks.js). Set by the admin console
   (api/internal/daily-picks.js).

   Never throws: a missing table (migration not run) or a read error → [] — the
   usual draw then stands, so a DB problem can't stop a build.
   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect } from '../../v5/supabase-client.js';

// → pick rows of `mode` for `isoDate` ('YYYY-MM-DD', the business day).
export async function readDailyPicks(businessId, isoDate, mode) {
  if (!businessId || !isoDate) return [];
  try {
    const rows = await pgrSelect('business_v7_daily_picks',
      { business_id: `eq.${businessId}`, il_date: `eq.${isoDate}`, ...(mode ? { mode: `eq.${mode}` } : {}) },
      { select: 'slot,mode,title_en,genres,energy_range,source_direction_id', useService: true });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (!/business_v7_daily_picks|PGRST205|42P01/.test(e.message || '')) {
      console.warn(`[v7 daily-picks] read failed for biz=${businessId} ${isoDate}:`, e.message);
    }
    return [];
  }
}
