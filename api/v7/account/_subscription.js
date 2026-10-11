/* /api/v7/account/_subscription.js
   The owner's monthly subscription (a Hyp-managed recurring agreement, הוראת
   קבע): what the Profile tab's "מנוי" section shows, and the "has it ended?"
   check the daily builders use. Not an HTTP endpoint. Bare imports only.

   Hyp sends nothing when it charges the agreement each month, so the charge
   dates are worked out here: monthly on the first payment's day (Israel
   date), clamped to the month's last day (Jan 31 → Feb 28 → Mar 31).

   A cancelled subscription keeps working until the end of the month that was
   paid for: businesses.subscription_ends_at = midnight (Israel) at the start
   of the next charge date. From then on the v7 cron and the build endpoints
   skip the business (subscriptionEnded / endedSubscriptionIds). Needs
   migration 2026-10-06-v7-subscription-cancel.sql; without it nothing counts
   as ended.
*/

import { pgrSelect, pgrPatch } from '../../v5/supabase-client.js';
import { auditSetting } from './_settings-helpers.js';
import { emailOps, ilDate } from '../_ops-email.js';
import { ilPartsFromDate, ilWallClockToUtc } from '../../../v7/generation/playlist-length.js';

const pad = (n) => String(n).padStart(2, '0');

// Shown when a build is refused after the subscription ended.
export const SUBSCRIPTION_ENDED_MESSAGE = 'המנוי שלכם הסתיים, ולכן לא נבנים יותר פלייליסטים.';

// 'YYYY-MM-DD' k months later, clamped to that month's last day.
export function addMonthsIso(isoDate, k) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const total = (m - 1) + k;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, new Date(Date.UTC(ny, nm, 0)).getUTCDate());
  return `${ny}-${pad(nm)}-${pad(nd)}`;
}

// The next monthly charge: the first monthly date after the first payment's
// date that falls after today (Israel). A charge day counts as already charged,
// so cancelling on it keeps the month that charge paid for.
export function nextChargeDate(paidAtIso, now = new Date()) {
  const start = ilPartsFromDate(new Date(paidAtIso)).isoDate;
  const today = ilPartsFromDate(now).isoDate;
  for (let k = 1; k < 1200; k++) {
    const d = addMonthsIso(start, k);
    if (d > today) return d;
  }
  return null;
}

// Midnight (Israel) at the start of a 'YYYY-MM-DD' date, as an ISO instant.
export function ilMidnightIso(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return ilWallClockToUtc({ year, month, day, hour: 0, minute: 0 }).toISOString();
}

// The last day of service (Israel date) for a subscription_ends_at instant.
export function lastServiceDay(endsAtIso) {
  return ilPartsFromDate(new Date(Date.parse(endsAtIso) - 60 * 1000)).isoDate;
}

// 'active' | 'cancelled' (still running until ends_at) | 'ended'.
export function subscriptionStatus(biz, now = new Date()) {
  if (!biz?.subscription_cancelled_at) return 'active';
  const ends = Date.parse(biz.subscription_ends_at || '');
  return Number.isFinite(ends) && ends > now.getTime() ? 'cancelled' : 'ended';
}

// The paid checkout behind a business's subscription (latest one), or null.
export async function readSubscriptionCheckout(businessId) {
  const rows = await pgrSelect('payment_checkouts',
    { business_id: `eq.${businessId}`, status: 'eq.paid' },
    { select: 'id,hyp_env,hyp_hk_id,amount_monthly,paid_at,email,billing', order: 'paid_at.desc', limit: 1, useService: true });
  return rows?.[0] || null;
}

// True once a cancelled subscription has run out. Never throws — any read
// problem (incl. the migration not run yet) counts as not ended, so a DB blip
// can't stop a paying customer's playlists.
export async function subscriptionEnded(businessId, now = new Date()) {
  try {
    const rows = await pgrSelect('businesses', { id: `eq.${businessId}` },
      { select: 'subscription_cancelled_at,subscription_ends_at', limit: 1, useService: true });
    return subscriptionStatus(rows?.[0], now) === 'ended';
  } catch (e) {
    console.warn(`[v7 subscription] ended check for ${businessId} failed (counted as not ended):`, e.message);
    return false;
  }
}

