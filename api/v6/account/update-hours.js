/* /api/v6/account/update-hours.js
   Persist a business's opening hours from the profile-tab editor.

   Upserts business_hours (PK = business_id) with the full weekly hours
   object + longest_minutes. Overwrites whatever was there; the editor
   emits the whole week atomically, so partial updates aren't a use case.

   Request:  { businessId, hours, longestMinutes? }
   Response: { ok: true } | { error }
*/

import { pgrUpsert, pgrSelect, pgrInsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner }  from './_require-business-owner.js';
import { setCors }               from '../origin-guard.js';

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

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, hours, longestMinutes } = req.body || {};
    if (!businessId || !hours || typeof hours !== 'object') {
      return res.status(400).json({ error: 'businessId and hours required' });
    }
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Snapshot the current hours before the upsert so we can write an
    // audit row. Best-effort — a read failure here shouldn't block the
    // write path.
    let beforeHours = null;
    try {
      const rows = await pgrSelect('business_hours',
        { business_id: `eq.${businessId}` },
        { select: 'hours,longest_minutes', limit: 1, useService: true });
      if (rows?.[0]) {
        beforeHours = { hours: rows[0].hours, longest_minutes: rows[0].longest_minutes };
      }
    } catch (e) {
      console.warn('[update-hours] before-snapshot read failed:', e.message);
    }

    const nextLongestMinutes = Number.isFinite(longestMinutes) && longestMinutes > 0
      ? Math.round(longestMinutes)
      : null;
    await pgrUpsert('business_hours', {
      business_id:     businessId,
      hours,
      longest_minutes: nextLongestMinutes,
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'business_id' });

    // Log the change to business_settings_changes. Skip when nothing
    // actually moved (owner hit save without editing) — otherwise the
    // audit log fills with no-op rows. Comparison via JSON.stringify is
    // fine here: `hours` is a small stable-key object emitted by the same
    // editor, so key ordering is consistent.
    const afterHours = { hours, longest_minutes: nextLongestMinutes };
    const changed = !beforeHours
      || JSON.stringify(beforeHours) !== JSON.stringify(afterHours);
    if (changed) {
      try {
        await pgrInsert('business_settings_changes', {
          business_id: businessId,
          field:       'hours',
          before:      beforeHours,
          after:       afterHours,
        });
      } catch (e) {
        console.warn('[update-hours] audit insert failed:', e.message);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[update-hours] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
