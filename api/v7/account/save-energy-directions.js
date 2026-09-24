/* /api/v7/account/save-energy-directions.js
   Persist the energy-tiered directions the client generated for Option 1.

   v7's energy-directions generator (v7/generation/energy-directions.js) runs
   CLIENT-SIDE — callModel does a relative fetch to /api/v6/gemini, which is
   browser-reachable. So the browser produces the directions and this endpoint
   just persists them. That keeps shared ai-provider.js untouched and matches
   how R1/R2/taste-profile already run.

   Called by v7/account/app.js right after a successful option1 mode selection
   (first-login gate OR the Profile-tab re-choose). Replace-existing semantics:
   every active business_v7_directions row for the business is DELETEd, then the
   fresh set is INSERTed. Nothing FKs to business_v7_directions.id (v7 playlist
   rows carry direction_id:null → v6 business_directions), so a hard delete is
   safe.

   Rank is assigned per tier by array order (the model's priority order), so
   buildOption1Batch's "order by rank.asc, split by tier, take first 2 per tier"
   selection is deterministic.

   Auth: owner JWT (Authorization: Bearer <access_token>) + requireBusinessOwner.

   Request body: { business_id, directions: [{energy_tier, title_en, genres}] }
   Response: { ok: true, count } | { error }
*/

import { pgrDelete, pgrInsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { GENRES } from '../../../shared/genre-universe.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

async function verifyUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

// Case-insensitive canonicaliser — the client already normalizes, but a
// crafted request could send junk. Drop anything not in the Genre Universe
// and write back the canonical spelling.
const CANONICAL_BY_LOWER = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
const canonicalize = (g) =>
  (typeof g === 'string' ? CANONICAL_BY_LOWER.get(g.trim().toLowerCase()) : null) || null;

const TIER_SET = new Set(['high', 'low']);

// Coerce raw client directions into insertable rows. Drops directions with a
// bad tier or zero valid genres; assigns per-tier rank by array order.
function shapeRows(businessId, directions) {
  let hi = 0;
  let lo = 0;
  const rows = [];
  for (const d of directions) {
    if (!d || typeof d !== 'object') continue;
    const tier = typeof d.energy_tier === 'string' ? d.energy_tier.trim().toLowerCase() : '';
    if (!TIER_SET.has(tier)) continue;

    const seen = new Set();
    const genres = [];
    const rawGenres = Array.isArray(d.genres) ? d.genres : [];
    for (const g of rawGenres) {
      const canon = canonicalize(g);
      if (canon && !seen.has(canon)) { genres.push(canon); seen.add(canon); }
    }
    if (!genres.length) continue;

    const title = typeof d.title_en === 'string' && d.title_en.trim().length
      ? d.title_en.trim().slice(0, 120)
      : '(untitled)';

    rows.push({
      business_id: businessId,
      energy_tier: tier,
      rank: tier === 'high' ? ++hi : ++lo,
      title_en: title,
      genres,
      active: true,
    });
  }
  return rows;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'save-energy-directions', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { business_id, directions } = req.body || {};
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!Array.isArray(directions)) {
      return res.status(400).json({ error: 'directions array required' });
    }
    try { await requireBusinessOwner(business_id, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const rows = shapeRows(business_id, directions);
    if (!rows.length) {
      return res.status(400).json({ error: 'no valid directions to save' });
    }

    // Replace-existing: clear the old set before inserting the new one so a
    // re-pick doesn't stack stale directions. Delete then insert (not upsert)
    // because there's no natural conflict key and nothing FKs to these rows.
    await pgrDelete('business_v7_directions', { business_id: `eq.${business_id}` });
    await pgrInsert('business_v7_directions', rows);

    console.log(`[save-energy-directions] biz ${business_id} — saved ${rows.length} directions`);
    return res.status(200).json({ ok: true, count: rows.length });
  } catch (err) {
    console.error('[save-energy-directions] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
