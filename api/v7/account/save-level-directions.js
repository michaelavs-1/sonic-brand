/* /api/v7/account/save-level-directions.js
   Persist the per-energy-level direction library the client generated for
   Option 2 (v7/generation/level-directions.js runs in the browser — same
   split as save-energy-directions.js for Option 1).

   Called by v7/account/app.js when the owner picks Option 2 (first-login gate
   or the Profile tab) and the stored library doesn't fit the taste profile
   any more (or there is none). Replace-existing semantics: every row of the
   business in business_v7_level_directions is DELETEd, then the fresh set is
   INSERTed. Nothing FKs to these rows (playlist rows only copy id/title into
   expansion.v7_timeline), so a hard delete is safe. Option 1's library
   (business_v7_directions) is a different table and is never touched.

   The server re-reads the taste profile and:
     - keeps only genres approved AT the direction's level (canonical names),
     - stamps profile_key = levelProfileKey(profile) on every row — the
       dashboard compares it with the live profile to decide whether a stored
       library can be reused (Option 2 → 1 → 2 with unchanged genres).
   Rank = order within the level (the daily rotation walks it). At most
   MAX_PER_LEVEL per level and MAX_ROWS overall, so a crafted request can't
   flood the table.

   Auth: owner JWT (Authorization: Bearer <access_token>) + requireBusinessOwner.
   Needs migration 2026-09-28-v7-level-directions.sql.

   Request body: { business_id, directions: [{energy_level, title_en, genres}] }
   Response: { ok: true, count, profile_key } | { error }
*/

import { pgrDelete, pgrInsert, pgrSelect } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { GENRES } from '../../../shared/genre-universe.js';
import { normLevels } from '../../../v7/generation/energy-timeline.js';
import { levelProfileKey } from '../../../v7/generation/timeline-assembler.js';
import { verifyUser } from './_settings-helpers.js';

// Same ceiling as MAX_PER_LEVEL in v7/generation/level-directions.js (not
// imported — that module pulls in the browser-side model client).
const MAX_PER_LEVEL = 10;
const MAX_ROWS = 60;

const CANONICAL_BY_LOWER = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
const canonicalize = (g) =>
  (typeof g === 'string' ? CANONICAL_BY_LOWER.get(g.trim().toLowerCase()) : null) || null;

// Coerce raw client directions into insertable rows against the taste
// profile. Exported for scripts/_v7-regenerate-level-directions.mjs.
export function shapeLevelRows(businessId, directions, tasteProfile) {
  const N = normLevels(tasteProfile?.energy_levels_total);
  const levelOf = new Map();
  for (const a of Array.isArray(tasteProfile?.approved_genres) ? tasteProfile.approved_genres : []) {
    const g = canonicalize(typeof a === 'string' ? a : a?.genre);
    if (g && !levelOf.has(g)) levelOf.set(g, Math.min(N, Math.max(1, Math.round(Number(a?.energy_level) || 1))));
  }
  const profileKey = levelProfileKey(tasteProfile);

  const rows = [];
  const perLevel = new Map();
  const seenSets = new Set();
  for (const d of Array.isArray(directions) ? directions : []) {
    if (rows.length >= MAX_ROWS) break;
    if (!d || typeof d !== 'object') continue;
    const L = Number(d.energy_level);
    if (!Number.isInteger(L) || L < 1 || L > N) continue;
    if ((perLevel.get(L) || 0) >= MAX_PER_LEVEL) continue;

    const genres = [];
    for (const g of Array.isArray(d.genres) ? d.genres : []) {
      const canon = canonicalize(g);
      if (canon && levelOf.get(canon) === L && !genres.includes(canon)) genres.push(canon);
    }
    if (!genres.length) continue;
    const setKey = `${L}|${[...genres].sort().join('|')}`;
    if (seenSets.has(setKey)) continue;
    seenSets.add(setKey);

    const rank = (perLevel.get(L) || 0) + 1;
    perLevel.set(L, rank);
    const title = typeof d.title_en === 'string' && d.title_en.trim().length
      ? d.title_en.trim().slice(0, 120)
      : '(untitled)';
    rows.push({
      business_id: businessId,
      energy_level: L,
      rank,
      title_en: title,
      genres,
      profile_key: profileKey,
      active: true,
    });
  }
  return { rows, profileKey };
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'save-level-directions', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { business_id, directions } = req.body || {};
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!Array.isArray(directions)) return res.status(400).json({ error: 'directions array required' });
    try { await requireBusinessOwner(business_id, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const [tp] = await pgrSelect('business_taste_profiles', { business_id: `eq.${business_id}` },
      { select: 'approved_genres,energy_levels_total', limit: 1, useService: true });
    if (!tp?.approved_genres?.length) return res.status(400).json({ error: 'no taste profile' });

    const { rows, profileKey } = shapeLevelRows(business_id, directions, tp);
    if (!rows.length) return res.status(400).json({ error: 'no valid directions to save' });

    // Replace-existing (no natural conflict key; nothing FKs to these rows).
    await pgrDelete('business_v7_level_directions', { business_id: `eq.${business_id}` });
    await pgrInsert('business_v7_level_directions', rows);

    console.log(`[save-level-directions] biz ${business_id} — saved ${rows.length} directions (${profileKey})`);
    return res.status(200).json({ ok: true, count: rows.length, profile_key: profileKey });
  } catch (err) {
    console.error('[save-level-directions] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
