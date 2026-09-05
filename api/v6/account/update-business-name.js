/* /api/v6/account/update-business-name.js
   Persist a business's display name from the profile-tab editor.

   Previously the client did this via a direct `sb.from('businesses').update({name})`
   under RLS. Routed through this endpoint (added 2026-09-05) so we can log
   the change to `business_settings_changes` alongside hours edits. Owner
   rename is rare but the audit trail is nice-to-have for Michael's admin
   dashboard.

   Request:  { businessId, name }
   Response: { ok: true, name } | { error }
*/

import { pgrSelect, pgrPatch, pgrInsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner }           from './_require-business-owner.js';
import { setCors }                        from '../origin-guard.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

const NAME_MAX_LEN = 80;

async function verifyUser(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, name } = req.body || {};
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    const cleanName = String(name || '').trim().slice(0, NAME_MAX_LEN);
    if (!cleanName) return res.status(400).json({ error: 'name required (non-empty)' });

    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Snapshot current name before the update so the audit row captures
    // both sides. If the read fails we still write the update — better to
    // lose one audit row than to block the owner's rename.
    let beforeName = null;
    try {
      const rows = await pgrSelect('businesses',
        { id: `eq.${businessId}` },
        { select: 'name', limit: 1, useService: true });
      beforeName = rows?.[0]?.name || null;
    } catch (e) {
      console.warn('[update-business-name] before-snapshot read failed:', e.message);
    }

    // No-op if unchanged. Return early rather than write an empty audit row.
    if (beforeName === cleanName) {
      return res.status(200).json({ ok: true, name: cleanName, unchanged: true });
    }

    await pgrPatch('businesses',
      { id: `eq.${businessId}` },
      { name: cleanName });

    try {
      await pgrInsert('business_settings_changes', {
        business_id: businessId,
        field:       'name',
        before:      beforeName,
        after:       cleanName,
      });
    } catch (e) {
      console.warn('[update-business-name] audit insert failed:', e.message);
    }

    return res.status(200).json({ ok: true, name: cleanName });
  } catch (err) {
    console.error('[update-business-name] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
