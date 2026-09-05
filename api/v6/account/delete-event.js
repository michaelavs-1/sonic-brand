/* /api/v6/account/delete-event.js
   Delete one special-event entry from a logged-in business.

   Deletes the business_events row identified by (id, business_id). Any
   business_playlists rows with event_id pointing at this event are left
   in place — they'll expire on their own schedule and the dashboard's
   activePlaylistForEvent lookup will simply no longer surface them (the
   event card they belonged to won't render). No cascade needed.

   Request:  { businessId, eventId }
   Response: { ok: true } | { error }
*/

import { pgrSelect, pgrUpsert, pgrDelete } from '../../v5/supabase-client.js';
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

    const { businessId, eventId } = req.body || {};
    if (!businessId || !eventId) {
      return res.status(400).json({ error: 'businessId and eventId required' });
    }
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Snapshot the row into `deleted_events` before deleting so the admin
    // API can still show a full history of the business's events (mirrors
    // Ami's deleted_tracks / deleted_playlists archive pattern). Upsert
    // keyed on `id` so a re-delete of the same event id (shouldn't happen
    // — the delete below removes the source row — but defensive) doesn't
    // 409 on the PK. Best-effort: if the archive INSERT fails we still
    // want the DELETE to run so the UI reflects the owner's action;
    // losing one archive row is preferable to leaving a "deleted"
    // event visible.
    try {
      const rows = await pgrSelect('business_events',
        { id: `eq.${eventId}`, business_id: `eq.${businessId}` },
        { select: 'id,business_id,name,description,created_at', limit: 1, useService: true });
      const src = rows?.[0];
      if (src) {
        await pgrUpsert('deleted_events', [{
          id:                  src.id,
          business_id:         src.business_id,
          name:                src.name,
          description:         src.description,
          original_created_at: src.created_at,
        }], { onConflict: 'id' });
      }
    } catch (e) {
      console.warn('[delete-event] archive to deleted_events failed:', e.message);
    }

    await pgrDelete('business_events', {
      id:          `eq.${eventId}`,
      business_id: `eq.${businessId}`,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[delete-event] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
