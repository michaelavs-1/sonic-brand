/* /api/v7/account/subscription.js
   The Profile tab's "מנוי" section: the owner's monthly subscription (a
   Hyp-managed recurring agreement, הוראת קבע) and its cancellation.

     GET  ?business_id=<uuid>
       → { paymentsEnabled: false }                    (V7_PAYMENTS_ENABLED off — section hidden)
       → { paymentsEnabled: true, subscription: null } (no paid checkout, e.g. signed up while
                                                        payments were off — section hidden)
       → { paymentsEnabled: true, subscription: {
             status,        'active' | 'cancelled' (runs until lastDay) | 'ended'
             amountMonthly, ILS
             startedOn,     the latest payment's date (Israel, YYYY-MM-DD) — a
                            renewal restarts it
             nextChargeOn,  active only — calculated, Hyp doesn't report charges
             lastDay,       cancelled / ended — the last day of service
             invoiceEmail, invoiceName, taxId,
             billing } }    last payment's form details (pre-fill the renewal)

     Renewal after the end ("חידוש המנוי") is a new payment, not a call here:
     api/v7/payment/checkout.js (renewBusinessId) → Hyp → return.js, which
     reactivates the subscription (renewSubscription in _subscription.js).

     POST { business_id, action: 'cancel', reason? }
       Terminates the Hyp agreement (HKStatus NewStat=1) and records the
       cancellation: service runs to the end of the paid month
       (businesses.subscription_ends_at = midnight at the next charge date).
       The cancellation is recorded even if Hyp's call fails — the email then
       says to terminate the agreement by hand in the Hyp portal.
     POST { business_id, action: 'resume' }
       Only while cancelled and not yet ended: resumes the agreement
       (NewStat=2) and clears the cancellation. Refused if Hyp's call fails.
     → { ok: true, subscription } | { error, code? }

   Every cancel / resume emails OPS_EMAIL_TO (api/v7/_ops-email.js) and is audited in
   business_settings_changes (field 'subscription').

   Auth: owner JWT; the business read filters on owner_id. Needs migration
   2026-10-06-v7-subscription-cancel.sql (501 needs-migration without it).
*/

import { pgrSelect, pgrPatch } from '../../v5/supabase-client.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { PAYMENTS_ENABLED, hypConfig, setAgreementStatus } from '../payment/_hyp.js';
import { verifyUser, auditSetting } from './_settings-helpers.js';
import {
  subscriptionStatus, readSubscriptionCheckout, nextChargeDate, ilMidnightIso, lastServiceDay,
} from './_subscription.js';
import { emailOps as notify, ilDate } from '../_ops-email.js';
import { ilPartsFromDate } from '../../../v7/generation/playlist-length.js';

// The business row, only if this user owns it (doubles as the ownership check).
async function readOwnedBusiness(businessId, userId) {
  const rows = await pgrSelect('businesses', { id: `eq.${businessId}`, owner_id: `eq.${userId}` }, {
    select: 'id,name,subscription_cancelled_at,subscription_ends_at,subscription_cancel_reason',
    limit: 1, useService: true,
  });
  return rows?.[0] || null;
}

function view(biz, checkout, now = new Date()) {
  const status = subscriptionStatus(biz, now);
  const billing = checkout.billing || {};
  return {
    status,
    amountMonthly: Number(checkout.amount_monthly),
    startedOn: ilPartsFromDate(new Date(checkout.paid_at)).isoDate,
    nextChargeOn: status === 'active' ? nextChargeDate(checkout.paid_at, now) : null,
    lastDay: status === 'active' ? null : lastServiceDay(biz.subscription_ends_at),
    invoiceEmail: billing.invoiceEmail || checkout.email || null,
    invoiceName: billing.invoiceBusinessName || billing.name || null,
    taxId: billing.taxId || null,
    // Last payment's details — pre-fill the renewal form ("חידוש המנוי").
    billing: {
      name: billing.name || '',
      address: billing.address || '',
      invoiceBusinessName: billing.invoiceBusinessName || '',
      taxId: billing.taxId || '',
    },
  };
}

