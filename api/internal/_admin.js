/* Shared helpers for the admin console endpoints (/api/internal/*).
   Not an HTTP endpoint (leading underscore). Bare imports only.

   - every read uses the service key (the admin API bypasses RLS);
   - selectAll pages past PostgREST's 1,000-row cap (a plain select silently
     stops there — that's what made the old gemini-spend totals unsafe);
   - logAdminAction appends to admin_actions (migration
     2026-10-13-admin-console.sql), best-effort. */

import { pgrSelect, pgrInsert } from '../v5/supabase-client.js';
import { pgrSelectAll } from '../v4/supabase-client.js';
import { ilPartsFromDate } from '../../v7/generation/playlist-length.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const hasServiceKey = () => !!SERVICE_KEY;

// Every matching row, any table size. `order` must be a unique key.
export function selectAll(table, filters, { select = '*', order }) {
  return pgrSelectAll(table, filters, { select, order, useService: true });
}

// A select that answers [] instead of throwing when the table or a column
// doesn't exist yet (a migration not run) — the admin views degrade, never 500.
export async function selectOrEmpty(table, filters, opts) {
  try {
    const rows = await pgrSelect(table, filters, { ...opts, useService: true });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn(`[internal] ${table} read failed (migration not run?):`, e.message.slice(0, 200));
    return [];
  }
}

// Every auth user, page by page (the admin API caps a page at 1,000).
export async function listAllAuthUsers() {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`auth admin list failed: ${r.status} ${t.slice(0, 200)}`);
    }
    const data = await r.json().catch(() => ({}));
    const users = Array.isArray(data?.users) ? data.users : [];
    out.push(...users);
    if (users.length < 1000) break;
  }
  return out;
}

// One auth user, or null when it's gone (an orphaned business).
export async function fetchAuthUser(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) {
    if (r.status === 404) return null;
    const t = await r.text().catch(() => '');
    throw new Error(`auth admin user ${userId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}

// The businesses row (every column — '*' keeps working as columns are added).
export async function loadBusiness(id) {
  const rows = await pgrSelect('businesses', { id: `eq.${id}` }, { select: '*', limit: 1, useService: true });
  return rows?.[0] || null;
}

// Israel calendar date of an instant ('YYYY-MM-DD').
export const ilDateOf = (iso) => (iso ? ilPartsFromDate(new Date(iso)).isoDate : null);

// 'YYYY-MM-DD' + k days.
export function addDays(isoDate, k) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}

export function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(String(host)) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// Append one admin_actions row. Never throws.
export async function logAdminAction(businessId, action, detail) {
  try {
    await pgrInsert('admin_actions', { business_id: businessId || null, action, detail: detail ?? null });
  } catch (e) {
    console.warn(`[internal] admin_actions insert (${action}) failed (migration 2026-10-13-admin-console.sql run?):`, e.message.slice(0, 200));
  }
}

export const round6 = (n) => Number((Number(n) || 0).toFixed(6));
