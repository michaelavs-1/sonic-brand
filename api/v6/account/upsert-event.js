/* /api/v6/account/upsert-event.js
   Add or edit one special-event entry on a logged-in business.

   Flow:
     1. Verify Supabase JWT.
     2. requireBusinessOwner(businessId, user.id).
     3. If event.id present → UPDATE business_events by (id, business_id).
        If absent → INSERT and let Postgres generate the uuid.
     4. Return the resulting row (id, name, description, created_at) so the
        client can splice it into local state without a re-fetch.

   Request:
     { businessId, event: { id?, name, description } }
   Response:
     { ok: true, event: { id, name, description, created_at } } | { error }
*/

import { pgrInsert, pgrPatch, pgrSelect } from '../../v5/supabase-client.js';

// Backfill business_event_chats.event_id for every row from the caller's
// current chat session — the session_start_at ISO timestamp the client
// mints on module load / after each finalize. Runs after a successful
// INSERT into business_events; a failure is logged but never surfaced
// (persistence of the event itself is more important than the audit
// link, and the chat rows without event_id are still queryable by time
// range if we ever need to reconstruct).
async function backfillEventChatEventId({ businessId, eventId, sessionStartAt }) {
  if (!businessId || !eventId
      || typeof sessionStartAt !== 'string'
      || !sessionStartAt.length
      || Number.isNaN(Date.parse(sessionStartAt))) return;
  try {
    await pgrPatch('business_event_chats',
      {
        business_id: `eq.${businessId}`,
        created_at:  `gte.${sessionStartAt}`,
        event_id:    'is.null',
      },
      { event_id: eventId },
    );
  } catch (e) {
    console.warn('[upsert-event] event_chats backfill failed:', e.message);
  }
}
import { requireBusinessOwner }           from './_require-business-owner.js';
import { setCors }                        from '../origin-guard.js';

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

    const { businessId, event, sessionStartAt } = req.body || {};
    if (!businessId || !event || typeof event !== 'object') {
      return res.status(400).json({ error: 'businessId and event required' });
    }
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const name        = String(event.name || '').trim().slice(0, 120);
    const description = String(event.description || '').trim().slice(0, 4000);

    if (event.id) {
      // UPDATE existing. Filter by (id, business_id) so a caller can't
      // update someone else's event even with a leaked uuid.
      await pgrPatch('business_events',
        { id: `eq.${event.id}`, business_id: `eq.${businessId}` },
        { name, description },
      );
      // Re-read to return the canonical row (created_at hasn't moved).
      const rows = await pgrSelect('business_events',
        { id: `eq.${event.id}`, business_id: `eq.${businessId}` },
        { select: 'id,business_id,name,description,created_at', limit: 1, useService: true },
      );
      const row = rows?.[0];
      if (!row) return res.status(404).json({ error: 'event not found' });
      return res.status(200).json({ ok: true, event: row });
    }

    // INSERT new — let Postgres generate the uuid.
    const inserted = await pgrInsert('business_events', {
      business_id: businessId,
      name,
      description,
    }, { returnRows: true });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!row?.id) return res.status(500).json({ error: 'insert returned no row' });

    // Stamp business_event_chats rows from this chat session with the
    // freshly-created event's id. Async but awaited (Vercel serverless
    // kills fire-and-forget promises after res.end — see the Gemini
    // spend-log gotcha).
    await backfillEventChatEventId({ businessId, eventId: row.id, sessionStartAt });

    return res.status(200).json({ ok: true, event: row });
  } catch (err) {
    console.error('[upsert-event] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
