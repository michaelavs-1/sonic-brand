/* GET /api/internal/business?id=<business_uuid>
   Admin detail view for one business: everything Michael's dashboard needs
   to show the full onboarding prompt + the resulting directions +
   playlists (with their track spotify_ids).

   Auth: bearer token in `Authorization: Bearer <INTERNAL_ADMIN_API_KEY>` (see
   ./_guard.js). CORS: `*` — the bearer token IS the boundary.

   Response shape:
     {
       business: {
         id, name, owner_id, owner_email, created_at,
         onboarding_expanded, monthly_credits, credits_remaining
       },
       onboarding: {
         business_description: string | null,
         musical_emphases:     string | null,
         atmospheres:          string[]         // from user_metadata
       },
       place:      <business_place row>  | null,
       hours:      <business_hours row>  | null,
       directions: <business_directions[]>,
       playlists:  <business_playlists[]>   // all rows (live + expired)
     }

   All playlist rows carry `track_ids` (array of Spotify track IDs) as
   stored at build time — see the 2026-08-20-business-directions.sql
   migration. Rows created before that migration will have `track_ids:
   null` (unrecoverable from other sources).
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchAuthUser(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) {
    // 404 is a valid "orphaned business" state — return null so the
    // dashboard can render "(owner deleted)" instead of 500-ing.
    if (r.status === 404) return null;
    const t = await r.text().catch(() => '');
    throw new Error(`auth admin user ${userId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    if (!SERVICE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    }

    const id = String(req.query?.id || '').trim();
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'query param `id` must be a business uuid' });
    }

    const businessRows = await pgrSelect('businesses', { id: `eq.${id}` }, {
      select: 'id,name,owner_id,created_at,business_description,musical_emphases,onboarding_expanded,monthly_credits,credits_remaining',
      useService: true,
    });
    const business = Array.isArray(businessRows) && businessRows[0];
    if (!business) return res.status(404).json({ error: 'business not found' });

    // Fetch the owner + all per-business tables in parallel — no ordering
    // dependency between them.
    const [ownerUser, placeRows, hoursRows, directionRows, playlistRows] = await Promise.all([
      fetchAuthUser(business.owner_id),
      pgrSelect('business_place',      { business_id: `eq.${id}` }, { useService: true }),
      pgrSelect('business_hours',      { business_id: `eq.${id}` }, { useService: true }),
      pgrSelect('business_directions', { business_id: `eq.${id}` }, {
        select: 'id,rank,title_en,description_he,genres,bpm_range,popularity_window,instrumentalness_preference,active,created_at,updated_at',
        order: 'rank.asc.nullslast',
        useService: true,
      }),
      pgrSelect('business_playlists', { business_id: `eq.${id}` }, {
        select: 'spotify_id,url,label,ico,track_count,genres,bpm_range,event_id,direction_id,track_ids,expanded_at,expires_at,created_at',
        order: 'created_at.desc',
        useService: true,
      }),
    ]);

    const sonic = ownerUser?.user_metadata?.sonic || {};
    const atmospheres = Array.isArray(sonic?.onboarding?.atmospheres)
      ? sonic.onboarding.atmospheres
      : [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      business: {
        id:                   business.id,
        name:                 business.name || null,
        owner_id:             business.owner_id,
        owner_email:          ownerUser?.email || null,
        created_at:           business.created_at,
        onboarding_expanded:  business.onboarding_expanded,
        monthly_credits:      business.monthly_credits,
        credits_remaining:    business.credits_remaining,
      },
      onboarding: {
        business_description: business.business_description,
        musical_emphases:     business.musical_emphases,
        atmospheres,
      },
      place:      (Array.isArray(placeRows) && placeRows[0]) || null,
      hours:      (Array.isArray(hoursRows) && hoursRows[0]) || null,
      directions: Array.isArray(directionRows) ? directionRows : [],
      playlists:  Array.isArray(playlistRows)  ? playlistRows  : [],
    });
  } catch (err) {
    console.error('[internal:business] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
