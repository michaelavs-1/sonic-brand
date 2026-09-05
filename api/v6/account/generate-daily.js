/* /api/v6/account/generate-daily.js
   User-triggered daily-playlist builder. Called by the account dashboard's
   "המקום פתוח?" flow (closed day) AND the "צור פלייליסטים" body-link on the
   normal-day empty state (added 2026-09-02). Reuses each business's active
   direction set to build ONE Spotify playlist per direction.

   ─────────────────────────────────────────────────────────────────────────
   Streaming (2026-09-03 rewrite):

   Previously this endpoint buffered all N builds and returned one JSON blob
   at the end (~2min for a 5-direction business, ~5min at the timeout ceiling).
   Now it streams newline-delimited JSON as each direction finishes, so the
   owner sees their first playlist appear in ~15s and can open it while the
   rest are still building. Total wall-clock is unchanged (the 3s inter-
   playlist stagger is non-negotiable — see _daily-builder.js on the 2026-08-22
   Spotify rate-limit lesson), but perceived wait collapses.

   Stream contract:

       {"type":"plan","directions":[{"direction_id":"...","title":"..."}, ...]}
       {"type":"built","direction_id":"...","row":{...business_playlists row...}}
       {"type":"failed","direction_id":"...","error":"..."}
       ...
       {"type":"done","built":3,"failed":0}

   The `plan` line is emitted BEFORE any building so the client can render
   ordered placeholder rows immediately. `built` / `failed` lines come one at
   a time as each direction completes. `done` marks the end of the stream.

   ─────────────────────────────────────────────────────────────────────────
   Build order (2026-09-03):

   Directions are ordered by TOTAL click count DESC — sum of
   business_playlist_opens rows across every historical playlist that shared
   the direction_id. A direction whose playlists have been opened many times
   in the past builds first, so the owner's most-used music surfaces at the
   top of the dashboard fastest. Tie-breaks: rank ASC (R1 ranking), then
   created_at DESC. Same order is used by renderPlaylists on the home tab
   (see loadDashboardData + sortPlaylistsByClicksDesc in v6/account/app.js).

   The auto daily-gen cron (/api/cron/generate-daily) still uses rank order
   via buildDailyBatch — it processes many businesses at once and no user is
   watching, so build order is UX-neutral there.

   Response modes:
   - Streaming ndjson on the happy path (auth + biz OK + directions present).
   - Plain JSON 4xx/5xx on pre-flight failures (missing biz, no directions,
     Supabase down at startup) — cheaper for the client to handle.
*/

import { pgrSelect, pgrInsert } from '../../v5/supabase-client.js';
import { buildOneDailyPlaylist } from './_daily-builder.js';
import { closedDayTargetTracks, dailyPlaylistExpiryIso, nextIl4amIso } from '../../../v6/generation/playlist-length.js';
import { requireBusinessOwner } from './_require-business-owner.js';
import { setCors } from '../origin-guard.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Matches _daily-builder.js's BUILD_STAGGER_MS. Duplicated here rather than
// imported because we're inlining the per-direction loop instead of calling
// buildDailyBatch, so the shared constant isn't accessible without exporting
// it (and giving external code stagger control feels wrong).
const INTER_PLAYLIST_STAGGER_MS = 3000;

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

// Build a { directionId → totalOpens } map by joining business_playlist_opens
// through business_playlists (spotify_id → direction_id). Directions with
// zero historical opens simply don't appear in the map — callers fall back
// to a 0 default when looking up. Small per-biz data set; aggregating in
// JS is cheaper than a Postgres RPC + easier to keep in sync with the
// client's mirror of the same logic.
async function loadClickCountsByDirection(businessId) {
  const [playlists, opens] = await Promise.all([
    pgrSelect('business_playlists',
      { business_id: `eq.${businessId}` },
      { select: 'spotify_id,direction_id', useService: true }),
    pgrSelect('business_playlist_opens',
      { business_id: `eq.${businessId}` },
      { select: 'spotify_id', useService: true }),
  ]);
  const dirBySpotify = new Map();
  for (const p of playlists || []) {
    if (p.spotify_id && p.direction_id) dirBySpotify.set(p.spotify_id, p.direction_id);
  }
  const counts = new Map();
  for (const o of opens || []) {
    const dirId = dirBySpotify.get(o.spotify_id);
    if (!dirId) continue; // orphan open (playlist lost its direction_id, or opens predate the migration)
    counts.set(dirId, (counts.get(dirId) || 0) + 1);
  }
  return counts;
}

