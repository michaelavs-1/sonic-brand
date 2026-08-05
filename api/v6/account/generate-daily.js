/* /api/v6/account/generate-daily.js
   Build a fresh set of daily playlists on demand for the logged-in user.

   Currently used by the account dashboard's "המקום פתוח?" flow — the user
   is on a day their business is marked closed, and they want playlists
   anyway. Reuses the LATEST direction set from business_playlists (the
   last onboarding or cron-generated batch), builds one 12h playlist per
   direction, and INSERTs new rows into business_playlists.

   Passes `expiryIso = null` into the shared builder → closed-day playlists
   default to next 04:00 IL (nextIl4amIso).

   Auto-scheduled daily generation lives at /api/cron/generate-daily.js
   which uses the SAME shared builder with `expiryIso` = "2h after that
   day's closing time".

   Request:  { businessId, bizName?, targetTracks? }
   Response: { ok: true, count, playlists: [...] } | { error }
*/

import { buildDailyBatch, latestDirections } from './_daily-builder.js';
import { closedDayTargetTracks } from '../../../v6/generation/playlist-length.js';
import { requireBusinessOwner } from './_require-business-owner.js';
import { pgrSelect } from '../../v5/supabase-client.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, bizName, targetTracks } = req.body || {};
    if (!businessId) return res.status(400).json({ error: 'businessId required' });

    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Default to 12h + 1h for the closed-day flow (that's what
    // closedDayTargetTracks returns). Callers can override with an explicit
    // targetTracks — the future user-triggered "make me a longer one" flow
    // would use this.
    const target = Number.isFinite(targetTracks) && targetTracks > 0
      ? Math.min(Math.round(targetTracks), 500)
      : closedDayTargetTracks();

    // Pull the recent non-event playlist rows so latestDirections can pick
    // the newest batch. 20 rows is enough to cover any single batch (the
    // direction system caps at 8 per batch) with headroom.
    let recentRows = [];
    try {
      recentRows = await pgrSelect('business_playlists',
        { business_id: `eq.${businessId}`, event_id: 'is.null' },
        { select: 'expansion,event_id,created_at',
          order: 'created_at.desc', limit: 20 },
      );
    } catch (e) {
      console.warn('[generate-daily] business_playlists read failed:', e.message);
    }

    const { directions, popularityWindow } = latestDirections(recentRows);
    if (!directions.length) {
      return res.status(400).json({ error: 'לא נמצאו כיוונים מוסיקליים לבניית פלייליסטים' });
    }

    const { built, failures } = await buildDailyBatch({
      ownerId:    user.id,
      businessId,
      bizName,
      directions,
      popularityWindow,
      target,
      expiryIso:  null,       // closed-day playlists keep the 24h default
      origin:     selfOrigin(req),
    });

    if (!built.length) {
      return res.status(500).json({
        error: 'לא הצלחנו לבנות אף פלייליסט. נסו שוב.',
        failures,
      });
    }

    console.log(`[generate-daily] user=${user.id} biz=${businessId} built ${built.length}/${directions.length} playlists (target=${target} tracks, closed-day)`);
    return res.status(200).json({ ok: true, count: built.length, playlists: built });
  } catch (err) {
    console.error('[generate-daily] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
