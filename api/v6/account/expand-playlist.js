/* /api/v6/account/expand-playlist.js
   Grows an onboarding-generated playlist from its initial ~10-track "sample"
   size to a full day's length in the background. The client (v6/account/app.js)
   sizes `targetCount` to today's opening hours + 1h buffer via
   v6/generation/playlist-length.js; the ~120-track default here is only used
   if the client omits it.

   Called by v6/account/app.js after the dashboard renders. The endpoint
   streams progress back as newline-delimited JSON so the client can show the
   track count climbing live:

       {"trackCount": 40}
       {"trackCount": 70}
       {"trackCount": 100}
       {"trackCount": 120, "done": true}

   Request body:
     {
       businessId:    string,
       playlistId:    string  // Spotify playlist id (matches business_playlists.spotify_id)
       targetCount?:  number  // default 120 (~7 hours at 3.5min/track); capped at 500
     }

   Idempotency:
     - If business_playlists.expanded_at is already set, we short-circuit.
     - Otherwise we read the row's `expansion` field ({direction, popularityWindow})
       to know what to fetch, request enough NEW tracks to fill the gap, and
       add them to Spotify. Intermediate progress is streamed but only the
       final `track_count + expanded_at` update is committed — if the tab
       closes mid-stream the next dashboard load will just re-run.

   Storage: reads/writes go against business_playlists (PK = spotify_id) via
   pgrPatch. No more read-modify-write on user_metadata — a single row-level
   UPDATE replaces the whole re-read-and-splice dance.
*/

import { pgrSelect, pgrPatch, pgrUpsert } from '../../v5/supabase-client.js';
import { dailyPlaylistExpiryIso, nextIl4amIso } from '../../../v6/generation/playlist-length.js';
import { fetchTracksWithHistory, recordTrackHistory } from './_daily-builder.js';
import { requireBusinessOwner } from './_require-business-owner.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY || '';

// Default target = ~120 tracks (~7 hours at 3.5 min/track avg).
const DEFAULT_TARGET   = 120;
// Spotify's add_tracks cap is 100 URIs per call. Add in smaller chunks so
// the progress ticks are visible and each chunk stays well under the cap.
const SPOTIFY_CHUNK    = 50;

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

async function fetchBusinessHours(businessId) {
  try {
    const rows = await pgrSelect('business_hours',
      { business_id: `eq.${businessId}` },
      { select: 'hours', limit: 1, useService: true },
    );
    return rows?.[0]?.hours || null;
  } catch (e) {
    console.warn('[expand-playlist] business_hours read failed:', e.message);
    return null;
  }
}

