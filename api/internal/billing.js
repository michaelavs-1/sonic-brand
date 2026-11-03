/* GET /api/internal/billing
   Every subscription and the payments we know of (2026-11-03, for Michael's
   back office). Read-only.

   What we know: each payment made through our payment page (the first
   payment at signup and any renewal after a subscription ended, in
   payment_checkouts), and the subscription's state (businesses.subscription_*).
   Hyp makes the monthly standing-order charges itself and tells us nothing
   about them, so those charges are not listed, and the next charge date is
   calculated (api/v7/account/_subscription.js), as on the owner's Profile tab.

   Auth: bearer token (./_guard.js). CORS: `*`.

   Response (amounts in agorot, whole numbers):
     { currency: 'ILS',
       list_price_agorot,              this deployment's monthly price
       subscriptions: [{
         business_id, name, owner_email,
         status,                       'active' | 'cancelled' (runs until current_period_end)
                                       | 'ended', or with no business:
                                       'no-account' (paid, never signed up)
                                       | 'account-deleted' (its account was deleted)
         terminal,                     'production' = real money | 'test'
         started_at,                   the payment that started the current subscription
         anchor_day,                   its day of the month (Israel)
         current_period_end,           when the paid month ends
         cancel_at_period_end,         true while cancelled
         next_charge_at,               midnight (Israel) of the next charge date; null when none
         next_charge_date,             the same as YYYY-MM-DD
         next_charge_amount_agorot,    the monthly amount (a coupon only covers the first payment)
         coupon_code, coupon_percent_off,   null: no coupon applies to the next charge
         first_payment: { at, amount_agorot, coupon_code, coupon_percent_off },
         card_brand, card_last4,       null
         last_charge,                  the payment above, while no monthly charge
                                       has been due since; else null
         failed_attempts, grace_ends_at,    null
       }],
       recent_charges: [{ at, business_id, name, amount_agorot, status, failure_reason,
                          kind: 'signup' | 'renewal', terminal }],   newest first, 50
       notes: [] }
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { hasServiceKey, listAllAuthUsers, selectAll, ilDateOf } from './_admin.js';
import { subscriptionStatus, nextChargeDate, addMonthsIso, ilMidnightIso } from '../v7/account/_subscription.js';
import { monthlyPriceIls } from '../v7/payment/_hyp.js';

const agorot = (ils) => (ils == null || ils === '' || !Number.isFinite(Number(ils)) ? null : Math.round(Number(ils) * 100));
const RECENT_LIMIT = 50;

// What the payment page charged (signed by Hyp). Not Hyp's returned Amount:
// on a coupon payment that's the monthly price (order 9: ₪1 charged, "2" returned).
const chargedAgorot = (c) => agorot(c.amount_first);

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const now = new Date();
    const today = ilDateOf(now.toISOString());
    const [businesses, users, checkouts] = await Promise.all([
      pgrSelect('businesses', {}, { select: '*', order: 'created_at.desc', useService: true }),
      listAllAuthUsers(),
      selectAll('payment_checkouts', { status: 'in.(paid,failed)' }, {
        select: 'id,order_no,hyp_env,email,business_name,coupon_code,percent_off,amount_first,amount_monthly,'
              + 'status,hyp_ccode,paid_at,business_id,claimed_at,created_at,updated_at',
        order: 'order_no.asc',
      }),
    ]);

    const emailOf = new Map(users.filter((u) => u?.id).map((u) => [u.id, u.email || null]));
    const bizById = new Map(businesses.map((b) => [b.id, b]));
    const paid = checkouts.filter((c) => c.status === 'paid' && c.paid_at)
      .sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));

    const firstPayment = (c) => ({
      at: c.paid_at,
      amount_agorot: chargedAgorot(c),
      coupon_code: c.coupon_code || null,
      coupon_percent_off: c.coupon_code ? c.percent_off ?? null : null,
    });

    // One subscription from the payment that started it (cur) and its state.
    // cancelledAt: when it was cancelled, if it was (stops the monthly charges).
    const view = ({ businessId, name, ownerEmail, status, cur, first, endsAt, cancelledAt }) => {
      const paidDate = ilDateOf(cur.paid_at);
      const live = status === 'active' || status === 'no-account';
      const next = live ? nextChargeDate(cur.paid_at, now) : null;
      // The payment is still the last charge until the first monthly charge
      // date (a charge day counts as charged), unless cancelled before it.
      const firstMonthly = addMonthsIso(paidDate, 1);
      const cancelledDate = cancelledAt ? ilDateOf(cancelledAt) : null;
      const monthlyDue = today >= firstMonthly && !(cancelledDate && cancelledDate < firstMonthly);
      return {
        business_id: businessId,
        name,
        owner_email: ownerEmail,
        status,
        terminal: cur.hyp_env || null,
        started_at: cur.paid_at,
        anchor_day: Number(paidDate.slice(8, 10)),
        current_period_end: next ? ilMidnightIso(next) : (endsAt || null),
        cancel_at_period_end: status === 'cancelled',
        next_charge_at: next ? ilMidnightIso(next) : null,
        next_charge_date: next,
        next_charge_amount_agorot: next ? agorot(cur.amount_monthly) : null,
        coupon_code: null,
        coupon_percent_off: null,
        first_payment: firstPayment(first),
        card_brand: null,
        card_last4: null,
        last_charge: monthlyDue ? null : { at: cur.paid_at, amount_agorot: chargedAgorot(cur), status: 'succeeded', failure_reason: null },
        failed_attempts: null,
        grace_ends_at: null,
      };
    };

    const subscriptions = [];
    // Businesses with a payment. The newest paid checkout is the current
    // subscription (a renewal starts a new one), as on the Profile tab.
    for (const b of businesses) {
      const rows = paid.filter((c) => c.business_id === b.id);
      if (!rows.length) continue;
      subscriptions.push(view({
        businessId: b.id,
        name: b.name || null,
        ownerEmail: emailOf.get(b.owner_id) || null,
        status: subscriptionStatus(b, now),
        cur: rows[rows.length - 1],
        first: rows[0],
        endsAt: b.subscription_ends_at || null,
        cancelledAt: b.subscription_cancelled_at || null,
      }));
    }
    // Payments with no business: never signed up (Hyp still charges them
    // monthly), or their account was deleted (whether Hyp still charges is
    // unknown: the standing order is stopped by hand, so no next charge).
    for (const c of paid.filter((x) => !x.business_id)) {
      const deleted = !!c.claimed_at;
      subscriptions.push(view({
        businessId: null,
        name: c.business_name || null,
        ownerEmail: c.email || null,
        status: deleted ? 'account-deleted' : 'no-account',
        cur: c,
        first: c,
        endsAt: null,
        cancelledAt: null,
      }));
    }
    subscriptions.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));

    // Every payment we know of, incl. declined ones. A business's first paid
    // checkout is its signup; later ones (and attempts tied to a business
    // from the start) are renewals.
    const firstPaidId = new Map();
    for (const c of paid) if (c.business_id && !firstPaidId.has(c.business_id)) firstPaidId.set(c.business_id, c.id);
    const recent = checkouts
      .map((c) => {
        const ok = c.status === 'paid';
        const biz = c.business_id ? bizById.get(c.business_id) : null;
        return {
          at: ok ? c.paid_at : (c.updated_at || c.created_at),
          business_id: c.business_id || null,
          name: biz?.name || c.business_name || null,
          amount_agorot: ok ? chargedAgorot(c) : agorot(c.amount_first),
          status: ok ? 'succeeded' : 'failed',
          failure_reason: ok ? null : (c.hyp_ccode != null ? `Hyp CCode ${c.hyp_ccode}` : null),
          kind: c.business_id && firstPaidId.get(c.business_id) !== c.id ? 'renewal' : 'signup',
          terminal: c.hyp_env || null,
        };
      })
      .filter((c) => c.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, RECENT_LIMIT);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      currency: 'ILS',
      list_price_agorot: agorot(monthlyPriceIls()),
      subscriptions,
      recent_charges: recent,
      notes: [],
    });
  } catch (err) {
    console.error('[internal:billing] failed:', err.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
