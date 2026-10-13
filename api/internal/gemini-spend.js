/* GET /api/internal/gemini-spend[?from=YYYY-MM-DD&to=YYYY-MM-DD]
   Admin view of Gemini API spend, from gemini_call_log (one row per call,
   written by api/v6/gemini.js — every Gemini call in the app goes through
   that proxy, v7's server-side chats included).

   Auth: bearer `INTERNAL_ADMIN_API_KEY`. CORS: `*` — bearer token IS the boundary.

   Response:
     {
       totals: {
         all_time_usd,            // since_logging_usd + baseline_usd
         baseline_usd,            // Google's bill before logging started (2026-08-25)
         since_logging_usd, all_time_calls,
         attributed_usd,   attributed_calls,    // a business that still exists
         abandoned_usd,    abandoned_calls,     // onboarding that never signed up
         unattributed_usd, unattributed_calls,  // Ami's prompt dashboard, test
                                                // scripts, deleted (test) businesses
         tokens: { input, cached, output, thinking },
       },
       range: { from, to, usd, calls } | null,  // ?from/?to — PACIFIC dates, the
                                                // way Google's billing report
                                                // counts days (for comparing)
       by_month_google: [{ month, usd, calls }],   // Pacific time, newest first
       by_day_google:   [{ day, usd, calls }],     // Pacific time, newest first, 120 days
       by_day:          [{ day, usd, calls }],     // Israel time, newest first, 120 days
       by_label:        [{ label, usd, calls }],
       by_business:     [{ business_id, business_name, owner_email, usd, calls }],
       recent:          [last 50 calls, newest first],
       notes:           [how the numbers are made]
     }

   Reads EVERY row (paged; a plain select stops at 1,000 rows — the old
   version of this endpoint would have under-counted from the 1,001st call).
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { hasServiceKey, listAllAuthUsers, selectAll, round6, ISO_DATE_RE } from './_admin.js';

// Pre-logging baseline: the total Gemini spend from Google's billing
// dashboard covering all calls made BEFORE 2026-08-25 (when gemini_call_log
// was introduced). Pulled from Google Cloud Console → Billing → Reports,
// filtered to "Generative Language API", "since account creation".
//
// Reported by Google as ₪34.02 on 2026-08-25. Converted at ~₪3.7 / $
// (rough Bank of Israel rate around that date; a ~5% drift is negligible
// for a one-off baseline). Bump this value if you re-pull the report and
// the number has changed materially.
const HISTORICAL_BASELINE_USD = 9.19;

const dateIn = (tz) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => (iso ? f.format(new Date(iso)) : '');
};
const pacificDate = dateIn('America/Los_Angeles');
const israelDate  = dateIn('Asia/Jerusalem');

function bump(map, key, cost, extra = {}) {
  const b = map.get(key) || { ...extra, usd: 0, calls: 0 };
  b.usd += cost;
  b.calls += 1;
  map.set(key, b);
}
const out = (map, sortFn) => [...map.values()].sort(sortFn).map((b) => ({ ...b, usd: round6(b.usd) }));

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    const from = ISO_DATE_RE.test(String(req.query?.from || '')) ? req.query.from : null;
    const to   = ISO_DATE_RE.test(String(req.query?.to || ''))   ? req.query.to   : null;

    const [rows, businesses, users] = await Promise.all([
      selectAll('gemini_call_log', {}, { select: '*', order: 'id.asc' }),
      pgrSelect('businesses', {}, { select: 'id,name,owner_id', useService: true }),
      listAllAuthUsers().catch(() => []),
    ]);
    const all = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    const emailByUserId = new Map(users.filter((u) => u?.id).map((u) => [u.id, u.email || null]));
    const bizById = new Map((businesses || []).map((b) => [b.id, { name: b.name || null, owner_email: emailByUserId.get(b.owner_id) || null }]));

    const t = { all: 0, attributed: 0, abandoned: 0, unattributed: 0 };
    const n = { all: 0, attributed: 0, abandoned: 0, unattributed: 0 };
    const tokens = { input: 0, cached: 0, output: 0, thinking: 0 };
    const range = from || to ? { from, to, usd: 0, calls: 0 } : null;
    const byDay = new Map();
    const byDayG = new Map();
    const byMonthG = new Map();
    const byLabel = new Map();
    const byBusiness = new Map();
    let firstCached = null;

    for (const r of all) {
      const cost = Number(r.cost_usd) || 0;
      t.all += cost; n.all += 1;
      const bucket = r.business_id && bizById.has(r.business_id) ? 'attributed'
        : r.onboarding_session_id ? 'abandoned' : 'unattributed';
      t[bucket] += cost; n[bucket] += 1;
      if (bucket === 'attributed') bump(byBusiness, r.business_id, cost, { business_id: r.business_id });

      tokens.input += Number(r.input_tokens) || 0;
      tokens.cached += Number(r.cached_tokens) || 0;
      tokens.output += Number(r.output_tokens) || 0;
      tokens.thinking += Number(r.thinking_tokens) || 0;
      if (Number(r.cached_tokens) > 0 && (!firstCached || r.created_at < firstCached)) firstCached = r.created_at;

      const dG = pacificDate(r.created_at);
      if (range && (!from || dG >= from) && (!to || dG <= to)) { range.usd += cost; range.calls += 1; }
      bump(byDayG, dG, cost, { day: dG });
      bump(byMonthG, dG.slice(0, 7), cost, { month: dG.slice(0, 7) });
      const dI = israelDate(r.created_at);
      bump(byDay, dI, cost, { day: dI });
      const lbl = r.label || '(unlabeled)';
      bump(byLabel, lbl, cost, { label: lbl });
    }
    if (range) range.usd = round6(range.usd);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      totals: {
        all_time_usd:       round6(t.all + HISTORICAL_BASELINE_USD),
        baseline_usd:       HISTORICAL_BASELINE_USD,
        since_logging_usd:  round6(t.all),
        all_time_calls:     n.all,
        attributed_usd:     round6(t.attributed),   attributed_calls:   n.attributed,
        abandoned_usd:      round6(t.abandoned),    abandoned_calls:    n.abandoned,
        unattributed_usd:   round6(t.unattributed), unattributed_calls: n.unattributed,
        tokens,
      },
      range,
      by_month_google: out(byMonthG, (a, b) => b.month.localeCompare(a.month)),
      by_day_google:   out(byDayG, (a, b) => b.day.localeCompare(a.day)).slice(0, 120),
      by_day:          out(byDay, (a, b) => b.day.localeCompare(a.day)).slice(0, 120),
      by_label:        out(byLabel, (a, b) => b.usd - a.usd),
      by_business:     out(byBusiness, (a, b) => b.usd - a.usd).map((b) => ({
        business_id: b.business_id,
        business_name: bizById.get(b.business_id)?.name || null,
        owner_email: bizById.get(b.business_id)?.owner_email || null,
        usd: b.usd, calls: b.calls,
      })),
      recent: all.slice(0, 50),
      notes: [
        'cost_usd per call = Google\'s published gemini-3.6-flash rates (api/v6/gemini-pricing.js) × the token counts Google returned for that call; thinking tokens are billed as output.',
        `Prompt tokens served from Google's cache (billed at a tenth of the input rate) are logged and priced since ${firstCached || 'migration 2026-10-13-admin-console.sql runs'}; before that they were priced at the full input rate, so older costs run slightly high (input is ~19% of total cost).`,
        'Not counted: Gemini calls made outside this app with the same Google project/key (e.g. AI Studio), and any taxes on Google\'s bill.',
        'by_day_google / by_month_google / range use Pacific time, like Google\'s billing reports; by_day uses Israel time.',
      ],
    });
  } catch (err) {
    console.error('[internal:gemini-spend] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
