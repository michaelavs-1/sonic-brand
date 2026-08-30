/* GET /api/internal/business?id=<business_uuid>
   Admin detail view for one business: everything Michael's dashboard needs
   to show the full onboarding prompt + the resulting directions +
   playlists (with their track spotify_ids).

   Auth: bearer token in `Authorization: Bearer <INTERNAL_ADMIN_API_KEY>` (see
   ./_guard.js). CORS: `*` — the bearer token IS the boundary.

   Response shape:
     {
       business: {
         id, name, owner_id, owner_email, created_at,
         onboarding_expanded, monthly_credits, credits_remaining
       },
       onboarding: {
         business_description: string | null,
         musical_emphases:     string | null,
         atmospheres:          string[]         // from user_metadata
       },
       place:             <business_place row>  | null,
       hours:             <business_hours row>  | null,
       directions:        <business_directions[]>,   // both active + inactive
       playlists:         <business_playlists[]>,    // all rows (live + expired)
       direction_changes: <business_direction_changes[]>,  // most recent first
       chat_transcript:   <business_direction_chats[]>,    // ascending time
       gemini_spend: {                                     // per-business rollup
         total_usd, call_count,
         by_label: [{ label, usd, calls }]                 //   sorted by usd desc
       },
       gemini_calls:      <gemini_call_log[]>,             // all rows for this
                                                           //   business, newest first
       cleanup_backlog:   <created_playlists[]>            // rows expired but
                                                           //   not yet cleaned
                                                           //   (attempts >= 1),
                                                           //   worst-offender first.
                                                           //   Populated by the
                                                           //   2026-08-29 backoff
                                                           //   migration.
       playlist_opens:    <business_playlist_opens[]>,     // raw click log for
                                                           //   this business,
                                                           //   newest first,
                                                           //   capped at 1000.
       playlist_opens_summary: {
         total,                                            // total click count
         by_playlist: [{ spotify_id, count, last_opened_at }],  // desc by count
         by_source:   [{ source, count }]                  // 'home-daily' /
                                                           //   'home-event'
       }
     }

   All playlist rows carry `track_ids` (array of Spotify track IDs) as
   stored at build time — see the 2026-08-20-business-directions.sql
   migration. Rows created before that migration will have `track_ids:
   null` (unrecoverable from other sources).

   direction_changes and chat_transcript come from the 2026-08-25-direction-
   chat.sql migration. Rows only exist for businesses whose owner has
   used the profile-page direction-edit chat.
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchAuthUser(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) {
    // 404 is a valid "orphaned business" state — return null so the
    // dashboard can render "(owner deleted)" instead of 500-ing.
    if (r.status === 404) return null;
    const t = await r.text().catch(() => '');
    throw new Error(`auth admin user ${userId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => null);
}

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    if (!SERVICE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    }

    const id = String(req.query?.id || '').trim();
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'query param `id` must be a business uuid' });
    }

    const businessRows = await pgrSelect('businesses', { id: `eq.${id}` }, {
      select: 'id,name,owner_id,created_at,business_description,musical_emphases,onboarding_expanded,monthly_credits,credits_remaining',
      useService: true,
    });
    const business = Array.isArray(businessRows) && businessRows[0];
    if (!business) return res.status(404).json({ error: 'business not found' });

    // Fetch the owner + all per-business tables in parallel — no ordering
    // dependency between them.
    const nowIso = new Date().toISOString();
    const [ownerUser, placeRows, hoursRows, directionRows, playlistRows, changeRows, chatRows, geminiRows, cleanupBacklogRows, openRows] = await Promise.all([
      fetchAuthUser(business.owner_id),
      pgrSelect('business_place',      { business_id: `eq.${id}` }, { useService: true }),
      pgrSelect('business_hours',      { business_id: `eq.${id}` }, { useService: true }),
      pgrSelect('business_directions', { business_id: `eq.${id}` }, {
        select: 'id,rank,title_en,description_he,genres,bpm_range,popularity_window,instrumentalness_preference,active,created_at,updated_at',
        order: 'rank.asc.nullslast',
        useService: true,
      }),
      pgrSelect('business_playlists', { business_id: `eq.${id}` }, {
        select: 'spotify_id,url,label,ico,track_count,genres,bpm_range,event_id,direction_id,track_ids,expanded_at,expires_at,created_at',
        order: 'created_at.desc',
        useService: true,
      }),
      pgrSelect('business_direction_changes', { business_id: `eq.${id}` }, {
        select: 'id,kind,direction_id,before,after,playlist_action,message_id_first,message_id_last,applied_at',
        order: 'applied_at.desc',
        useService: true,
      }),
      pgrSelect('business_direction_chats', { business_id: `eq.${id}` }, {
        select: 'id,role,content,proposal,selected_direction_id,created_at',
        order: 'created_at.asc',
        useService: true,
      }),
      pgrSelect('gemini_call_log', { business_id: `eq.${id}` }, {
        select: 'id,created_at,model,label,input_tokens,output_tokens,thinking_tokens,total_tokens,cost_usd,finish_reason,http_status',
        order: 'created_at.desc',
        useService: true,
      }),
      // Cleanup backlog: any created_playlists row for this business that is
      // past-expired, not yet deleted, AND has failed cleanup at least once.
      // Sorted by attempts desc so the worst-offender rows lead. Fresh 0-
      // attempt rows are excluded because they're just "next cron tick will
      // pick them up" — surfacing those as backlog would be noise.
      // Empty array when there's no backlog. Pre-2026-08-29 rows have
      // attempts=0 by default, so a well-behaved business never populates.
      pgrSelect('created_playlists', {
        business_id: `eq.${id}`,
        deleted_at:  'is.null',
        expires_at:  `lte.${nowIso}`,
        attempts:    'gte.1',
      }, {
        select: 'spotify_id,name,expires_at,attempts,last_error,next_attempt_at,alerted_at',
        order: 'attempts.desc',
        limit: 50,
        useService: true,
      }),
      // Playlist-open clicks. Full log for this business, newest first,
      // capped at 1000 (well above pilot-scale volume). Client-side, join
      // on spotify_id against `playlists` to attribute each click to a
      // direction/label/genres.
      pgrSelect('business_playlist_opens', { business_id: `eq.${id}` }, {
        select: 'id,spotify_id,source,opened_at',
        order:  'opened_at.desc',
        limit:  1000,
        useService: true,
      }),
    ]);

    // Roll up this business's Gemini spend from its log rows. Same idea
    // as /api/internal/gemini-spend but scoped to a single business_id
    // — includes any pre-signup onboarding rows that got backfilled at
    // signup time.
    const geminiCalls = Array.isArray(geminiRows) ? geminiRows : [];
    let geminiTotalUsd = 0;
    const geminiByLabel = new Map();
    for (const c of geminiCalls) {
      const cost = Number(c.cost_usd) || 0;
      geminiTotalUsd += cost;
      const lbl = c.label || '(unlabeled)';
      const bucket = geminiByLabel.get(lbl) || { label: lbl, usd: 0, calls: 0 };
      bucket.usd   += cost;
      bucket.calls += 1;
      geminiByLabel.set(lbl, bucket);
    }
    const geminiSpend = {
      total_usd: Number(geminiTotalUsd.toFixed(6)),
      call_count: geminiCalls.length,
      by_label: [...geminiByLabel.values()]
        .sort((a, b) => b.usd - a.usd)
        .map((l) => ({ label: l.label, usd: Number(l.usd.toFixed(6)), calls: l.calls })),
    };

    // Playlist-open rollup: per-playlist click counts and per-source
    // (home-daily / home-event) totals. Dashboard uses this to show
    // "opened N times" on each playlist card without having to sum on
    // the client, and the per-source breakdown separates daily-playlist
    // engagement from event-playlist engagement.
    const playlistOpens = Array.isArray(openRows) ? openRows : [];
    const opensByPlaylist = new Map();
    const opensBySource   = new Map();
    for (const o of playlistOpens) {
      if (o.spotify_id) {
        const b = opensByPlaylist.get(o.spotify_id) || { spotify_id: o.spotify_id, count: 0, last_opened_at: null };
        b.count += 1;
        if (!b.last_opened_at || o.opened_at > b.last_opened_at) b.last_opened_at = o.opened_at;
        opensByPlaylist.set(o.spotify_id, b);
      }
      const src = o.source || '(unspecified)';
      const s = opensBySource.get(src) || { source: src, count: 0 };
      s.count += 1;
      opensBySource.set(src, s);
    }
    const openSummary = {
      total: playlistOpens.length,
      by_playlist: [...opensByPlaylist.values()].sort((a, b) => b.count - a.count),
      by_source:   [...opensBySource.values()].sort((a, b) => b.count - a.count),
    };

    const sonic = ownerUser?.user_metadata?.sonic || {};
    const atmospheres = Array.isArray(sonic?.onboarding?.atmospheres)
      ? sonic.onboarding.atmospheres
      : [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      business: {
        id:                   business.id,
        name:                 business.name || null,
        owner_id:             business.owner_id,
        owner_email:          ownerUser?.email || null,
        created_at:           business.created_at,
        onboarding_expanded:  business.onboarding_expanded,
        monthly_credits:      business.monthly_credits,
        credits_remaining:    business.credits_remaining,
      },
      onboarding: {
        business_description: business.business_description,
        musical_emphases:     business.musical_emphases,
        atmospheres,
      },
      place:              (Array.isArray(placeRows) && placeRows[0]) || null,
      hours:              (Array.isArray(hoursRows) && hoursRows[0]) || null,
      directions:         Array.isArray(directionRows) ? directionRows : [],
      playlists:          Array.isArray(playlistRows)  ? playlistRows  : [],
      direction_changes:  Array.isArray(changeRows)    ? changeRows    : [],
      chat_transcript:    Array.isArray(chatRows)      ? chatRows      : [],
      gemini_spend:       geminiSpend,
      gemini_calls:       geminiCalls,
      cleanup_backlog:    Array.isArray(cleanupBacklogRows) ? cleanupBacklogRows : [],
      playlist_opens:     playlistOpens,
      playlist_opens_summary: openSummary,
    });
  } catch (err) {
    console.error('[internal:business] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
