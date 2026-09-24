/* /api/v7/account/set-delivery-mode.js
   Persist the owner's v7 daily-delivery choice.

   Called by the first-login mode gate (#v7ModeGate in v7/account) and later
   by the Profile-tab "מצב אספקה" re-choose section. Upserts ONE row into
   business_v7_settings (owner-scoped, upsert on business_id):
     - delivery_mode = 'option1' (4 playlists/day: 2 high + 2 low energy)
                     | 'option2' (2 playlists/day: energy shifts over the day)
     - timeline (jsonb, optional) — Option 2's interactive-timeline placeholder.

   Auth: owner JWT (Authorization: Bearer <access_token>) + requireBusinessOwner.

   Request body: { business_id, delivery_mode, timeline? }
   Response: { ok: true, delivery_mode } | { error }
*/

import { pgrUpsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';

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

const MODE_SET = new Set(['option1', 'option2']);

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'set-delivery-mode', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { business_id, delivery_mode, timeline } = req.body || {};
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!MODE_SET.has(delivery_mode)) {
      return res.status(400).json({ error: 'delivery_mode must be option1 or option2' });
    }
    try { await requireBusinessOwner(business_id, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const row = {
      business_id,
      delivery_mode,
      updated_at: new Date().toISOString(),
    };
    // Only Option 2 carries a timeline; a well-formed object overwrites,
    // anything else is left untouched (undefined key is dropped by pgrUpsert).
    if (delivery_mode === 'option2' && timeline && typeof timeline === 'object') {
      row.timeline = timeline;
    }

    await pgrUpsert('business_v7_settings', row, { onConflict: 'business_id' });

    console.log(`[set-delivery-mode] biz ${business_id} — ${delivery_mode}`);
    return res.status(200).json({ ok: true, delivery_mode });
  } catch (err) {
    console.error('[set-delivery-mode] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
