/* /api/v7/account/_settings-helpers.js
   Small shared pieces for the v7 account settings endpoints
   (update-timeline, set-delivery-mode, update-hours, generate-daily).
   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect, pgrInsert } from '../../v5/supabase-client.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

// Owner JWT → Supabase user (same check every account endpoint does).
export async function verifyUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

export async function readHours(businessId) {
  const rows = await pgrSelect('business_hours', { business_id: `eq.${businessId}` },
    { select: 'hours', limit: 1, useService: true });
  return rows?.[0]?.hours || null;
}

// → the business_v7_settings row ({ delivery_mode, timeline, updated_at }) or null.
export async function readSettings(businessId) {
  const rows = await pgrSelect('business_v7_settings', { business_id: `eq.${businessId}` },
    { select: 'delivery_mode,timeline,updated_at', limit: 1, useService: true });
  return rows?.[0] || null;
}

// Append one business_settings_changes row. Best-effort (never blocks the write).
export async function auditSetting(businessId, field, before, after) {
  try {
    await pgrInsert('business_settings_changes', { business_id: businessId, field, before: before ?? null, after: after ?? null });
  } catch (e) {
    console.warn(`[v7 settings] audit insert (${field}) failed:`, e.message);
  }
}

// Reject absurd payloads before doing any work.
export const MAX_TIMELINE_JSON = 20000;
export const timelineTooBig = (tl) => {
  try { return JSON.stringify(tl ?? null).length > MAX_TIMELINE_JSON; } catch { return true; }
};
