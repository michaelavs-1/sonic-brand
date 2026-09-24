/* /api/v7/account/generate-daily.js
   Owner-triggered daily-playlist build for v7 businesses — the v7 dashboard's
   "צור פלייליסטים" (empty open day) and "המקום פתוח?" (closed day) links.

   v7 counterpart of /api/v6/account/generate-daily (which reads v6's
   business_directions and therefore 400s for every v7 business). Builds
   exactly what the v7 cron would build today, branching on the business's
   delivery mode:
     option1 → 4 playlists from business_v7_directions (2 high + 2 low energy)
     option2 → 2 full-length mixes from business_taste_profiles.approved_genres
   The "what to build" logic is shared with the cron via planOption1 /
   planOption2 in ./_daily-builder.js (onDemand:true — closed days are sized
   like v6's closed-day flow and the expiry never lands in the past).

   Streams the SAME ndjson contract as v6's endpoint, so the dashboard's
   existing runGenerateDaily renderer works unchanged:

       {"type":"plan","directions":[{"direction_id":"slot-0","title":"..."}, ...]}
       {"type":"built","direction_id":"slot-0","row":{...business_playlists row...}}
       {"type":"failed","direction_id":"slot-1","error":"..."}
       {"type":"done","built":3,"failed":1}

   `direction_id` in the stream is only a key that pairs placeholders with
   results ("slot-N"). The persisted rows carry direction_id:null — v7
   directions aren't in v6's business_directions table (FK). A null
   direction_id also keeps the v6-only edit/trash/rename icons off these rows.

   One playlist at a time with a 3s stagger (Spotify rate-limit lesson,
   2026-08-22), INSERT per playlist so rows persist even if the stream is cut.
   Pre-flight failures (auth, ownership, no mode, nothing to build) return
   plain JSON 4xx/5xx.
*/

import { pgrSelect } from '../../v5/supabase-client.js';
import { buildOneDailyPlaylist } from '../../v6/account/_daily-builder.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { planOption1, planOption2, attachTrackGenres, insertPlaylistRows } from './_daily-builder.js';
import { ilPartsFromDate } from '../../../v7/generation/playlist-length.js';

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same value as _daily-builder.js's BUILD_STAGGER_MS (v6). Duplicated because
// the per-playlist loop is inlined here for streaming.
const INTER_PLAYLIST_STAGGER_MS = 3000;

const NOTHING_TO_BUILD = {
  'no-directions':          'הכיוונים המוזיקליים עדיין לא הוכנו — בחרו שוב באפשרות הראשונה בפרופיל',
  'no-approved-genres':     'לא נמצא פרופיל מוזיקלי לבניית פלייליסטים',
  'directions-read-failed': 'שגיאה בטעינת הכיוונים המוזיקליים — נסו שוב',
};

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // ---- pre-flight: JSON responses ----
  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, bizName } = req.body || {};
    if (!businessId) return res.status(400).json({ error: 'businessId required' });

    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const [settingsRows, hoursRows] = await Promise.all([
      pgrSelect('business_v7_settings',
        { business_id: `eq.${businessId}` },
        { select: 'delivery_mode', limit: 1, useService: true }),
      pgrSelect('business_hours',
        { business_id: `eq.${businessId}` },
        { select: 'hours', limit: 1, useService: true }),
    ]);
    const mode  = settingsRows?.[0]?.delivery_mode || null;
    const hours = hoursRows?.[0]?.hours || null;
    if (mode !== 'option1' && mode !== 'option2') {
      return res.status(400).json({ error: 'בחרו קודם סוג פלייליסטים יומיים (בלשונית הפרופיל)' });
    }

    const now  = new Date();

    // One live set per day. This endpoint now also fires automatically right
    // after the first-login mode gate, so guard against a second set from a
    // reload-and-click or double trigger mid-build. Same date key as the v7
    // cron's already-built-today guard, but only LIVE rows count — once
    // today's set has expired, the owner may still build a fresh one.
    const todayIl = ilPartsFromDate(now).isoDate;
    const recent = await pgrSelect('business_playlists',
      { business_id: `eq.${businessId}`, event_id: 'is.null' },
      { select: 'created_at,expires_at', order: 'created_at.desc', limit: 10, useService: true });
    const liveToday = (recent || []).some((p) =>
      String(p?.created_at || '').slice(0, 10) === todayIl
      && (!p.expires_at || Date.parse(p.expires_at) > now.getTime()));
    if (liveToday) {
      return res.status(409).json({ error: 'כבר יש פלייליסטים להיום' });
    }

    const plan = mode === 'option1'
      ? await planOption1({ businessId, hours, now, onDemand: true })
      : await planOption2({ businessId, hours, now, onDemand: true });
    if (!plan.directions.length) {
      return res.status(400).json({ error: NOTHING_TO_BUILD[plan.reason] || 'אין מה לבנות כרגע' });
    }

    // ---- streaming phase: ndjson ----
    res.setHeader('Content-Type',      'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); };

    const slots = plan.directions.map((d, i) => ({ key: `slot-${i}`, direction: d }));
    send({
      type: 'plan',
      directions: slots.map((s) => ({ direction_id: s.key, title: s.direction.title_en || 'פלייליסט' })),
    });

    const origin = selfOrigin(req);
    let builtCount = 0;
    let failedCount = 0;

    for (let i = 0; i < slots.length; i++) {
      if (i > 0) await sleep(INTER_PLAYLIST_STAGGER_MS);
      const { key, direction } = slots[i];
      try {
        const result = await buildOneDailyPlaylist({
          origin,
          ownerId:   user.id,
          businessId,
          direction,                  // id:null → row.direction_id null (FK)
          target:    plan.target,
          bizName:   bizName || '',
          expiryIso: plan.expiryIso,
        });
        if (result.skipped) {
          failedCount++;
          send({ type: 'failed', direction_id: key, error: result.reason || 'no tracks matched' });
          continue;
        }
        // Per-track genre record (v7), then the permanent business_playlists row.
        await attachTrackGenres(result.row);
        try {
          await insertPlaylistRows([result.row]);
        } catch (e) {
          // The Spotify playlist exists (and is in the expiry ledger); only the
          // dashboard row failed. Report it and keep going.
          console.error(`[v7 generate-daily] business_playlists INSERT failed for ${result.row.spotify_id}:`, e.message);
          failedCount++;
          send({ type: 'failed', direction_id: key, error: `db insert failed: ${e.message}` });
          continue;
        }
        builtCount++;
        send({ type: 'built', direction_id: key, row: result.row });
      } catch (e) {
        console.error(`[v7 generate-daily] "${direction.title_en}" build threw:`, e.message);
        failedCount++;
        send({ type: 'failed', direction_id: key, error: e.message || 'unknown error' });
      }
    }

    send({ type: 'done', built: builtCount, failed: failedCount });
    console.log(`[v7 generate-daily] user=${user.id} biz=${businessId} mode=${mode} built ${builtCount}/${slots.length} (target=${plan.target}, expires=${plan.expiryIso})`);
    res.end();
  } catch (err) {
    console.error('[v7 generate-daily] failed:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
    try { res.write(JSON.stringify({ type: 'done', built: 0, failed: 0, error: err.message }) + '\n'); } catch {}
    try { res.end(); } catch {}
  }
}
