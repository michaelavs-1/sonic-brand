/* /api/v7/_ops-email.js
   Emails about customers for Roni's work inbox (2026-10-06): new
   subscriptions (account/signup.js), cancellations + resumes
   (account/subscription.js), and an owner's "דווחו" report when daily
   playlists failed (account/daily-status.js). Dev alerts still go to
   ALERT_EMAIL_TO via api/_alert.js.

   Not an HTTP endpoint. Bare imports only. */

import { sendAlert } from '../_alert.js';

export const OPS_EMAIL_TO = 'ronnie@algorithm-media.com';

// 'YYYY-MM-DD' → 'DD.MM.YYYY'.
export const ilDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '—');

// Outside Vercel production the subject starts with "[בדיקה]". Never throws;
// callers await it before responding (Vercel freezes the function after
// res.end()). → true when sent.
export async function emailOps({ subject, lines }) {
  const dev = process.env.VERCEL_ENV !== 'production';
  const r = await sendAlert({
    to: OPS_EMAIL_TO,
    subject: `${dev ? '[בדיקה] ' : ''}${subject}`,
    text: [...lines, ...(dev ? ['', 'נשלח מסביבת פיתוח (בדיקה).'] : [])].join('\n'),
  });
  if (!r.ok) console.warn('[ops-email] send failed:', r.reason);
  return r.ok;
}
