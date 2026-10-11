/* /api/v7/account/_build-log.js
   v7_daily_build_log — what happened when a business's daily playlists were
   built, or why they weren't (migration 2026-10-06-v7-daily-build-log.sql).
   Written by api/cron/v7-generate-daily.js and generate-daily.js; read by
   daily-status.js for the dashboard's reason line and the "דווחו" report.
   Best-effort both ways: a missing table never blocks a build.
   Not an HTTP endpoint. Bare imports only. */

import { pgrInsert, pgrSelect } from '../../v5/supabase-client.js';

const MAX_DETAIL = 2000;

// The v7 cron builds a business's day at the first hourly run within this
// many minutes of opening (api/cron/v7-generate-daily.js uses it too).
export const BUILD_LEAD_MINUTES = 120;

// rows: [{ business_id, il_date, source, outcome, built?, failed?, detail? }]
export async function logDailyBuilds(rows) {
  if (!rows?.length) return;
  try {
    await pgrInsert('v7_daily_build_log', rows.map((r) => ({
      ...r,
      built:  r.built  || 0,
      failed: r.failed || 0,
      detail: r.detail ? String(r.detail).slice(0, MAX_DETAIL) : null,
    })));
  } catch (e) {
    console.warn('[v7 build-log] insert failed (migration run?):', e.message);
  }
}

// Newest first. null = couldn't read (e.g. the migration hasn't run).
export async function readBuildLog(businessId, sinceIso, limit = 20) {
  try {
    const rows = await pgrSelect('v7_daily_build_log',
      { business_id: `eq.${businessId}`, created_at: `gte.${sinceIso}` },
      { select: 'il_date,source,outcome,built,failed,detail,created_at', order: 'created_at.desc', limit, useService: true });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn('[v7 build-log] read failed:', e.message);
    return null;
  }
}