// Ids of v7 businesses whose subscription has ended — one query for the cron.
// Never throws (see subscriptionEnded).
export async function endedSubscriptionIds(now = new Date()) {
  try {
    const rows = await pgrSelect('businesses',
      { version: 'eq.v7', subscription_ends_at: `lte.${now.toISOString()}` },
      { select: 'id', limit: 1000, useService: true });
    return new Set((rows || []).map((r) => r.id));
  } catch (e) {
    console.warn('[v7 subscription] ended-subscriptions read failed (nobody skipped):', e.message);
    return new Set();
  }
}

// A renewal payment confirmed by Hyp (a checkout tied to a business from the
// start — api/v7/payment/checkout.js renewBusinessId): reactivate the
// subscription, audit it, and email OPS_EMAIL_TO. return.js calls this BEFORE
// marking the checkout paid, so the account is active by the time the page
// sees "paid" and builds today's playlists. If the subscription is already
// active (e.g. paid twice from two tabs), nothing changes and the email asks
// for the extra standing order to be cancelled and refunded.
export async function renewSubscription({ checkout, hkId, amount, now = new Date() }) {
  const rows = await pgrSelect('businesses', { id: `eq.${checkout.business_id}` }, {
    select: 'id,name,subscription_cancelled_at,subscription_ends_at,subscription_cancel_reason',
    limit: 1, useService: true,
  });
  const biz = rows?.[0];
  if (!biz) return;
  const status = subscriptionStatus(biz, now);
  const who = [
    `עסק: ${biz.name || '(ללא שם)'}`,
    `אימייל: ${checkout.email || '—'}`,
    `מזהה עסק: ${biz.id}`,
    `מחיר חודשי: ₪${Number(checkout.amount_monthly)}`,
    ...(Number(checkout.amount_first) !== Number(checkout.amount_monthly)
      ? [`חודש ראשון: ₪${Number(checkout.amount_first)} (קופון ${checkout.coupon_code || '—'})`] : []),
    `סכום שחויב עכשיו: ₪${amount ?? '—'}`,
    `הזמנה ${checkout.order_no} · הוראת קבע (HKId) ${hkId || '—'} · מסוף ${checkout.hyp_env}`,
  ];

  if (status === 'active') {
    console.warn(`[v7 subscription] renewal payment for already-active biz ${biz.id} (order ${checkout.order_no})`);
    await emailOps({
      subject: `תשלום חידוש למנוי שכבר פעיל — ${biz.name || biz.id}`,
      lines: [
        'התקבל תשלום על חידוש מנוי, אבל המנוי של הלקוח כבר פעיל — כנראה תשלום כפול.',
        'יש לבטל את הוראת הקבע החדשה ב-Hyp ולזכות את החיוב.',
        '',
        ...who,
      ],
    });
    return;
  }

  await pgrPatch('businesses', { id: `eq.${biz.id}` },
    { subscription_cancelled_at: null, subscription_ends_at: null, subscription_cancel_reason: null });
  await auditSetting(biz.id, 'subscription',
    { status, ends_at: biz.subscription_ends_at, reason: biz.subscription_cancel_reason },
    { status: 'active', renewed: true, checkout_id: checkout.id, order_no: checkout.order_no, hyp_hk_id: hkId || null });
  console.log(`[v7 subscription] biz ${biz.id} renewed (order ${checkout.order_no})`);
  await emailOps({
    subject: `חידוש מנוי — ${biz.name || biz.id}`,
    lines: [
      'לקוח שהמנוי שלו הסתיים חידש אותו בתשלום חדש.',
      '',
      ...who,
      ...(biz.subscription_ends_at ? [`המנוי הקודם הסתיים: ${ilDate(lastServiceDay(biz.subscription_ends_at))}`] : []),
      `החיוב הבא: ${ilDate(addMonthsIso(ilPartsFromDate(now).isoDate, 1))}`,
    ],
  });
}
