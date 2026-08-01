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
       playlistId:    string  // Spotify playlist id (matches user_metadata.b[bizId].playlists[i].id)
       targetCount?:  number  // default 120 (~7 hours at 3.5min/track); capped at 500
     }

   Idempotency:
     - If the playlist entry already has `expandedAt` set, we short-circuit.
     - Otherwise we read the entry's `expansion` field ({direction, popularityWindow})
       to know what to fetch, request enough NEW tracks to fill the gap, and
       add them to Spotify. Intermediate progress is streamed but only the
       final `trackCount + expandedAt` is written to user_metadata — if the
       tab closes mid-stream the next dashboard load will just re-run.
*/

import { pgrRpc } from '../../v5/supabase-client.js';

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

function adminHeaders() {
  return {
    apikey:        SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function readUserSonic(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: adminHeaders(),
  });
  if (!r.ok) throw new Error(`read user_metadata failed: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j?.user_metadata?.sonic) || {};
}

async function writeUserSonic(userId, sonic) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method:  'PUT',
    headers: adminHeaders(),
    body:    JSON.stringify({ user_metadata: { sonic } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`user_metadata write failed: ${r.status} ${t.slice(0, 150)}`);
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
    const target = Number.isFinite(targetCount) && targetCount > 0
      ? Math.min(Math.round(targetCount), 500)
      : DEFAULT_TARGET;

    // Locate the playlist entry inside user_metadata.
    const sonic = await readUserSonic(user.id);
    const bMap  = sonic.b || {};
    const bRow  = bMap[businessId] || {};
    const playlists = Array.isArray(bRow.playlists) ? bRow.playlists : [];
    const idx = playlists.findIndex((p) => p && p.id === playlistId);
    if (idx < 0) {
      return res.status(404).json({ error: 'playlist not found in user_metadata' });
    }
    const entry = playlists[idx];

    // Idempotency: if already expanded, short-circuit.
    if (entry.expandedAt) {
      return res.status(200).json({
        ok:              true,
        trackCount:      entry.trackCount || 0,
        done:            true,
        alreadyExpanded: true,
      });
    }

    // We need `expansion.direction` to know what to fetch. Playlists built
    // before this feature was rolled out won't have it — nothing to do.
    const expansion = entry.expansion;
    if (!expansion?.direction?.anchor_genre || !expansion?.direction?.bpm_range) {
      return res.status(400).json({ error: 'playlist entry has no expansion metadata (built pre-feature)' });
    }

    const current = Number.isFinite(entry.trackCount) ? entry.trackCount : 0;
    const need    = Math.max(0, target - current);
    if (need <= 0) {
      // Already at or above target — still mark expanded so we don't retry.
      entry.expandedAt = Date.now();
      playlists[idx] = entry;
      bRow.playlists = playlists;
      const nextSonic = { ...sonic, b: { ...bMap, [businessId]: bRow } };
      await writeUserSonic(user.id, nextSonic);
      return res.status(200).json({ ok: true, trackCount: current, done: true });
    }

    // Fetch a pool of `need` fresh candidate IDs. Since v5_direction_tracks
    // returns random tracks, there's a small chance of overlap with what's
    // already in the playlist — Spotify silently allows duplicates and a
    // few dupes in a 120-track playlist won't be noticed.
    const d = expansion.direction;
    const genres = [d.anchor_genre, ...(d.secondary_genres || [])].filter(Boolean);
    const [pop_lo, pop_hi] = Array.isArray(expansion.popularityWindow)
      ? expansion.popularityWindow.map((v) => Math.round(v))
      : [0, 100];
    const rows = await pgrRpc('v5_direction_tracks', {
      p_genres: genres,
      p_bpm_lo: Math.floor(d.bpm_range.min),
      p_bpm_hi: Math.ceil(d.bpm_range.max),
      p_pop_lo: pop_lo,
      p_pop_hi: pop_hi,
      p_limit:  need,
    });
    const newIds = (rows || []).map((r) => r.spotify_id).filter(Boolean);
    if (!newIds.length) {
      // DB has nothing more for this direction. Mark expanded so we don't
      // retry on every dashboard load.
      entry.expandedAt = Date.now();
      playlists[idx] = entry;
      bRow.playlists = playlists;
      const nextSonic = { ...sonic, b: { ...bMap, [businessId]: bRow } };
      await writeUserSonic(user.id, nextSonic);
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
    try {
      for (let i = 0; i < newIds.length; i += SPOTIFY_CHUNK) {
        const chunk = newIds.slice(i, i + SPOTIFY_CHUNK);
        const uris  = chunk.map((id) => `spotify:track:${id}`);
        await addTracksToSpotify(origin, playlistId, uris);
        running += chunk.length;
        send({ trackCount: running });
      }
    } catch (err) {
      console.error('[expand-playlist] add_tracks failed:', err.message);
      send({ error: err.message || 'add_tracks failed', trackCount: running });
      res.end();
      return;
    }

    // Persist final state so future dashboard loads see this playlist as
    // expanded and skip re-running. Re-read user_metadata NOW (not the copy
    // fetched at the start of the request) and only touch this playlist's
    // fields — anything that changed in between (name update, a new event
    // playlist prepended, a sibling expansion) is preserved.
    try {
      const latestSonic = await readUserSonic(user.id);
      const latestBMap  = { ...(latestSonic.b || {}) };
      const latestBRow  = { ...(latestBMap[businessId] || {}) };
      const latestPls   = Array.isArray(latestBRow.playlists) ? [...latestBRow.playlists] : [];
      const latestIdx   = latestPls.findIndex((p) => p && p.id === playlistId);
      if (latestIdx >= 0) {
        latestPls[latestIdx] = {
          ...latestPls[latestIdx],
          trackCount: running,
          expandedAt: Date.now(),
        };
        latestBRow.playlists = latestPls;
        const nextSonic = { ...latestSonic, b: { ...latestBMap, [businessId]: latestBRow } };
        await writeUserSonic(user.id, nextSonic);
      }
    } catch (err) {
      console.warn('[expand-playlist] final user_metadata write failed:', err.message);
      send({ error: 'metadata write failed', trackCount: running });
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
