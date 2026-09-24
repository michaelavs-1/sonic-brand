/* /api/v7/account/generate-daily.js
   Owner-triggered daily-playlist build for v7 businesses:
     - fired automatically right after the first-login type gate,
     - the dashboard's "צור פלייליסטים" (empty open day) / "המקום פתוח?" (closed
       day) links,
     - "החליפו עכשיו" after a timeline change or a type switch in the Profile tab
       (`replaceToday: true`).

   Builds exactly what the v7 cron would build today, branching on the
   business's delivery mode:
     option1 → 4 playlists from business_v7_directions (2 high + 2 low energy)
               — planOption1 in ./_daily-builder.js
     option2 → 2 mixes following the owner's energy timeline, placed by track
               duration — planOption2Timeline in ./_option2-builder.js (falls
               back to the naive planOption2 if the pool RPC isn't deployed).
               Built after opening → starts at the build time.

   Streams the SAME ndjson contract as v6's endpoint, so the dashboard's
   runGenerateDaily renderer works unchanged:

       {"type":"plan","directions":[{"direction_id":"slot-0","title":"..."}, ...]}
       {"type":"built","direction_id":"slot-0","row":{...business_playlists row...}}
       {"type":"replaced","spotify_ids":["..."]}          (replaceToday only)
       {"type":"failed","direction_id":"slot-1","error":"..."}
       {"type":"done","built":3,"failed":1}

   `direction_id` in the stream only pairs placeholders with results
   ("slot-N"). Persisted rows carry direction_id:null (FK → v6 table).

   Replace today (`replaceToday: true`, Roni 2026-09-24):
     - Only while today has live daily playlists and closing is ≥ 30 min away
       (409 code 'past-close' / 'nothing-to-replace'); at most REPLACE_CAP per
       business day (429 code 'replace-cap').
     - The new set is built first. Each old playlist leaves the dashboard as
       soon as its replacement lands (same name → hide the old one); on a type
       switch (names differ) all old ones leave after the first new playlist
       lands. "Leave" = business_playlists.expires_at = now ONLY — the expiry
       ledger keeps the original close+2h, so a phone still playing an old
       playlist doesn't go silent at the next :30 cleanup.
     - If nothing builds (e.g. Spotify paused), nothing is hidden and the
       replacement isn't counted.

   One build at a time per business (_build-lock.js → 409 'build-in-progress').
   One playlist at a time with a 3s stagger (Spotify rate-limit lesson,
   2026-08-22); INSERT per playlist so rows persist even if the stream is cut.
   Pre-flight failures return plain JSON 4xx/5xx with { error, code? }.
*/

import { pgrSelect, pgrPatch } from '../../v5/supabase-client.js';
import { buildOneDailyPlaylist } from '../../v6/account/_daily-builder.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { planOption1, planOption2, attachTrackGenres, insertPlaylistRows } from './_daily-builder.js';
import { planOption2Timeline, createTimelineMix } from './_option2-builder.js';
import { replaceStatus, liveDailyRows, businessDaySinceIso, REPLACE_FIELD } from './_replace-status.js';
import { acquireBuildLock } from './_build-lock.js';
import { verifyUser, auditSetting } from './_settings-helpers.js';
import { businessWindowAt } from '../../../v7/generation/energy-timeline.js';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTER_PLAYLIST_STAGGER_MS = 3000;   // same as _daily-builder.js BUILD_STAGGER_MS

const NOTHING_TO_BUILD = {
  'no-directions':          'הכיוונים המוזיקליים עדיין לא הוכנו — בחרו שוב באפשרות הראשונה בפרופיל',
  'no-approved-genres':     'לא נמצא פרופיל מוזיקלי לבניית פלייליסטים',
  'directions-read-failed': 'שגיאה בטעינת הכיוונים המוזיקליים — נסו שוב',
  'past-close':             'היום כבר כמעט נגמר — הפלייליסטים הבאים ייבנו מחר',
  'closed-today':           'המקום סגור היום',
};

const CODE_MESSAGES = {
  'build-in-progress':  'כבר נבנים פלייליסטים — נסו שוב בעוד רגע',
  'replace-cap':        'הגעתם למקסימום של 2 החלפות ביום — השינוי ייכנס לתוקף מחר',
  'past-close':         'היום כבר כמעט נגמר — השינוי ייכנס לתוקף מחר',
  'closed-today':       'המקום סגור היום — השינוי ייכנס לתוקף ביום הפתיחה הבא',
  'nothing-to-replace': 'אין פלייליסטים להיום להחלפה',
};

