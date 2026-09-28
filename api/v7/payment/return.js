/* /api/v7/payment/return.js
   Hyp's "successful transaction" redirect target. Set this URL in the Hyp
   portal of each terminal (הגדרות → API-דף תשלום ו → הפנייה לאחר עסקה →
   עסקה שהצליחה → לינק מותאם אישית), e.g.
     http://localhost:3000/api/v7/payment/return          (test terminal, vercel dev)
     https://robin-music.com/api/v7/payment/return        (production terminal)

   Hyp loads it inside the payment iframe with Id, CCode, Amount, Order, HKId,
   Sign, ... appended. We verify that exact query string with Hyp (What=VERIFY),
   mark the payment_checkouts row paid, and return a tiny page that tells the
   parent window (same origin) so onboarding continues. The parent also polls
   /api/v7/payment/status, so a lost message never strands the owner.

   Idempotent: a reload of a paid checkout just re-renders the success page.
   Hyp sends no server-to-server notification — this redirect is the only
   signal a payment happened.
*/

import { pgrSelect, pgrPatch } from '../../v5/supabase-client.js';
import { guard } from '../../v6/ratelimit.js';
import { hypConfig, parseHyp, verifyReturn } from './_hyp.js';

function page(res, status, { title, body, checkoutId = null, paymentStatus = null }) {
  const msg = JSON.stringify({ source: 'rubin-hyp', checkoutId, status: paymentStatus });
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>רובין · תשלום</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#fff;color:#1b2a33;
       text-align:center;padding:24px;box-sizing:border-box}
  h2{margin:0 0 8px;font-size:22px} p{margin:0;color:#5b6b75;font-size:15px}
</style></head>
<body><div><h2>${title}</h2><p>${body}</p></div>
<script>try{if(window.parent!==window)window.parent.postMessage(${msg},location.origin)}catch(e){}</script>
</body></html>`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-payment-return', 60, 60)) return;

  // The raw query string, byte for byte — VERIFY needs it unchanged.
  const url = String(req.url || '');
  const q = url.indexOf('?');
  const rawQuery = q === -1 ? '' : url.slice(q + 1);
  const p = parseHyp(rawQuery);
  const failPage = (title, body) => page(res, 400, { title, body });

  if (!/^\d+$/.test(String(p.Order || ''))) {
    console.warn('[v7 payment return] missing/invalid Order:', rawQuery.slice(0, 200));
    return failPage('משהו השתבש', 'לא הצלחנו לזהות את התשלום. אם חויבתם, צרו איתנו קשר.');
  }

  try {
    const rows = await pgrSelect('payment_checkouts', { order_no: `eq.${p.Order}` },
      { select: '*', limit: 1, useService: true });
    const checkout = Array.isArray(rows) ? rows[0] : null;
    if (!checkout) {
      console.warn(`[v7 payment return] order ${p.Order} not found`);
      return failPage('משהו השתבש', 'לא הצלחנו לזהות את התשלום. אם חויבתם, צרו איתנו קשר.');
    }

    const success = () => page(res, 200, {
      title: '✓ התשלום התקבל',
      body: 'ממשיכים…',
      checkoutId: checkout.id,
      paymentStatus: 'paid',
    });
    if (checkout.status === 'paid') return success();

    // Verify against the terminal that created this checkout.
    const { valid, ccode: verifyCcode } = await verifyReturn({ cfg: hypConfig(checkout.hyp_env), rawQuery });
    const approved = valid && String(p.CCode) === '0';
    const nowIso = new Date().toISOString();

    if (!approved) {
      console.warn(`[v7 payment return] order ${p.Order} not approved: verify=${verifyCcode} CCode=${p.CCode}`);
      await pgrPatch('payment_checkouts', { id: `eq.${checkout.id}` }, {
        status: 'failed', hyp_ccode: p.CCode ?? null, return_query: rawQuery.slice(0, 4000), updated_at: nowIso,
      });
      return page(res, 200, {
        title: 'התשלום לא אושר',
        body: 'אפשר לנסות שוב.',
        checkoutId: checkout.id,
        paymentStatus: 'failed',
      });
    }

    // The amounts were signed by us, so a mismatch shouldn't happen — log it
    // rather than strand a customer Hyp already charged.
    const amt = Number(p.Amount);
    if (amt !== Number(checkout.amount_first) && amt !== Number(checkout.amount_monthly)) {
      console.warn(`[v7 payment return] order ${p.Order} amount ${p.Amount} ≠ first ${checkout.amount_first} / monthly ${checkout.amount_monthly}`);
    }
    if (!p.HKId) {
      console.warn(`[v7 payment return] order ${p.Order} paid but no HKId — recurring agreement may not have been created`);
    }

    await pgrPatch('payment_checkouts', { id: `eq.${checkout.id}` }, {
      status:       'paid',
      paid_at:      nowIso,
      hyp_trans_id: p.Id || null,
      hyp_hk_id:    p.HKId || null,
      hyp_acode:    p.ACode || null,
      hyp_ccode:    p.CCode,
      hyp_amount:   p.Amount || null,
      return_query: rawQuery.slice(0, 4000),
      updated_at:   nowIso,
    });
    console.log(`[v7 payment return] ${checkout.hyp_env} order ${p.Order} PAID (Id=${p.Id}, HKId=${p.HKId || '-'}, Amount=${p.Amount})`);
    return success();
  } catch (err) {
    console.error(`[v7 payment return] order ${p.Order} error:`, err.message);
    return page(res, 500, {
      title: 'לא הצלחנו לאמת את התשלום',
      body: 'נסו שוב בעוד רגע. אם זה חוזר, צרו איתנו קשר.',
    });
  }
}
