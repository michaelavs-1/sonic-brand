/* /api/v6/account/_daily-builder.js
   Shared primitives for building a set of "daily playlists" (one per musical
   direction) on Rubin's Spotify account and persisting the entries into a
   user's user_metadata.

   Consumed by:
     - /api/v6/account/generate-daily.js  (user-triggered, closed-day flow)
     - /api/cron/generate-daily.js        (scheduled daily generation)

   Not an HTTP endpoint — the leading underscore signals "private helper".

   Exports:
     buildDailyBatch({ ownerId, businessId, bizName,
                       directions, popularityWindow, target,
                       expiryIso, origin })
       → { built: [entryObj, ...], failures: [{ title, reason }, ...] }
       Builds N Spotify playlists in parallel, upserts N ledger rows, then
       prepends N entries to user_metadata.sonic.b[bizId].playlists in ONE
       write. `expiryIso` = null means "use the module's default 24h TTL"
       (that's what the closed-day flow uses, so its behavior is unchanged).

     latestDirections(playlists)
       → { directions, popularityWindow } — most-recent batch of onboarding
       playlists (grouped by createdAt), dedup'd by title/anchor.

     readSonic(userId)  / writeSonic(userId, sonic)
       Admin-API user_metadata read/write helpers.
*/

import { pgrRpc, pgrUpsert, pgrInsert } from '../../v5/supabase-client.js';
import { nextIl4amIso, directionKey }   from '../../../v6/generation/playlist-length.js';

// Default freshness window for the dedup filter — tracks served to this
// (business, direction) within this many days are excluded from selection.
// If the filtered pool comes back short, we retry with 0 days (no exclusion)
// and merge, so playlists still hit target length.
const DEDUP_WINDOW_DAYS = 7;

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY || '';

// Spotify's add_tracks cap is 100 URIs per call. Chunk conservatively for
// stability (matches expand-playlist.js).
const SPOTIFY_ADD_CHUNK = 50;

// -------- user_metadata admin helpers --------