async function addTracksToSpotify(origin, playlistId, uris) {
  const r = await fetch(`${origin}/api/new/spotify`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-sonic-internal': INTERNAL_API_KEY,
    },
    body: JSON.stringify({
      action:      'add_tracks',
      playlist_id: playlistId,
      uris,
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d?.error?.message || d?.error || `add_tracks ${r.status}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // -- pre-flight: JSON responses --
  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, playlistId, targetCount } = req.body || {};
    if (!businessId || !playlistId) {
      return res.status(400).json({ error: 'businessId and playlistId required' });
    }
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }
    const target = Number.isFinite(targetCount) && targetCount > 0
      ? Math.min(Math.round(targetCount), 500)
      : DEFAULT_TARGET;

    // Locate the playlist row in business_playlists (PK = spotify_id).
    // Scoping the query by business_id defends against cross-tenant
    // playlist-id guessing on top of the requireBusinessOwner check.
    //
    // useService: true — business_playlists RLS keys on auth.uid(), which
    // is null when the anon-key path (default) sends no user JWT.
    // requireBusinessOwner above already established the caller owns this
    // business, so bypassing RLS here is safe.
    let rowRes;
    try {
      rowRes = await pgrSelect('business_playlists',
        { spotify_id: `eq.${playlistId}`, business_id: `eq.${businessId}` },
        { select: 'spotify_id,track_count,expansion,expanded_at,label,direction_id,track_ids', limit: 1, useService: true },
      );
    } catch (e) {
      return res.status(500).json({ error: `business_playlists read failed: ${e.message}` });
    }
    const row = rowRes?.[0];
    if (!row) {
      return res.status(404).json({ error: 'playlist not found' });
    }

    // Idempotency: if already expanded, short-circuit.
    if (row.expanded_at) {
      return res.status(200).json({
        ok:              true,
        trackCount:      row.track_count || 0,
        done:            true,
        alreadyExpanded: true,
      });
    }

    // Direction lookup: prefer the canonical row in business_directions via
    // direction_id (the source of truth going forward). Fall back to the
    // legacy expansion.direction blob for pre-migration playlist rows that
    // have direction_id = NULL. Either source yields the same downstream
    // shape (title_en, genres, bpm_range, etc.) that fetchTracksWithHistory
    // and playlistName need.
    let dir = null;
    if (row.direction_id) {
      try {
        const dirRes = await pgrSelect('business_directions',
          { id: `eq.${row.direction_id}` },
          { select: 'id,title_en,description_he,genres,bpm_range,popularity_window',
            limit: 1, useService: true },
        );
        dir = dirRes?.[0] || null;
      } catch (e) {
        console.warn('[expand-playlist] business_directions read failed:', e.message);
      }
    }
    if (!dir) dir = row.expansion?.direction || null;
    const hasGenres = dir && (
      (Array.isArray(dir.genres) && dir.genres.length)
      || (typeof dir.anchor_genre === 'string' && dir.anchor_genre.length)
    );
    if (!hasGenres || !dir?.bpm_range) {
      return res.status(400).json({ error: 'playlist row has no direction metadata (built pre-feature)' });
    }

    // Compute the target expiry once — reused by both the short-circuit
    // "no work needed" path and the final commit at the end of streaming.
    const hoursForExpiry = await fetchBusinessHours(businessId);
    const expiryIso      = dailyPlaylistExpiryIso({ hours: hoursForExpiry }) || nextIl4amIso();

    const current = Number.isFinite(row.track_count) ? row.track_count : 0;
    const need    = Math.max(0, target - current);
    if (need <= 0) {
      // Already at or above target — mark expanded so we don't retry.
      await pgrPatch('business_playlists', { spotify_id: `eq.${playlistId}` }, {
        expanded_at: new Date().toISOString(),
        expires_at:  expiryIso,
      });
      return res.status(200).json({ ok: true, trackCount: current, done: true });
    }

    // Fetch a pool of `need` fresh candidate IDs via the history-aware
    // helper. Since this is the onboarding-day expansion, the history is
    // usually empty (no prior serves for this biz+direction) so exclusion
    // is a no-op on day 1. But if the user reonboards or re-triggers
    // expansion, the helper avoids repeating recent tracks. The helper's
    // internal pool-shortage fallback fills any gap for narrow directions.
    // popularity_window preference: business_directions column (canonical
     // per-direction snapshot) → legacy expansion.popularityWindow fallback.
    const popularityWindow = dir.popularity_window
      || row.expansion?.popularityWindow
      || null;
    const { ids: newIds, directionKey: dKey } = await fetchTracksWithHistory({
      businessId,
      direction:        dir,
      popularityWindow,
      target:           need,
    });
    if (!newIds.length) {
      // DB has nothing more for this direction. Mark expanded so we don't
      // retry on every dashboard load.
      await pgrPatch('business_playlists', { spotify_id: `eq.${playlistId}` }, {
        expanded_at: new Date().toISOString(),
        expires_at:  expiryIso,
      });
      return res.status(200).json({ ok: true, trackCount: current, done: true, exhausted: true });
    }

    // -- streaming phase: ndjson --
    // Once we start streaming we can't switch back to a JSON error response.
    // Errors from here on get sent as an ndjson line with an `error` field
    // and the connection closes.
    res.setHeader('Content-Type',      'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    // Tell Vercel/CDN not to buffer the stream — progress lines must land
    // on the client as they're written.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj) => {
      res.write(JSON.stringify(obj) + '\n');
    };

    const origin = selfOrigin(req);
    let running  = current;
    const addedIds = [];
    try {
      for (let i = 0; i < newIds.length; i += SPOTIFY_CHUNK) {
        const chunk = newIds.slice(i, i + SPOTIFY_CHUNK);
        const uris  = chunk.map((id) => `spotify:track:${id}`);
        await addTracksToSpotify(origin, playlistId, uris);
        addedIds.push(...chunk);
        running += chunk.length;
        send({ trackCount: running });
      }
    } catch (err) {
      console.error('[expand-playlist] add_tracks failed:', err.message);
      send({ error: err.message || 'add_tracks failed', trackCount: running });
      res.end();
      return;
    }

    // Record served tracks in v6_daily_track_history so tomorrow's daily-gen
    // cron dedups against them. Only IDs whose chunk actually succeeded are
    // recorded (addedIds accumulates as we go). Non-fatal on failure.
    await recordTrackHistory({ businessId, directionKey: dKey, spotifyIds: addedIds });

    // Persist final state so future dashboard loads see this playlist as
    // expanded and skip re-running. Row-level UPDATE — race-free by
    // definition, unlike the old user_metadata read-modify-write.
    //
    // Also stamps expires_at on both the row (drives dashboard visibility)
    // and the ledger row (drives the expire cron's Spotify unfollow). If
    // today is open we get "close+2h in IL" from the helper. If today is
    // closed (onboarding on a closed day) the helper returned null earlier
    // and we fell back to "next 04:00 IL" — matches the closed-day manual
    // flow and guarantees expires_at is always populated.
    try {
      // track_ids: append the freshly-added IDs to whatever was already
      // on the row (~10 initial IDs from the signup sample, or NULL for
      // pre-migration rows). Merged JS-side because PostgREST doesn't
      // expose an atomic jsonb || $ append; concurrent expansions of the
      // same playlist row aren't a real concern (idempotency gate above).
      const priorIds = Array.isArray(row.track_ids) ? row.track_ids : [];
      const mergedTrackIds = [...priorIds, ...addedIds];
      await pgrPatch('business_playlists', { spotify_id: `eq.${playlistId}` }, {
        track_count: running,
        expanded_at: new Date().toISOString(),
        expires_at:  expiryIso,
        track_ids:   mergedTrackIds,
      });

      // Overwrite the ledger row so the expire cron unfollows at the same
      // moment the dashboard hides the row. Best-effort: a ledger write
      // failure just leaves it at whatever record-playlist.js wrote.
      try {
        await pgrUpsert('created_playlists', {
          spotify_id:  playlistId,
          name:        row.label || 'playlist',
          expires_at:  expiryIso,
          deleted_at:  null,
          error:       null,
          owner_id:    user.id,
          business_id: businessId,
        }, { onConflict: 'spotify_id' });
      } catch (e) {
        console.warn('[expand-playlist] ledger expiry rewrite failed:', e.message);
      }
    } catch (err) {
      console.warn('[expand-playlist] final business_playlists UPDATE failed:', err.message);
      send({ error: 'commit failed', trackCount: running });
      res.end();
      return;
    }

    send({ trackCount: running, done: true });
    res.end();
    console.log(`[expand-playlist] user=${user.id} playlist=${playlistId} ${current}→${running} tracks`);
  } catch (err) {
    // Pre-streaming errors — safe to send a JSON error response.
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
    // Post-streaming errors that escaped the inner try (rare).
    try { res.write(JSON.stringify({ error: err.message || 'Server error' }) + '\n'); } catch {}
    try { res.end(); } catch {}
    console.error('[expand-playlist] outer failure:', err.message);
  }
}
