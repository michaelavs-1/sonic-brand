/* GET /api/internal/users
   Admin list of every business + its owner email + a flag showing whether
   the free-text onboarding prompt was captured.

   Auth: bearer token in `Authorization: Bearer <INTERNAL_ADMIN_API_KEY>` (see
   ./_guard.js). CORS: `*` — the bearer token IS the boundary.

   Response shape:
     {
       count: <int>,
       businesses: [
         { business_id, name, owner_id, owner_email, created_at,
           has_prompt: bool }
       ]
     }

   `has_prompt` is a hint to Michael's dashboard: rows where either
   business_description or musical_emphases is non-null were signed up
   after the 2026-08-23 migration and have real prompt data in the detail
   endpoint. Older rows (`has_prompt: false`) will still work in the
   detail endpoint but the two free-text fields will be null.
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Fetch every auth.users row so we can join emails onto businesses in
// memory. per_page=1000 is Supabase's admin API upper cap; pilot scale is
// far below this so a single call suffices. If we ever cross that,
// paginate by advancing `page` until the response returns fewer than
// per_page rows.
async function listAllAuthUsers() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`auth admin list failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const data = await r.json().catch(() => ({}));
  return Array.isArray(data?.users) ? data.users : [];
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

    const [businesses, users] = await Promise.all([
      pgrSelect('businesses', {}, {
        select: 'id,name,owner_id,created_at,business_description,musical_emphases',
        order:  'created_at.desc',
        useService: true,
      }),
      listAllAuthUsers(),
    ]);

    const emailByUserId = new Map();
    for (const u of users) if (u?.id) emailByUserId.set(u.id, u.email || null);

    const rows = (businesses || []).map((b) => ({
      business_id: b.id,
      name:        b.name || null,
      owner_id:    b.owner_id,
      owner_email: emailByUserId.get(b.owner_id) || null,
      created_at:  b.created_at,
      has_prompt:  Boolean(b.business_description || b.musical_emphases),
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: rows.length, businesses: rows });
  } catch (err) {
    console.error('[internal:users] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