function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Today's slots as { key, title, build() → {skipped, reason?, row?} }.
async function planSlots({ mode, businessId, hours, now, replaceToday, origin, ownerId, bizName }) {
  if (mode === 'option2') {
    const plan = await planOption2Timeline({ businessId, hours, now, onDemand: true });
    if (!plan.fallback) {
      if (!plan.slots.length) return { slots: [], reason: plan.reason };
      return {
        reason: null,
        slots: plan.slots.map((s) => ({
          key: s.key,
          title: s.title,
          build: () => createTimelineMix({
            origin, ownerId, businessId, bizName, title: s.title, tracks: s.tracks, expiryIso: plan.expiryIso, meta: plan.meta,
          }),
        })),
      };
    }
  }
  const plan = mode === 'option1'
    ? await planOption1({ businessId, hours, now, onDemand: true, fromNow: replaceToday })
    : await planOption2({ businessId, hours, now, onDemand: true });   // naive fallback
  if (!plan.directions.length) return { slots: [], reason: plan.reason };
  return {
    reason: null,
    slots: plan.directions.map((direction, i) => ({
      key: `slot-${i}`,
      title: direction.title_en || 'פלייליסט',
      build: async () => {
        const r = await buildOneDailyPlaylist({
          origin, ownerId, businessId, direction, target: plan.target, bizName, expiryIso: plan.expiryIso,
        });
        if (!r.skipped) await attachTrackGenres(r.row);
        return r;
      },
    })),
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-generate-daily', 12, 3600)) return;

  let lock = null;
  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, bizName, replaceToday = false } = req.body || {};
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

    lock = await acquireBuildLock(businessId);
    if (!lock.acquired) {
      return res.status(409).json({ error: CODE_MESSAGES['build-in-progress'], code: 'build-in-progress' });
    }

    const now = new Date();
    const w = businessWindowAt(hours, now);
    let oldRows = [];
    if (replaceToday) {
      const status = await replaceStatus({ businessId, hours, now });
      if (!status.eligible) {
        const code = status.reason === 'no-live-playlists' ? 'nothing-to-replace' : status.reason;
        return res.status(409).json({ error: CODE_MESSAGES[code] || CODE_MESSAGES['past-close'], code });
      }
      if (status.left <= 0) {
        return res.status(429).json({ error: CODE_MESSAGES['replace-cap'], code: 'replace-cap' });
      }
      oldRows = await liveDailyRows(businessId, businessDaySinceIso(w), now);
    } else {
      // One live set per business day (this endpoint also fires automatically
      // right after the first-login gate — guard a reload-and-click double).
      // Live rows only: once today's set has expired, the owner may still
      // build a fresh one.
      const live = await liveDailyRows(businessId, businessDaySinceIso(w), now);
      if (live.length) return res.status(409).json({ error: 'כבר יש פלייליסטים להיום', code: 'already-built' });
    }

    const origin = selfOrigin(req);
    const { slots, reason } = await planSlots({
      mode, businessId, hours, now, replaceToday, origin, ownerId: user.id, bizName: bizName || '',
    });
    if (!slots.length) {
      return res.status(400).json({ error: NOTHING_TO_BUILD[reason] || 'אין מה לבנות כרגע', code: reason || undefined });
    }

    // ---- streaming phase: ndjson ----
    res.setHeader('Content-Type',      'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); };

    send({ type: 'plan', directions: slots.map((s) => ({ direction_id: s.key, title: s.title })) });

    const plannedTitles = new Set(slots.map((s) => s.title));
    const pendingOld = new Map(oldRows.map((r) => [r.spotify_id, r]));
    const hideOld = async (rows) => {
      if (!rows.length) return;
      const nowIso = new Date().toISOString();
      const hidden = [];
      for (const r of rows) {
        try {
          await pgrPatch('business_playlists',
            { spotify_id: `eq.${r.spotify_id}`, business_id: `eq.${businessId}` }, { expires_at: nowIso });
          hidden.push(r.spotify_id);
        } catch (e) {
          console.warn(`[v7 generate-daily] hiding old playlist ${r.spotify_id} failed:`, e.message);
        }
        pendingOld.delete(r.spotify_id);
      }
      if (hidden.length) send({ type: 'replaced', spotify_ids: hidden });
    };

    let builtCount = 0;
    let failedCount = 0;
    const newRows = [];
    for (let i = 0; i < slots.length; i++) {
      if (i > 0) await sleep(INTER_PLAYLIST_STAGGER_MS);
      const slot = slots[i];
      try {
        const result = await slot.build();
        if (result.skipped) {
          failedCount++;
          send({ type: 'failed', direction_id: slot.key, error: result.reason || 'no tracks matched' });
          continue;
        }
        try {
          await insertPlaylistRows([result.row]);
        } catch (e) {
          // The Spotify playlist exists (and is in the expiry ledger); only the
          // dashboard row failed. Report it and keep going.
          console.error(`[v7 generate-daily] business_playlists INSERT failed for ${result.row.spotify_id}:`, e.message);
          failedCount++;
          send({ type: 'failed', direction_id: slot.key, error: `db insert failed: ${e.message}` });
          continue;
        }
        builtCount++;
        newRows.push({ spotify_id: result.row.spotify_id, label: result.row.label });
        send({ type: 'built', direction_id: slot.key, row: result.row });

        if (replaceToday) {
          if (builtCount === 1) {
            // Counts toward today's cap only once something was actually built.
            await auditSetting(businessId, REPLACE_FIELD,
              { mode, playlists: oldRows.map((r) => ({ spotify_id: r.spotify_id, label: r.label })) },
              { mode, titles: [...plannedTitles] });
            // Type switch: old names don't match the new ones → all go now.
            await hideOld([...pendingOld.values()].filter((r) => !plannedTitles.has(r.label)));
          }
          await hideOld([...pendingOld.values()].filter((r) => r.label === slot.title));
        }
      } catch (e) {
        console.error(`[v7 generate-daily] "${slot.title}" build threw:`, e.message);
        failedCount++;
        send({ type: 'failed', direction_id: slot.key, error: e.message || 'unknown error' });
      }
    }

    send({ type: 'done', built: builtCount, failed: failedCount });
    console.log(`[v7 generate-daily] user=${user.id} biz=${businessId} mode=${mode}${replaceToday ? ' REPLACE' : ''} built ${builtCount}/${slots.length}`);
    res.end();
  } catch (err) {
    console.error('[v7 generate-daily] failed:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
    try { res.write(JSON.stringify({ type: 'done', built: 0, failed: 0, error: err.message }) + '\n'); } catch {}
    try { res.end(); } catch {}
  } finally {
    try { await lock?.release(); } catch {}
  }
}