// → Hyp's CCode, or a short reason string when the call couldn't be made.
async function hypAgreement(checkout, terminate) {
  if (!checkout.hyp_hk_id) return 'no HKId stored';
  try {
    return await setAgreementStatus({ cfg: hypConfig(checkout.hyp_env), hkId: checkout.hyp_hk_id, terminate });
  } catch (e) {
    return `request failed: ${e.message}`;
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-subscription', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const businessId = req.method === 'GET' ? String(req.query?.business_id || '') : req.body?.business_id;
    if (!businessId) return res.status(400).json({ error: 'business_id required' });
    if (req.method === 'GET' && !PAYMENTS_ENABLED) return res.status(200).json({ paymentsEnabled: false });

    // Both reads at once (the Profile tab waits on this). The checkout is
    // only used once the business read has confirmed ownership.
    const [owned, checkout] = await Promise.all([
      readOwnedBusiness(businessId, user.id).then((b) => ({ b }), (e) => ({ e })),
      readSubscriptionCheckout(businessId),
    ]);
    if (owned.e) {
      console.error('[v7 subscription] business read failed (migration run?):', owned.e.message);
      return res.status(501).json({ error: 'needs-migration', code: 'needs-migration' });
    }
    const biz = owned.b;
    if (!biz) return res.status(403).json({ error: 'not your business' });

    if (req.method === 'GET') {
      return res.status(200).json({ paymentsEnabled: true, subscription: checkout ? view(biz, checkout) : null });
    }

    if (!checkout) return res.status(404).json({ error: 'לא נמצא מנוי לחשבון הזה' });
    const action = req.body?.action;
    const now = new Date();
    const status = subscriptionStatus(biz, now);
    const amount = `₪${Number(checkout.amount_monthly)}`;
    const who = [
      `עסק: ${biz.name || '(ללא שם)'}`,
      `אימייל: ${checkout.email || user.email || '—'}`,
      `מזהה עסק: ${businessId}`,
      `מחיר חודשי: ${amount}`,
      `מנוי מאז: ${ilDate(ilPartsFromDate(new Date(checkout.paid_at)).isoDate)}`,
    ];

    if (action === 'cancel') {
      if (status !== 'active') return res.status(200).json({ ok: true, subscription: view(biz, checkout, now) });

      // Kept whole, however long (Roni, 2026-10-24); it used to be cut at 1,000 characters.
      const reason = String(req.body?.reason || '').trim() || null;
      const next = nextChargeDate(checkout.paid_at, now);
      const endsAt = ilMidnightIso(next);
      const ccode = await hypAgreement(checkout, true);
      const terminated = ccode === '0';

      // Recorded even when Hyp's call failed: the owner did their part, and
      // the email below asks for a manual termination in the portal.
      const patch = {
        subscription_cancelled_at: now.toISOString(),
        subscription_ends_at: endsAt,
        subscription_cancel_reason: reason,
      };
      await pgrPatch('businesses', { id: `eq.${businessId}` }, patch);
      await auditSetting(businessId, 'subscription', { status: 'active' },
        { status: 'cancelled', ends_at: endsAt, reason, hyp_hk_id: checkout.hyp_hk_id, hyp_ccode: ccode });
      console.log(`[v7 subscription] biz ${businessId} cancelled — ends ${endsAt}, Hyp HKStatus=${ccode}`);

      await notify({
        subject: terminated
          ? `ביטול מנוי — ${biz.name || businessId}`
          : `ביטול מנוי — ${biz.name || businessId} — צריך לבטל ידנית ב-Hyp`,
        lines: [
          'לקוח ביטל את המנוי ברובין.',
          '',
          ...who,
          `הפלייליסטים ממשיכים עד: ${ilDate(lastServiceDay(endsAt))} (סוף החודש ששולם)`,
          `סיבה: ${reason || '(לא נכתבה)'}`,
          '',
          terminated
            ? `הוראת הקבע בוטלה ב-Hyp (HKId ${checkout.hyp_hk_id}, מסוף ${checkout.hyp_env}).`
            : `⚠️ הוראת הקבע לא בוטלה ב-Hyp (${ccode}). יש לבטל אותה ידנית בפורטל של Hyp — HKId ${checkout.hyp_hk_id || 'לא שמור'}, מסוף ${checkout.hyp_env}.`,
        ],
      });
      return res.status(200).json({ ok: true, subscription: view({ ...biz, ...patch }, checkout, now) });
    }

    if (action === 'resume') {
      if (status === 'active') return res.status(200).json({ ok: true, subscription: view(biz, checkout, now) });
      if (status === 'ended') {
        return res.status(409).json({ code: 'ended', error: 'המנוי כבר הסתיים, ואי אפשר לחדש אותו מכאן.' });
      }
      const ccode = await hypAgreement(checkout, false);
      if (ccode !== '0') {
        console.warn(`[v7 subscription] biz ${businessId} resume failed at Hyp: ${ccode}`);
        return res.status(502).json({ code: 'hyp', error: 'לא הצלחנו לחדש את המנוי כרגע. נסו שוב בעוד כמה דקות.' });
      }
      const patch = { subscription_cancelled_at: null, subscription_ends_at: null, subscription_cancel_reason: null };
      await pgrPatch('businesses', { id: `eq.${businessId}` }, patch);
      await auditSetting(businessId, 'subscription',
        { status: 'cancelled', ends_at: biz.subscription_ends_at, reason: biz.subscription_cancel_reason },
        { status: 'active', hyp_hk_id: checkout.hyp_hk_id, hyp_ccode: ccode });
      console.log(`[v7 subscription] biz ${businessId} resumed`);

      const resumed = view({ ...biz, ...patch }, checkout, now);
      await notify({
        subject: `חידוש מנוי — ${biz.name || businessId}`,
        lines: [
          'לקוח שביטל את המנוי חידש אותו לפני שהסתיים.',
          '',
          ...who,
          `החיוב הבא: ${ilDate(resumed.nextChargeOn)}`,
          `הוראת הקבע חודשה ב-Hyp (HKId ${checkout.hyp_hk_id}, מסוף ${checkout.hyp_env}).`,
        ],
      });
      return res.status(200).json({ ok: true, subscription: resumed });
    }

    return res.status(400).json({ error: 'action must be cancel or resume' });
  } catch (err) {
    console.error('[v7 subscription] failed:', err.message);
    return res.status(500).json({ error: 'משהו השתבש — נסו שוב' });
  }
}
