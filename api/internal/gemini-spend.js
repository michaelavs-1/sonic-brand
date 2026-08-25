/* GET /api/internal/gemini-spend
   Admin view of Gemini API spend.

   Auth: bearer token in `Authorization: Bearer <INTERNAL_ADMIN_API_KEY>`.
   CORS: `*` — bearer token IS the boundary.

   Response shape:
     {
       totals: {
         all_time_usd, all_time_calls,
         attributed_usd, attributed_calls,      // rows with business_id set
         abandoned_usd,  abandoned_calls        // rows with onboarding_session_id
                                                //   still set (no signup)
       },
       by_day: [
         { day: 'YYYY-MM-DD',  usd, calls }     // UTC dates, newest first, up to 90 days
       ],
       by_label: [
         { label,              usd, calls }     // e.g. 'onboarding', 'event-chat'
       ],
       by_business: [
         { business_id, business_name, owner_email, usd, calls }  // attributed
                                                //   rows only, sorted by usd desc
       ],
       recent: [
         { id, created_at, model, label,
           input_tokens, output_tokens, thinking_tokens,
           cost_usd, business_id, onboarding_session_id,
           finish_reason, http_status }         // last 50 calls, newest first
       ]
     }

   Aggregation is done in JS after a single fetch — good enough for
   pilot scale (thousands of rows). If the table grows past ~50k rows,
   move to a Postgres RPC that GROUP BYs on the server.
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HARD_ROW_CAP = 10000;   // sanity cap; PostgREST default is 1000

// Same admin-API paginated list users.js uses. Kept inline (rather than
// shared) since both files are small and dependency-light.
async function listAllAuthUsers() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  return Array.isArray(data?.users) ? data.users : [];
}

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

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    // Pull log rows + businesses + auth users in parallel. Business + user
    // fetches are for enriching the `by_business` rollup with name / email.
    const [rows, businesses, users] = await Promise.all([
      pgrSelect('gemini_call_log', {}, {
        select: 'id,created_at,model,label,input_tokens,output_tokens,thinking_tokens,total_tokens,cost_usd,business_id,onboarding_session_id,http_status,finish_reason',
        order:  'created_at.desc',
        limit:  HARD_ROW_CAP,
        useService: true,
      }),
      pgrSelect('businesses', {}, {
        select: 'id,name,owner_id',
        useService: true,
      }),
      listAllAuthUsers(),
    ]);

    const all = Array.isArray(rows) ? rows : [];
    const emailByUserId = new Map();
    for (const u of users) if (u?.id) emailByUserId.set(u.id, u.email || null);
    const bizById = new Map();
    for (const b of (businesses || [])) {
      bizById.set(b.id, { name: b.name || null, owner_email: emailByUserId.get(b.owner_id) || null });
    }

    let all_time_usd    = 0;
    let attributed_usd  = 0;
    let abandoned_usd   = 0;
    let all_time_calls  = 0;
    let attributed_calls = 0;
    let abandoned_calls = 0;

    const byDay      = new Map();  // 'YYYY-MM-DD' → { usd, calls }
    const byLabel    = new Map();  // label        → { usd, calls }
    const byBusiness = new Map();  // business_id  → { usd, calls }

    for (const r of all) {
      const cost = Number(r.cost_usd) || 0;
      all_time_usd   += cost;
      all_time_calls += 1;

      if (r.business_id) {
        attributed_usd   += cost;
        attributed_calls += 1;
        const bbucket = byBusiness.get(r.business_id) || { business_id: r.business_id, usd: 0, calls: 0 };
        bbucket.usd   += cost;
        bbucket.calls += 1;
        byBusiness.set(r.business_id, bbucket);
      } else if (r.onboarding_session_id) {
        abandoned_usd    += cost;
        abandoned_calls  += 1;
      }
      // Rows with neither ID (e.g. Ami's prompt dashboard, unattributed
      // one-offs) are counted in all_time but not in either bucket.

      const day = (r.created_at || '').slice(0, 10);
      if (day) {
        const bucket = byDay.get(day) || { day, usd: 0, calls: 0 };
        bucket.usd   += cost;
        bucket.calls += 1;
        byDay.set(day, bucket);
      }

      const lbl = r.label || '(unlabeled)';
      const lbucket = byLabel.get(lbl) || { label: lbl, usd: 0, calls: 0 };
      lbucket.usd   += cost;
      lbucket.calls += 1;
      byLabel.set(lbl, lbucket);
    }

    const round = (n) => Number(n.toFixed(6));

    const by_day = [...byDay.values()]
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, 90)
      .map((d) => ({ day: d.day, usd: round(d.usd), calls: d.calls }));

    const by_label = [...byLabel.values()]
      .sort((a, b) => b.usd - a.usd)
      .map((l) => ({ label: l.label, usd: round(l.usd), calls: l.calls }));

    const by_business = [...byBusiness.values()]
      .sort((a, b) => b.usd - a.usd)
      .map((b) => {
        const meta = bizById.get(b.business_id) || {};
        return {
          business_id:   b.business_id,
          business_name: meta.name        || null,
          owner_email:   meta.owner_email || null,
          usd:           round(b.usd),
          calls:         b.calls,
        };
      });

    const recent = all.slice(0, 50);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      totals: {
        // all_time_usd includes the pre-logging historical baseline.
        // The two other fields let the UI show the split.
        all_time_usd:      round(all_time_usd + HISTORICAL_BASELINE_USD),
        baseline_usd:      HISTORICAL_BASELINE_USD,
        since_logging_usd: round(all_time_usd),
        all_time_calls,                             // calls we've logged only
        // Attributed / abandoned only cover logged calls — the historical
        // baseline is one lump sum with no attribution possible.
        attributed_usd:    round(attributed_usd),
        attributed_calls,
        abandoned_usd:     round(abandoned_usd),
        abandoned_calls,
      },
      by_day,
      by_label,
      by_business,
      recent,
    });
  } catch (err) {
    console.error('[internal:gemini-spend] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
