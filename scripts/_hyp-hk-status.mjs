/* Terminate (or resume) Hyp recurring agreements (הוראות קבע) by HKId.

     node scripts/_hyp-hk-status.mjs 542583 542590 ...          # terminate
     node scripts/_hyp-hk-status.mjs --resume 542583            # resume

   Uses the terminal selected by HYP_ENV (default test) with the HYP_TEST_* /
   HYP_PROD_* credentials from .env.local (or the shell) — Hyp's
   action=HKStatus, NewStat=1 (terminate) / 2 (resume). Prints one line per
   agreement: CCode=0 means done, 906 means no such agreement on this
   terminal. Agreement numbers are in the Hyp portal, or in
   payment_checkouts.hyp_hk_id for payments that reached our return page.
*/

import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no .env.local — rely on the shell */ }

const { hypConfig, parseHyp } = await import('../api/v7/payment/_hyp.js');

const args = process.argv.slice(2);
const resume = args.includes('--resume');
const ids = args.filter((a) => a !== '--resume');
if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) {
  console.error('usage: node scripts/_hyp-hk-status.mjs [--resume] <HKId> [<HKId> ...]');
  process.exit(1);
}

const cfg = hypConfig();
console.log(`Hyp ${cfg.env} terminal ${cfg.masof} — ${resume ? 'resuming' : 'terminating'} ${ids.length} agreement(s)`);
let failed = 0;
for (const id of ids) {
  const qs = new URLSearchParams({ action: 'HKStatus', Masof: cfg.masof, PassP: cfg.passp, HKId: id, NewStat: resume ? '2' : '1' });
  try {
    const text = (await (await fetch(`https://pay.hyp.co.il/p/?${qs}`)).text()).trim();
    const ccode = text.startsWith('<') ? 'HTML (Hyp system error)' : parseHyp(text).CCode;
    if (ccode !== '0') failed++;
    console.log(`  HKId ${id}: CCode=${ccode}${ccode === '906' ? ' (no such agreement on this terminal)' : ccode === '0' ? ' ✓' : ''}`);
  } catch (e) {
    failed++;
    console.log(`  HKId ${id}: request failed — ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
