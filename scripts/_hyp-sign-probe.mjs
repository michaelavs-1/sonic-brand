/* Hyp credentials probe — asks Hyp to sign a monthly subscription page at the
   current terminal's price (first month half off, like the TEST50 coupon) and
   prints the payment-page URL.
   Nothing is charged and nothing is written to the database.

     node scripts/_hyp-sign-probe.mjs

   Reads HYP_ENV + HYP_TEST_* / HYP_PROD_* from .env.local (or the shell).
   CCode=902 means the PassP is wrong. Opening the printed URL shows how the
   page renders (Hebrew text, the recurring-charge notice). Don't pay on it:
   its Order (probe-...) has no checkout row, so the return page won't find it.
*/

import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no .env.local — rely on the shell */ }

const { hypConfig, monthlyPriceIls, signPaymentPage } = await import('../api/v7/payment/_hyp.js');

const cfg = hypConfig();
const price = monthlyPriceIls(cfg.env);
console.log(`Hyp ${cfg.env} terminal ${cfg.masof} — ₪${price}/month, first month ₪${price / 2}`);
try {
  const url = await signPaymentPage({
    cfg,
    orderNo:       `probe-${Date.now()}`,
    amountMonthly: price,
    amountFirst:   price / 2,
    email:         'probe@example.invalid',
    businessName:  'בדיקת רובין',
    billing: {
      name:                'ישראל ישראלי',
      address:             'הדקל 14, ראשון לציון',
      invoiceBusinessName: 'בדיקה בע״מ',
      taxId:               '515555555',
    },
  });
  console.log('SIGN ok. Payment page:\n' + url);
} catch (e) {
  console.error(e.message + (e.ccode === '902' ? ' — wrong PassP (or KEY/Masof)' : ''));
  process.exit(1);
}