// Sort by click count DESC, then rank ASC (nulls last), then created_at DESC.
// The rank tiebreak preserves R1's original "most fit for this business"
// ordering for directions with no click history yet (freshly-onboarded).
function sortDirectionsByClicksDesc(directions, clickCounts) {
  return [...directions].sort((a, b) => {
    const ca = clickCounts.get(a.id) || 0;
    const cb = clickCounts.get(b.id) || 0;
    if (cb !== ca) return cb - ca;
    const ra = Number.isFinite(a.rank) ? a.rank : Number.POSITIVE_INFINITY;
    const rb = Number.isFinite(b.rank) ? b.rank : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
}

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

    const { businessId, bizName, targetTracks } = req.body || {};
    if (!businessId) return res.status(400).json({ error: 'businessId required' });

    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Default target = closed-day sizing (12h + 1h buffer). Callers may
    // override — future user-triggered "make me a longer one" flow would
    // pass a specific targetTracks value.
    const target = Number.isFinite(targetTracks) && targetTracks > 0
      ? Math.min(Math.round(targetTracks), 500)
      : closedDayTargetTracks();

    // Load directions + hours + click history in parallel. All three feed
    // into the streaming loop; failing any of them at pre-flight is
    // cleaner than partially streaming and then erroring out.
    const [dirRows, hoursRows, clickCounts] = await Promise.all([
      pgrSelect('business_directions',
        { business_id: `eq.${businessId}`, active: 'is.true' },
        { select: 'id,rank,title_en,description_he,genres,bpm_range,instrumentalness_preference,popularity_preference,created_at',
          useService: true }),
      pgrSelect('business_hours',
        { business_id: `eq.${businessId}` },
        { select: 'hours', limit: 1, useService: true }),
      loadClickCountsByDirection(businessId),
    ]);

    if (!dirRows?.length) {
      return res.status(400).json({ error: 'לא נמצאו כיוונים מוסיקליים לבניית פלייליסטים' });
    }

    const hours     = hoursRows?.[0]?.hours || null;
    // dailyPlaylistExpiryIso returns null on missing/malformed hours OR on a
    // day the venue is closed — both cases fall through to next-04:00-IL,
    // matching the manual closed-day flow's original expiry semantics.
    const expiryIso = dailyPlaylistExpiryIso({ hours }) || nextIl4amIso();

    const ordered   = sortDirectionsByClicksDesc(dirRows, clickCounts);

    // ---- streaming phase: ndjson ----
    // Once we start writing to the response we can't switch back to a JSON
    // error. Errors from here on go out as `{type:'failed',...}` per-line
    // OR a final `{type:'done',...}` with a nonzero `failed` count.
    res.setHeader('Content-Type',      'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    // Vercel / CDN buffering hint — must ship each line as it's written.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); };

    // Plan line: tell the client the ordered set of directions BEFORE we
    // start building, so it can lay out placeholder rows in the same order
    // the results will arrive in.
    send({
      type: 'plan',
      directions: ordered.map((d) => ({
        direction_id: d.id,
        title:        d.title_en || 'פלייליסט',
      })),
    });

    const origin = selfOrigin(req);
    let builtCount  = 0;
    let failedCount = 0;

    for (let i = 0; i < ordered.length; i++) {
      if (i > 0) await sleep(INTER_PLAYLIST_STAGGER_MS);
      const direction = ordered[i];
      try {
        const result = await buildOneDailyPlaylist({
          origin,
          ownerId:    user.id,
          businessId,
          direction:  {
            id:                          direction.id,
            title_en:                    direction.title_en,
            description_he:              direction.description_he,
            genres:                      direction.genres,
            bpm_range:                   direction.bpm_range,
            instrumentalness_preference: direction.instrumentalness_preference || 'none',
            popularity_preference:       direction.popularity_preference       || 'none',
          },
          target,
          bizName:    bizName || '',
          expiryIso,
        });
        if (result.skipped) {
          failedCount++;
          send({ type: 'failed', direction_id: direction.id, error: result.reason || 'no tracks matched' });
          continue;
        }
        // INSERT per-playlist (vs. batch INSERT at the end) so the client's
        // next dashboard reload picks up the row even mid-stream. Also means
        // a mid-stream Vercel timeout leaves the already-built rows
        // persisted — the client would reload and see them.
        try {
          await pgrInsert('business_playlists', result.row, { ignoreDuplicates: true });
        } catch (e) {
          // Persist failure ≠ build failure. The Spotify playlist exists on
          // Rubin's account (and is in the ledger for the expire cron). Log
          // loudly, tell the client, keep going.
          console.error(`[generate-daily] business_playlists INSERT failed for ${result.row.spotify_id}:`, e.message);
          failedCount++;
          send({ type: 'failed', direction_id: direction.id, error: `db insert failed: ${e.message}` });
          continue;
        }
        builtCount++;
        send({ type: 'built', direction_id: direction.id, row: result.row });
      } catch (e) {
        console.error(`[generate-daily] "${direction.title_en}" build threw:`, e.message);
        failedCount++;
        send({ type: 'failed', direction_id: direction.id, error: e.message || 'unknown error' });
      }
    }

    send({ type: 'done', built: builtCount, failed: failedCount });
    console.log(`[generate-daily] user=${user.id} biz=${businessId} built ${builtCount}/${ordered.length} playlists (target=${target}, streaming)`);
    res.end();
  } catch (err) {
    // Pre-streaming errors → JSON error response. Post-streaming errors
    // (should be caught inside the loop) fall through here; try to append
    // a synthetic 'done' line before ending so the client's reader loop
    // terminates cleanly.
    console.error('[generate-daily] failed:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
    try { res.write(JSON.stringify({ type: 'done', built: 0, failed: 0, error: err.message }) + '\n'); } catch {}
    try { res.end(); } catch {}
  }
}
