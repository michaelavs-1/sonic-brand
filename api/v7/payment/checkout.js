/* /api/v7/payment/checkout.js
   Signs the v7 subscription payment page: validates the details (and the
   coupon, while coupons are on), records the payment_checkouts row, and asks
   Hyp to sign the page.

     GET  → { paymentsEnabled: true, amountMonthly, couponsEnabled, env }
          | { paymentsEnabled: false }   (PAYMENTS_ENABLED in _hyp.js is off —
                                          the screen shows the placeholder; POST → 503)

     POST { email, businessName?, coupon?, onboardingSessionId?, checkoutId?,
            billing: { name, address?, invoiceBusinessName?, taxId? } }
     →    { checkoutId, paymentUrl, amountFirst, amountMonthly,
            coupon: { code, percentOff } | null, env: 'test' | 'production' }
     | 400 { error: 'invalid_coupon' | <Hebrew billing message> | 'valid email required' }

   businessName is the onboarding name (Hyp reports only). billing is the
   payment screen's form: name = the cardholder (required); the invoice is
   made out to invoiceBusinessName when given, otherwise to name.

   The payment screen re-signs whenever the owner edits a detail (Hyp needs
   them inside the signed request). Passing the page's checkoutId updates that
   row while it's still pending, so one payment attempt stays one row with one
   Order; otherwise a new row is created.

   The browser loads paymentUrl in an iframe. Hyp then redirects the iframe to
   /api/v7/payment/return, which verifies the payment and marks the row paid.
   Amounts come only from here and are covered by Hyp's signature, so the
   browser can't change them.
*/

import { pgrSelect, pgrInsert, pgrPatch } from '../../v5/supabase-client.js';
import { requireSite, setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { PAYMENTS_ENABLED, monthlyPriceIls, hypConfig, hypEnv, signPaymentPage } from './_hyp.js';

// First-month coupons are OFF: Hyp's server returns a 500 after charging the
// card whenever a recurring payment page carries TashFirstPayment (every
// number format — reported to Hyp 2026-09-28). While off, the coupon field is
// hidden and any coupon sent is ignored. Turn back on once Hyp fixes it.
const COUPONS_ENABLED = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns { billing } or { error } (a Hebrew message for the form).
function cleanBilling(raw) {
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const billing = {
    name:                text(raw?.name, 80),
    address:             text(raw?.address, 150),
    invoiceBusinessName: text(raw?.invoiceBusinessName, 100),
    taxId:               String(raw?.taxId ?? '').replace(/[\s-]/g, ''),
  };
  if (!billing.name) return { error: 'הכניסו שם מלא' };
  if (billing.taxId && !/^\d{5,12}$/.test(billing.taxId)) return { error: 'מספר ח.פ / ע.מ לא תקין' };
  return { billing };
}

async function findCoupon(code) {
  const rows = await pgrSelect('payment_coupons',
    { code: `eq.${code}`, active: 'eq.true' },
    { select: 'code,percent_off', limit: 1, useService: true });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// This page's earlier checkout, if it's still pending (same email + terminal).
async function findPendingCheckout(checkoutId, email, env) {
  if (!UUID_RE.test(String(checkoutId || ''))) return null;
  const rows = await pgrSelect('payment_checkouts',
    { id: `eq.${checkoutId}`, status: 'eq.pending', email: `eq.${email}`, hyp_env: `eq.${env}` },
    { select: 'id,order_no', limit: 1, useService: true });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    if (!PAYMENTS_ENABLED) return res.status(200).json({ paymentsEnabled: false });
    try {
      return res.status(200).json({
        paymentsEnabled: true, amountMonthly: monthlyPriceIls(), couponsEnabled: COUPONS_ENABLED, env: hypEnv(),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!PAYMENTS_ENABLED) return res.status(503).json({ error: 'התשלום אינו פעיל כרגע.' });
  if (!await guard(req, res, 'v7-checkout', 30, 60)) return;

  try {
    const { email, businessName, coupon, onboardingSessionId, checkoutId } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'valid email required' });
    const bizName = String(businessName || '').trim().slice(0, 80);
    const { billing, error: billingError } = cleanBilling(req.body?.billing);
    if (billingError) return res.status(400).json({ error: billingError });

    let couponRow = null;
    const code = COUPONS_ENABLED ? String(coupon || '').trim().toUpperCase() : '';
    if (code) {
      couponRow = await findCoupon(code);
      if (!couponRow) return res.status(400).json({ error: 'invalid_coupon' });
    }

    let cfg;
    try { cfg = hypConfig(); }
    catch (e) {
      console.error('[v7 checkout]', e.message);
      return res.status(500).json({ error: 'התשלום לא מוגדר כרגע. נסו שוב מאוחר יותר.' });
    }

    const amountMonthly = monthlyPriceIls(cfg.env);
    const amountFirst = couponRow
      ? Math.round(amountMonthly * (100 - couponRow.percent_off)) / 100
      : amountMonthly;
    const details = {
      business_name:  bizName || null,
      coupon_code:    couponRow?.code || null,
      percent_off:    couponRow?.percent_off ?? null,
      amount_first:   amountFirst,
      amount_monthly: amountMonthly,
      billing,
    };

    let checkout = await findPendingCheckout(checkoutId, cleanEmail, cfg.env);
    if (checkout) {
      await pgrPatch('payment_checkouts', { id: `eq.${checkout.id}` },
        { ...details, updated_at: new Date().toISOString() });
    } else {
      const inserted = await pgrInsert('payment_checkouts', {
        ...details,
        hyp_env:               cfg.env,
        masof:                 cfg.masof,
        email:                 cleanEmail,
        onboarding_session_id: typeof onboardingSessionId === 'string' ? onboardingSessionId.slice(0, 100) : null,
      }, { returnRows: true });
      checkout = Array.isArray(inserted) ? inserted[0] : inserted;
      if (!checkout?.id || !checkout?.order_no) throw new Error('checkout insert returned no row');
    }

    let paymentUrl;
    try {
      paymentUrl = await signPaymentPage({
        cfg,
        orderNo:      checkout.order_no,
        amountMonthly,
        amountFirst,
        email:        cleanEmail,
        businessName: bizName,
        billing,
      });
    } catch (e) {
      console.error(`[v7 checkout] ${cfg.env} sign failed for order ${checkout.order_no}:`, e.message);
      await pgrPatch('payment_checkouts', { id: `eq.${checkout.id}` },
        { status: 'failed', hyp_ccode: e.ccode || null, updated_at: new Date().toISOString() })
        .catch(() => {});
      return res.status(502).json({ error: 'לא הצלחנו לפתוח את דף התשלום. נסו שוב עוד רגע.' });
    }

    console.log(`[v7 checkout] ${cfg.env} order ${checkout.order_no} (${cleanEmail}) first=${amountFirst} monthly=${amountMonthly}${couponRow ? ` coupon=${couponRow.code}` : ''}`);
    return res.status(200).json({
      checkoutId:    checkout.id,
      paymentUrl,
      amountFirst,
      amountMonthly,
      coupon:        couponRow ? { code: couponRow.code, percentOff: couponRow.percent_off } : null,
      env:           cfg.env,
    });
  } catch (err) {
    console.error('[v7 checkout] failed:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
