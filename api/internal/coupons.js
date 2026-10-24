/* /api/internal/coupons — first-month coupon codes (item 12 of Michael's list,
   2026-10-13). Table payment_coupons (migration 2026-09-27-v7-payments.sql).

   What a coupon does: takes percent_off off the FIRST month only (Hyp's
   TashFirstPayment); every later month is full price. The owner types it on
   the payment screen. Coupons only work where V7_COUPONS_ENABLED=true (the
   field is hidden otherwise) — `coupons_enabled` below is that switch for
   THIS deployment. See docs/v7-payments.md.

   GET
     → { coupons_enabled, monthly_price_ils (the real price, ₪200), coupons: [{ code, percent_off,
         active, note, created_at, first_month_ils, uses_paid, uses_pending,
         uses_failed, last_used_at }] }   newest first

   POST  { code, percent_off, note? }   create (code: 3–32 of A–Z 0–9 _ -,
         stored uppercase; percent_off 1–99 — never 100%: Hyp ignores a ₪0
         first payment and charges the full monthly price instead (checked
         2026-10-24 on the test terminal; see docs/v7-payments.md))
         → 201 { ok, coupon } | 409 code exists
   PATCH { code, active?, note? }      switch a code off/on, change its note.
         A used code can't be deleted (payments point at it) and its percent
         can't change — switch it off and create a new code instead.

   Auth: bearer INTERNAL_ADMIN_API_KEY (./_guard.js). */

import { pgrSelect, pgrInsert, pgrPatch } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { hasServiceKey, logAdminAction, selectAll } from './_admin.js';
import { MONTHLY_PRICE_ILS } from '../v7/payment/_hyp.js';

const CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const couponsEnabled = () => String(process.env.V7_COUPONS_ENABLED || '').trim().toLowerCase() === 'true';
const firstMonth = (monthly, pct) => Math.round(monthly * (100 - pct)) / 100;

// The real customer price (not a test terminal's / dev override's) — what a
// coupon's first month is worked out from here.
const monthlyPrice = () => MONTHLY_PRICE_ILS;

async function list() {
  const [coupons, checkouts] = await Promise.all([
    pgrSelect('payment_coupons', {}, { select: '*', order: 'created_at.desc', useService: true }),
    selectAll('payment_checkouts', { coupon_code: 'not.is.null' }, { select: 'id,coupon_code,status,paid_at,created_at', order: 'id.asc' }),
  ]);
  const monthly = monthlyPrice();
  const uses = new Map();
  for (const c of checkouts) {
    const u = uses.get(c.coupon_code) || { uses_paid: 0, uses_pending: 0, uses_failed: 0, last_used_at: null };
    if (c.status === 'paid') {
      u.uses_paid++;
      if (!u.last_used_at || c.paid_at > u.last_used_at) u.last_used_at = c.paid_at;
    } else if (c.status === 'failed') u.uses_failed++;
    else u.uses_pending++;
    uses.set(c.coupon_code, u);
  }
  return {
    coupons_enabled: couponsEnabled(),
    monthly_price_ils: monthly,
    coupons: (coupons || []).map((c) => ({
      ...c,
      first_month_ils: monthly != null ? firstMonth(monthly, c.percent_off) : null,
      ...(uses.get(c.code) || { uses_paid: 0, uses_pending: 0, uses_failed: 0, last_used_at: null }),
    })),
  };
}

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    if (req.method === 'GET') return res.status(200).json(await list());

    const body = req.body || {};
    const code = String(body.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'code: 3–32 characters, letters A–Z, digits, _ or -' });
    const note = body.note == null ? undefined : String(body.note).trim().slice(0, 300) || null;

    if (req.method === 'POST') {
      const pct = Number(body.percent_off);
      if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
        return res.status(400).json({ error: 'percent_off: a whole number 1–99 (Hyp ignores a ₪0 first payment and would charge the full price)' });
      }
      const existing = await pgrSelect('payment_coupons', { code: `eq.${code}` }, { select: 'code', limit: 1, useService: true });
      if (existing?.length) return res.status(409).json({ error: `${code} already exists`, code: 'exists' });
      const [coupon] = await pgrInsert('payment_coupons', { code, percent_off: pct, active: true, note: note ?? null }, { returnRows: true });
      await logAdminAction(null, 'coupon:create', { code, percent_off: pct, note: note ?? null });
      const monthly = monthlyPrice();
      return res.status(201).json({
        ok: true,
        coupon: { ...coupon, first_month_ils: monthly != null ? firstMonth(monthly, pct) : null },
        ...(couponsEnabled() ? {} : { warning: 'coupons are switched off on this deployment (V7_COUPONS_ENABLED) — owners can\'t use the code yet' }),
      });
    }

    // PATCH
    const patch = {};
    if (typeof body.active === 'boolean') patch.active = body.active;
    if (note !== undefined) patch.note = note;
    if (body.percent_off != null) return res.status(400).json({ error: 'percent_off can\'t change — switch this code off and create a new one' });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change: send active (true/false) and/or note' });
    const existing = await pgrSelect('payment_coupons', { code: `eq.${code}` }, { select: 'code', limit: 1, useService: true });
    if (!existing?.length) return res.status(404).json({ error: `no coupon ${code}` });
    await pgrPatch('payment_coupons', { code: `eq.${code}` }, patch);
    await logAdminAction(null, 'coupon:update', { code, ...patch });
    const all = await list();
    return res.status(200).json({ ok: true, coupon: all.coupons.find((c) => c.code === code) || null });
  } catch (err) {
    console.error('[internal coupons] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