function adminHeaders() {
  return {
    apikey:        SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function readSonic(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: adminHeaders() });
  if (!r.ok) throw new Error(`user_metadata read failed: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j?.user_metadata?.sonic) || {};
}

export async function writeSonic(userId, sonic) {
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

// -------- direction selection --------

// Pick the LATEST direction set from the user's playlists — the most recent
// batch of daily playlists (skipping events + closed-day 12h without
// expansion metadata isn't excluded because closed-day playlists don't
// carry expansion metadata anyway). Grouped by createdAt so we take the
// entire batch as a set, not just one entry from an older batch.
export function latestDirections(playlists) {
  const eligible = (playlists || []).filter((p) =>
    p && p.expansion?.direction?.anchor_genre && p.expansion?.direction?.bpm_range && !p.eventId
  );
  if (!eligible.length) return { directions: [], popularityWindow: null };

  const groups = {};
  for (const p of eligible) {
    const k = p.createdAt || '';
    (groups[k] = groups[k] || []).push(p);
  }
  const keys = Object.keys(groups).sort().reverse();
  const latestBatch = groups[keys[0]];

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

// -------- Supabase RPC + Spotify helpers --------

// Fetch `target` unique spotify_ids for one (business, direction), avoiding
// tracks served to that same pair within DEDUP_WINDOW_DAYS. If the filtered
// pool comes back short (narrow direction / small track catalogue), refill
// from the full pool so the playlist still reaches target length.
export async function fetchTracksWithHistory({ businessId, direction, popularityWindow, target }) {
  const key = directionKey(direction);
  const genres = [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean);
  const [pop_lo, pop_hi] = Array.isArray(popularityWindow)
    ? popularityWindow.map((v) => Math.round(v))
    : [0, 100];
  const baseArgs = {
    p_genres: genres,
    p_bpm_lo: Math.floor(direction.bpm_range.min),
    p_bpm_hi: Math.ceil(direction.bpm_range.max),
    p_pop_lo: pop_lo,
    p_pop_hi: pop_hi,
    p_biz_id: businessId,
    p_direction_key: key,
  };

  // Primary: exclude tracks served in the last 7 days.
  const primary = await pgrRpc('v6_direction_tracks_recent', {
    ...baseArgs, p_limit: target, p_exclude_days: DEDUP_WINDOW_DAYS,
  });
  const ids = (primary || []).map((r) => r.spotify_id).filter(Boolean);

  // Pool-shortage fallback: refill from the full pool. Ask for extra so we
  // can skip anything already in `ids` without a second round-trip. Track
  // duplicates within one playlist are meaningless (Spotify silently allows
  // them) — but we still dedupe for tidiness and to correctly count length.
  if (ids.length < target) {
    const seen = new Set(ids);
    const need = target - ids.length;
    const fill = await pgrRpc('v6_direction_tracks_recent', {
      ...baseArgs, p_limit: (need + ids.length) * 2, p_exclude_days: 0,
    });
    for (const r of (fill || [])) {
      if (r?.spotify_id && !seen.has(r.spotify_id)) {
        ids.push(r.spotify_id);
        seen.add(r.spotify_id);
        if (ids.length >= target) break;
      }
    }
  }

  return { ids, directionKey: key };
}

// Record every served track in v6_daily_track_history so future runs can
// dedup against it. Non-fatal on failure — the playlist is already built;
// worst case is a next-day overlap.
export async function recordTrackHistory({ businessId, directionKey: key, spotifyIds }) {
  if (!businessId || !key || !Array.isArray(spotifyIds) || !spotifyIds.length) return;
  try {
    await pgrInsert('v6_daily_track_history', spotifyIds.map((sid) => ({
      business_id:   businessId,
      direction_key: key,
      spotify_id:    sid,
    })), { ignoreDuplicates: true });
  } catch (e) {
    console.warn(`[daily-builder] history insert failed for biz=${businessId} key=${key}:`, e.message);
  }
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

async function addAllTracks(origin, playlistId, spotifyIds) {
  for (let i = 0; i < spotifyIds.length; i += SPOTIFY_ADD_CHUNK) {
    const uris = spotifyIds.slice(i, i + SPOTIFY_ADD_CHUNK).map((id) => `spotify:track:${id}`);
    await spotifyCall(origin, 'add_tracks', { playlist_id: playlistId, uris });
  }
}

// "12.04.2026" — Hebrew-friendly dd.mm.yyyy.
function todayHe() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function isoDateToday() { return new Date().toISOString().slice(0, 10); }

function playlistName(bizName, direction) {
  const title = direction.title_en || direction.anchor_genre || 'Playlist';
  const clean = String(bizName || '').trim();
  return (clean ? `${clean} · ${title} · ${todayHe()}` : `${title} · ${todayHe()}`).slice(0, 100);
}

// -------- build one playlist --------

// Builds one Spotify playlist for one direction, registers a ledger row for
// expiry, writes a history row per served track, and returns the entry
// object the caller will splice into user_metadata. Never writes
// user_metadata itself — the batch caller does that once at the end so N
// parallel builds don't race.
export async function buildOneDailyPlaylist({
  origin, ownerId, businessId, direction, popularityWindow, target, bizName, expiryIso,
}) {
  const { ids, directionKey: key } = await fetchTracksWithHistory({
    businessId, direction, popularityWindow, target,
  });
  if (!ids.length) {
    return { skipped: true, reason: 'no tracks matched', title: direction.title_en };
  }

  const name        = playlistName(bizName, direction);
  const description = direction.description_he || direction.title_en || '';
  const created     = await spotifyCall(origin, 'create_playlist', { name, description });
  if (!created?.id) throw new Error('create_playlist returned no id');
  await addAllTracks(origin, created.id, ids);

  // Record every served track for next-day dedup. Best-effort — a failure
  // here doesn't undo the build, worst case is minor overlap tomorrow.
  await recordTrackHistory({ businessId, directionKey: key, spotifyIds: ids });

  // Ledger row so /api/cron/expire-playlists cleans up on time. When the
  // caller passes expiryIso=null (closed-day manual flow), fall back to
  // "next 04:00 IL" — the user's chosen expiry for one-off manual
  // playlists.
  const expiresAtIso = expiryIso || nextIl4amIso();
  try {
    await pgrUpsert('created_playlists', {
      spotify_id:  created.id,
      name,
      expires_at:  expiresAtIso,
      deleted_at:  null,
      error:       null,
      owner_id:    ownerId || null,
      business_id: businessId,
    }, { onConflict: 'spotify_id' });
  } catch (e) {
    console.warn(`[daily-builder] ledger upsert failed for ${created.id}:`, e.message);
  }

  const expiresAtMs = Date.parse(expiresAtIso);
  const entry = {
    ico:        '🎵',
    label:      direction.title_en || direction.anchor_genre || 'פלייליסט',
    url:        created.external_urls?.spotify || '',
    id:         created.id,
    trackCount: ids.length,
    genres:     [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean),
    createdAt:  isoDateToday(),
    expiresAt:  Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
    // Carry the direction forward so future daily-gen (or a closed-day
    // manual click) can find + reuse this set via latestDirections().
    expansion: {
      direction: {
        title_en:         direction.title_en,
        description_he:   direction.description_he,
        anchor_genre:     direction.anchor_genre,
        secondary_genres: direction.secondary_genres || [],
        bpm_range:        direction.bpm_range,
      },
      popularityWindow,
    },
    // Already at target length — the dashboard's expand-playlist logic
    // won't touch entries with expandedAt set.
    expandedAt: Date.now(),
  };
  // Strip undefined for a clean JSON blob.
  if (entry.expiresAt === undefined) delete entry.expiresAt;
  return { skipped: false, entry };
}

// -------- batch: N directions → N entries + one user_metadata write --------

export async function buildDailyBatch({
  ownerId, businessId, bizName,
  directions, popularityWindow, target, expiryIso, origin,
}) {
  if (!Array.isArray(directions) || !directions.length) {
    return { built: [], failures: [] };
  }

  const results = await Promise.all(
    directions.map((direction) =>
      buildOneDailyPlaylist({ origin, ownerId, businessId, direction, popularityWindow, target, bizName, expiryIso })
        .catch((err) => {
          console.warn(`[daily-builder] "${direction.title_en}" failed:`, err.message);
          return { skipped: true, reason: err.message, title: direction.title_en };
        }),
    ),
  );

  const built    = results.filter((r) => r && !r.skipped && r.entry).map((r) => r.entry);
  const failures = results.filter((r) => r && r.skipped).map((r) => ({ title: r.title, reason: r.reason }));

  if (built.length) {
    // Single user_metadata write for the whole batch. Re-read latest to
    // preserve any unrelated concurrent updates (name edits, sibling
    // event-playlist prepends).
    const latest = await readSonic(ownerId);
    const bMap   = { ...(latest.b || {}) };
    const bRow   = { ...(bMap[businessId] || {}) };
    const prior  = Array.isArray(bRow.playlists) ? bRow.playlists : [];
    bRow.playlists = [...built, ...prior].slice(0, 30);
    bMap[businessId] = bRow;
    await writeSonic(ownerId, { ...latest, b: bMap });
  }

  return { built, failures };
}
