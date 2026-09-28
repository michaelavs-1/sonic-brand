/* Hyp Pay (pay.hyp.co.il, formerly YaadPay) — server-side helpers for v7's
   subscription payment. Docs: https://developers.hyp.co.il/pay

   Flow:
     1. signPaymentPage()  → APISign/SIGN. Hyp returns the request, signed; the
                             browser loads https://pay.hyp.co.il/p/?<that> in
                             an iframe.
     2. Hyp redirects the iframe to the "successful transaction" URL set in the
        Hyp portal (→ /api/v7/payment/return) with Id, CCode, Amount, Order,
        HKId, Sign, ... appended.
     3. verifyReturn()     → APISign/VERIFY with that query string, unchanged.

   The subscription is Hyp-managed (הוראת קבע): HK=True, freq=1 (monthly),
   Tash=999 (until cancelled), OnlyOnApprove=True. Amount is the monthly price;
   a first-month coupon becomes TashFirstPayment. SendHesh=True emails a tax
   invoice (invoicing is on by default on Hyp terminals).

   Credentials never leave the server. HYP_ENV picks the terminal:
     'test' (default) → HYP_TEST_MASOF / HYP_TEST_API_KEY / HYP_TEST_PASSP
     'production'     → HYP_PROD_MASOF / HYP_PROD_API_KEY / HYP_PROD_PASSP
*/

const HYP_BASE = 'https://pay.hyp.co.il/p/';
const HYP_TIMEOUT_MS = 15000;

// Master switch for real payments in v7 onboarding. OFF since 2026-09-28:
// invoicing has to come from the company's own invoicing system, which isn't
// connected yet. While off, the payment step shows the old placeholder
// screen, signup doesn't require a paid checkout, and checkout refuses to
// sign pages. Everything Hyp-related stays in place — flip to true to restore.
export const PAYMENTS_ENABLED = false;

// The subscription price (ILS, the final card amount incl. VAT).
export const MONTHLY_PRICE_ILS = 200;
// TEMPORARY: the test terminal charges ₪10 — Hyp's docs ask for ~10 ILS test
// amounts because many developers share the test card. Production always
// charges MONTHLY_PRICE_ILS.
const TEST_TERMINAL_PRICE_ILS = 10;

export function monthlyPriceIls(env = hypEnv()) {
  return env === 'production' ? MONTHLY_PRICE_ILS : TEST_TERMINAL_PRICE_ILS;
}

export function hypEnv() {
  const raw = String(process.env.HYP_ENV || 'test').trim().toLowerCase();
  if (raw !== 'test' && raw !== 'production') {
    throw new Error(`HYP_ENV must be "test" or "production" (got "${raw}")`);
  }
  return raw;
}

// Terminal credentials for an environment (default: the current HYP_ENV).
export function hypConfig(env = hypEnv()) {
  const prefix = env === 'production' ? 'HYP_PROD_' : 'HYP_TEST_';
  const masof = process.env[`${prefix}MASOF`];
  const key   = process.env[`${prefix}API_KEY`];
  const passp = process.env[`${prefix}PASSP`];
  if (!masof || !key || !passp) {
    throw new Error(`Hyp ${env} terminal not configured: set ${prefix}MASOF, ${prefix}API_KEY, ${prefix}PASSP`);
  }
  return { env, masof, key, passp };
}

// Hyp expects %20-style encoding; skip empty values.
function toQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// Parse a Hyp "a=b&c=d" response or redirect query. Values that don't decode
// as UTF-8 (Hyp's Hebrew text fields can be windows-1255) are kept raw — only
// ASCII fields (Id, CCode, Amount, Order, HKId, ...) are ever read from this.
export function parseHyp(text) {
  const out = {};
  for (const part of String(text || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i === -1 ? part : part.slice(0, i);
    const v = i === -1 ? '' : part.slice(i + 1);
    let dv = v;
    try { dv = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    out[k] = dv;
  }
  return out;
}

// Hyp answers 200 for almost everything, errors included — the outcome is in
// CCode. An HTML body means a Hyp-side system error.
async function hypGet(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HYP_TIMEOUT_MS);
  try {
    const r = await fetch(`${HYP_BASE}?${query}`, { signal: ctrl.signal });
    const text = (await r.text()).trim();
    if (!r.ok) throw new Error(`Hyp HTTP ${r.status}`);
    if (text.startsWith('<')) throw new Error('Hyp returned HTML (system error)');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Hyp timed out after ${HYP_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const money = (n) => Number(n).toFixed(2);

// Returns the full payment-page URL for the browser. Throws with err.ccode on
// a Hyp error (902 = wrong PassP, 904 = missing What, ...).
//
// businessName = the onboarding name (Hyp's transaction reports only).
// billing = what the owner typed on our payment screen:
//   { name (required — the cardholder), address?, invoiceBusinessName?, taxId? }
export async function signPaymentPage({
  cfg = hypConfig(),
  orderNo,
  amountMonthly,
  amountFirst,
  email,
  businessName,
  billing = {},
}) {
  const params = {
    action:  'APISign',
    What:    'SIGN',
    KEY:     cfg.key,
    PassP:   cfg.passp,
    Masof:   cfg.masof,
    Amount:  money(amountMonthly),
    // Hyp-managed monthly recurring agreement, until cancelled.
    HK:            'True',
    freq:          '1',
    Tash:          '999',
    OnlyOnApprove: 'True',
    // First-month coupon. Omitted when there's no discount.
    TashFirstPayment: Number(amountFirst) !== Number(amountMonthly) ? money(amountFirst) : undefined,
    Order:   String(orderNo),
    Sign:    'True',
    Info:    businessName ? `Robin - ${businessName}` : 'Robin',
    // Template 6: card fields only. The customer details come from our form —
    // and since the page has no name field, Hyp needs the name here.
    tmp:        '6',
    ClientName: billing.name,
    street:     billing.address || undefined,
    email,
    // Tax invoice by email, made out to ClientName by default. A business name
    // replaces it via EZ.customer_name, and the address goes on the invoice
    // via EZ.customer_address: fields of Hyp's invoicing service (Hyp Invoice,
    // formerly EZcount) passed through like the documented EZ.customer_crn.
    // Those two are NOT in Hyp's docs — check the emailed test invoice.
    SendHesh: 'True',
    heshDesc: 'מנוי חודשי לרובין',
    'EZ.customer_name':    billing.invoiceBusinessName || undefined,
    'EZ.customer_address': billing.address || undefined,
    'EZ.customer_crn':     billing.taxId || undefined,
    // Our Hebrew is UTF-8 (Hyp's legacy default is windows-1255).
    UTF8:    'True',
    UTF8out: 'True',
  };
  const text = await hypGet(toQuery(params));
  if (!/(^|&)signature=/.test(text)) {
    const ccode = parseHyp(text).CCode;
    const err = new Error(`Hyp SIGN failed (CCode=${ccode ?? '?'})`);
    err.ccode = ccode ?? null;
    throw err;
  }
  return `${HYP_BASE}?${text}`;
}

// Verifies a success-page redirect with Hyp. rawQuery must be exactly the
// query string Hyp sent (same order, same encoding). Returns { valid, ccode }.
export async function verifyReturn({ cfg, rawQuery }) {
  const auth = toQuery({ action: 'APISign', What: 'VERIFY', Masof: cfg.masof, KEY: cfg.key, PassP: cfg.passp });
  const text = await hypGet(`${auth}&${rawQuery}`);
  const ccode = parseHyp(text).CCode ?? null;
  return { valid: ccode === '0', ccode };
}
