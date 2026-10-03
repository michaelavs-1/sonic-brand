/* /api/v7/account/save-event.js
   "הכן פלייליסט" in the v7 special-playlists chat → one business_events row.
   The client then builds the playlist straight away (event-playlist.js).

   v7 copy of the INSERT path of api/v6/account/upsert-event.js, plus:
   - the daily cap: at most SPECIAL_PLAYLISTS_PER_DAY events per business since
     the last 04:00 IL → 409 { code: 'daily_cap', error: <Hebrew> };
   - genre_source ('event' | 'daily') from the chat's proposal (column added by
     migration 2026-10-03-v7-event-genre-source.sql; if it isn't there yet the
     row is saved without it and read back as 'event').
   No edit path — v7 has no event editing.

   Request:  { businessId, event: { name, description, genre_source }, sessionStartAt }
   Response: { ok: true, event: { id, business_id, name, description, created_at, genre_source? } } */

import { pgrInsert, pgrPatch } from '../../v5/supabase-client.js';
import { setCors }             from '../../v6/origin-guard.js';
import { guard }               from '../../v6/ratelimit.js';
import { verifyUser }          from './_settings-helpers.js';
import {
  ownedBusiness, eventsMadeToday, SPECIAL_PLAYLISTS_PER_DAY, DAILY_CAP_MESSAGE,
} from './_special-events.js';

const GENRE_SOURCES = new Set(['event', 'daily']);

// Link this chat session's business_event_chats rows to the new event (admin
// visibility). Best-effort.
async function backfillEventChatEventId({ businessId, eventId, sessionStartAt }) {
  if (typeof sessionStartAt !== 'string' || Number.isNaN(Date.parse(sessionStartAt))) return;
  try {
    await pgrPatch('business_event_chats',
      { business_id: `eq.${businessId}`, created_at: `gte.${sessionStartAt}`, event_id: 'is.null' },
      { event_id: eventId });
  } catch (e) {
    console.warn('[v7 save-event] event_chats backfill failed:', e.message);
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-save-event', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, event, sessionStartAt } = req.body || {};
    if (!businessId || !event || typeof event !== 'object') {
      return res.status(400).json({ error: 'businessId and event required' });
    }
    try { await ownedBusiness(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const name        = String(event.name || '').trim().slice(0, 120);
    const description = String(event.description || '').trim().slice(0, 4000);
    if (description.length < 5) return res.status(400).json({ error: 'חסר תיאור — כתבו עוד קצת' });
    const genreSource = GENRE_SOURCES.has(event.genre_source) ? event.genre_source : 'event';

    if (await eventsMadeToday(businessId) >= SPECIAL_PLAYLISTS_PER_DAY) {
      return res.status(409).json({ code: 'daily_cap', error: DAILY_CAP_MESSAGE });
    }

    const base = { business_id: businessId, name, description };
    let inserted;
    try {
      inserted = await pgrInsert('business_events', { ...base, genre_source: genreSource }, { returnRows: true });
    } catch (e) {
      if (!/genre_source/.test(e.detail || e.message || '')) throw e;
      console.error('[v7 save-event] business_events.genre_source missing — run migration 2026-10-03-v7-event-genre-source.sql. Saving without it.');
      inserted = await pgrInsert('business_events', base, { returnRows: true });
    }
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!row?.id) return res.status(500).json({ error: 'insert returned no row' });

    await backfillEventChatEventId({ businessId, eventId: row.id, sessionStartAt });
    return res.status(200).json({ ok: true, event: row });
  } catch (err) {
    console.error('[v7 save-event] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
