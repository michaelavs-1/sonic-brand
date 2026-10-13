/* /api/v7/account/generate-daily.js
   Owner-triggered daily-playlist build for v7 businesses:
     - fired automatically right after the first-login type gate,
     - the dashboard's "צור פלייליסטים" (empty open day) / "המקום פתוח?" (closed
       day) links,
     - "החליפו עכשיו" after a timeline change or a type switch in the Profile tab
       (`replaceToday: true`),
     - "צור פלייליסטים עכשיו" before opening (`openNow: true`, 2026-10-06): the
       build acts as though today opens now (hoursOpeningNow) — instead of the
       cron's build before opening.

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
     - Only while today has live daily playlists and the venue hasn't closed yet
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

   The build itself lives in ./_run-daily-build.js since 2026-10-13, shared
   with the admin console's "rebuild today" (api/internal/daily-picks.js).
   This file is the owner's door to it: rate limit, JWT, ownership.
*/

import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { verifyUser } from './_settings-helpers.js';
import { runDailyBuild } from './_run-daily-build.js';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-generate-daily', 12, 3600)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, bizName, replaceToday = false, openNow = false } = req.body || {};
    if (!businessId) return res.status(400).json({ error: 'businessId required' });

    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // The build itself (incl. the subscription check, the build lock, the
    // replace rules and the build log) is shared with the admin console:
    // ./_run-daily-build.js.
    const result = await runDailyBuild({
      businessId, ownerId: user.id, bizName: bizName || '', replaceToday, openNow, origin: selfOrigin(req),
    }, {
      beforeStream: () => {
        res.setHeader('Content-Type',      'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control',     'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
      },
      send: (obj) => { res.write(JSON.stringify(obj) + '\n'); },
    });
    if (result.status) return res.status(result.status).json(result.body);
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
