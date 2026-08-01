/* /api/v6/account/generate-daily.js
   Build a fresh set of daily playlists on demand.

   Currently used by the account dashboard's "המקום פתוח?" flow — the user
   is on a day their business is marked closed, and they want playlists
   anyway. The endpoint reuses the LATEST direction set from
   user_metadata.sonic.b[bizId].playlists (the last onboarding or generated
   batch), builds a 12h playlist per direction in parallel, and prepends
   them to user_metadata.

   Later this same building block will be reused by the daily-gen cron for
   open days — the cron will size each playlist to that day's opening hours
   + 1h buffer instead of the closed-day 12h fallback (pass targetTracks in
   the body to override).

   Request:  { businessId, bizName?, targetTracks? }
   Response: { ok: true, count, playlists: [...] } | { error }
*/

import { pgrRpc, pgrUpsert } from '../../v5/supabase-client.js';
import { closedDayTargetTracks } from '../../../v6/generation/playlist-length.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY || '';

// Matches the ledger row TTL used by daily + event playlists.
const TTL_HOURS = 24;

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

function todayHe() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function isoDateToday() { return new Date().toISOString().slice(0, 10); }

async function readSonic(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: adminHeaders() });
  if (!r.ok) throw new Error(`user_metadata read failed: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j?.user_metadata?.sonic) || {};
}

async function writeSonic(userId, sonic) {
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

// Pick the LATEST direction set from the user's playlists — the most recent
// batch of playlists that carry expansion.direction metadata (skipping event
// playlists, which have `eventId`). Grouped by createdAt so we take the
// entire batch as a set, not just one entry from an older batch.
function latestDirections(playlists) {
  const eligible = (playlists || []).filter((p) =>
    p && p.expansion?.direction?.anchor_genre && p.expansion?.direction?.bpm_range && !p.eventId
  );
  if (!eligible.length) return { directions: [], popularityWindow: null };
  // Group by createdAt. If some entries lack createdAt, treat them as a
  // separate "unknown" batch — they'll rank below any dated batch.
  const groups = {};
  for (const p of eligible) {
    const k = p.createdAt || '';
    (groups[k] = groups[k] || []).push(p);
  }
  const keys = Object.keys(groups).sort().reverse(); // most recent first
  const latestBatch = groups[keys[0]];
  // Dedup directions inside the batch by (title_en || anchor_genre) so we
  // don't build two "same" playlists if the batch had duplicates for any
  // reason.
  const seen = new Set();
  const directions = [];
  let popularityWindow = null;
  for (const p of latestBatch) {
    const d = p.expansion.direction;
    const key = (d.title_en || '').toLowerCase() + '|' + (d.anchor_genre || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    directions.push(d);
    if (!popularityWindow && Array.isArray(p.expansion.popularityWindow)) {
      popularityWindow = p.expansion.popularityWindow.map((v) => Math.round(v));
    }
  }
  return { directions, popularityWindow };
}

async function fetchDirectionTracks(direction, popularityWindow, target) {
  const genres = [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean);
  const [pop_lo, pop_hi] = Array.isArray(popularityWindow)
    ? popularityWindow.map((v) => Math.round(v))
    : [0, 100];
  const rows = await pgrRpc('v5_direction_tracks', {
    p_genres: genres,
    p_bpm_lo: Math.floor(direction.bpm_range.min),
    p_bpm_hi: Math.ceil(direction.bpm_range.max),
    p_pop_lo: pop_lo,
    p_pop_hi: pop_hi,
    p_limit:  target,
  });
  return (rows || []).map((r) => r.spotify_id).filter(Boolean);
}

async function spotifyCall(origin, action, body) {
  const r = await fetch(`${origin}/api/new/spotify`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-sonic-internal': INTERNAL_API_KEY,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || d?.error || `spotify ${action} ${r.status}`);
  return d;
}

// Spotify's add_tracks cap is 100 URIs per call. Slice into 50s for stability
// (matches expand-playlist's chunking).
const SPOTIFY_ADD_CHUNK = 50;
async function addAllTracks(origin, playlistId, spotifyIds) {
  for (let i = 0; i < spotifyIds.length; i += SPOTIFY_ADD_CHUNK) {
    const uris = spotifyIds.slice(i, i + SPOTIFY_ADD_CHUNK).map((id) => `spotify:track:${id}`);
    await spotifyCall(origin, 'add_tracks', { playlist_id: playlistId, uris });
  }
}

function playlistName(bizName, direction) {
  const title = direction.title_en || direction.anchor_genre || 'Playlist';
  const clean = String(bizName || '').trim();
  return (clean ? `${clean} · ${title} · ${todayHe()}` : `${title} · ${todayHe()}`).slice(0, 100);
}

async function buildOne({ origin, direction, popularityWindow, target, bizName }) {
  const ids = await fetchDirectionTracks(direction, popularityWindow, target);
  if (!ids.length) {
    return { direction, skipped: true, reason: 'no tracks matched' };
  }
  const name        = playlistName(bizName, direction);
  const description = direction.description_he || direction.title_en || '';
  const created     = await spotifyCall(origin, 'create_playlist', { name, description });
  if (!created?.id) throw new Error('create_playlist returned no id');
  await addAllTracks(origin, created.id, ids);

  // 24h ledger row so /api/cron/expire-playlists cleans it up.
  const expiresAtMs  = Date.now() + TTL_HOURS * 3600 * 1000;
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  try {
    await pgrUpsert('v5_created_playlists', {
      spotify_id: created.id,
      name,
      expires_at: expiresAtIso,
      deleted_at: null,
      error:      null,
    }, { onConflict: 'spotify_id' });
  } catch (e) {
    console.warn('[generate-daily] ledger upsert failed:', e.message);
  }

  return {
    skipped: false,
    entry: {
      ico:        '🎵',
      label:      direction.title_en || direction.anchor_genre || 'פלייליסט',
      url:        created.external_urls?.spotify || '',
      id:         created.id,
      trackCount: ids.length,
      genres:     [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean),
      createdAt:  isoDateToday(),
      expiresAt:  expiresAtMs,
      // No `expansion` field on closed-day playlists — they're already at
      // their full target length, so the dashboard's expand-playlist logic
      // shouldn't touch them. `expandedAt` short-circuits that too.
      expandedAt: expiresAtMs,
    },
  };
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

    // Default to 12h + 1h for the closed-day flow. Future daily-gen cron
    // will pass a per-day-hours target instead.
    const target = Number.isFinite(targetTracks) && targetTracks > 0
      ? Math.min(Math.round(targetTracks), 500)
      : closedDayTargetTracks();

    const sonic     = await readSonic(user.id);
    const bMap      = sonic.b || {};
    const bRow      = bMap[businessId] || {};
    const playlists = Array.isArray(bRow.playlists) ? bRow.playlists : [];

    const { directions, popularityWindow } = latestDirections(playlists);
    if (!directions.length) {
      return res.status(400).json({ error: 'לא נמצאו כיוונים מוסיקליים לבניית פלייליסטים' });
    }

    const origin = selfOrigin(req);
    const results = await Promise.all(
      directions.map((direction) => buildOne({
        origin,
        direction,
        popularityWindow,
        target,
        bizName,
      }).catch((err) => {
        console.warn(`[generate-daily] "${direction.title_en}" failed:`, err.message);
        return { skipped: true, reason: err.message };
      })),
    );
    const built = results.filter((r) => r && !r.skipped && r.entry).map((r) => r.entry);
    if (!built.length) {
      return res.status(500).json({ error: 'לא הצלחנו לבנות אף פלייליסט. נסו שוב.' });
    }

    // Prepend the new playlists to the user's list, keep the most recent 30
    // (same cap as event-playlist's prependPlaylist).
    const nextPlaylists = [...built, ...playlists].slice(0, 30);
    const nextRow  = { ...bRow, playlists: nextPlaylists };
    const nextBMap = { ...bMap, [businessId]: nextRow };
    const nextSonic = { ...sonic, b: nextBMap };
    await writeSonic(user.id, nextSonic);

    console.log(`[generate-daily] user=${user.id} biz=${businessId} built ${built.length}/${directions.length} playlists (target=${target} tracks)`);
    return res.status(200).json({ ok: true, count: built.length, playlists: built });
  } catch (err) {
    console.error('[generate-daily] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
