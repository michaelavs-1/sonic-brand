/* /api/v6/account/_daily-builder.js
   Shared primitives for building a set of "daily playlists" (one per musical
   direction) on Rubin's Spotify account and persisting the rows into
   business_playlists.

   Consumed by:
     - /api/v6/account/generate-daily.js  (user-triggered, closed-day flow)
     - /api/cron/generate-daily.js        (scheduled daily generation)

   Not an HTTP endpoint — the leading underscore signals "private helper".

   Exports:
     buildDailyBatch({ ownerId, businessId, bizName,
                       directions, popularityWindow, target,
                       expiryIso, origin })
       → { built: [rowObj, ...], failures: [{ title, reason }, ...] }
       Builds N Spotify playlists in parallel, upserts N ledger rows, and
       INSERTs N rows into business_playlists in one batch. `expiryIso` =
       null means "use the module's default next-4am TTL" (closed-day
       manual flow).

     latestDirections(rows)
       Accepts business_playlists rows (snake_case: expansion, event_id,
       created_at). Returns { directions, popularityWindow } — most-recent
       batch of onboarding/daily playlists (grouped by created_at date),
       dedup'd by title/anchor. Skips event playlists.

     fetchTracksWithHistory / recordTrackHistory
       RPC helpers, unchanged from the pre-migration file — the track
       dedup story is on v6_daily_track_history which was already in
       Postgres.
*/

import { pgrRpc, pgrUpsert, pgrInsert } from '../../v5/supabase-client.js';
import { nextIl4amIso, directionKey }   from '../../../v6/generation/playlist-length.js';

// Default freshness window for the dedup filter — tracks served to this
// (business, direction) within this many days are excluded from selection.
// If the filtered pool comes back short, we retry with 0 days (no exclusion)
// and merge, so playlists still hit target length.
const DEDUP_WINDOW_DAYS = 7;

const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY || '';

// Spotify's add_tracks cap is 100 URIs per call. Chunk conservatively for
// stability (matches expand-playlist.js).
const SPOTIFY_ADD_CHUNK = 50;

// -------- direction selection --------

// Pick the LATEST direction set from a business's playlists — the most
// recent batch of daily playlists grouped by created_at date. Accepts
// business_playlists table rows (snake_case columns). Event playlists
// (`event_id != null`) are skipped since they don't carry direction
// expansion. Rows without expansion metadata are also skipped.
// A direction row is "eligible" if it has a genre list (new shape: `genres`,
// or legacy: `anchor_genre`) and a BPM range. Event playlists are skipped
// (no expansion metadata).
function directionHasGenres(d) {
  if (!d) return false;
  if (Array.isArray(d.genres) && d.genres.length) return true;
  return typeof d.anchor_genre === 'string' && d.anchor_genre.length > 0;
}

export function latestDirections(rows) {
  const eligible = (rows || []).filter((p) =>
    p && directionHasGenres(p.expansion?.direction) && p.expansion?.direction?.bpm_range && !p.event_id
  );
  if (!eligible.length) return { directions: [], popularityWindow: null };

  // Group by ISO date (yyyy-mm-dd slice of created_at). Take the newest.
  const groups = {};
  for (const p of eligible) {
    const k = (p.created_at || '').slice(0, 10);
    (groups[k] = groups[k] || []).push(p);
  }
  const keys = Object.keys(groups).sort().reverse();
  const latestBatch = groups[keys[0]];

  const seen = new Set();
  const directions = [];
  let popularityWindow = null;
  for (const p of latestBatch) {
    const d = p.expansion.direction;
    // Dedup key: title + sorted genre list. Title alone isn't enough (Ami
    // may reuse titles across variants); the genre set fingerprints the
    // direction independently of any "anchor" concept.
    const genres = Array.isArray(d.genres) && d.genres.length
      ? d.genres
      : [d.anchor_genre, ...(d.secondary_genres || [])].filter(Boolean);
    const genreKey = genres.map((g) => String(g).toLowerCase()).sort().join('|');
    const key = (d.title_en || '').toLowerCase() + '|' + genreKey;
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
  const genres = Array.isArray(direction.genres) && direction.genres.length
    ? direction.genres
    : [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One HTTP attempt against /api/new/spotify. Distinct from spotifyCall so
// the retry loop can inspect the failure and decide.
//   ok=true  → { data }
//   ok=false → { status, error, retriable }
async function spotifyAttempt(origin, action, body) {
  let r;
  try {
    r = await fetch(`${origin}/api/new/spotify`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-sonic-internal': INTERNAL_API_KEY,
      },
      body: JSON.stringify({ action, ...body }),
    });
  } catch (err) {
    // Network / DNS / socket failure before we got any HTTP response — always
    // safe to retry (nothing hit Spotify).
    return { ok: false, status: 0, retriable: true, error: err };
  }
  const d = await r.json().catch(() => ({}));
  // api/new/spotify wraps add_tracks: it internally chunks by 100 URIs and
  // ALWAYS returns HTTP 200 with a results[] array, even when an inner
  // Spotify call 5xx'd. Detect that hidden failure so we don't build a
  // partial playlist and then insert its row as if it succeeded.
  const chunkFail = action === 'add_tracks' && Array.isArray(d?.results)
    ? d.results.find((x) => x?.status >= 400) : null;
  if (r.ok && !chunkFail) return { ok: true, data: d };
  const status = chunkFail ? chunkFail.status : r.status;
  const errBody = chunkFail ? chunkFail.body : d;
  const msg = errBody?.error?.message || errBody?.error || `spotify ${action} ${status}`;
  return {
    ok: false, status,
    retriable: status >= 500 || status === 429,
    error: new Error(msg),
  };
}

// Retries on 5xx / 429 / network with exponential-ish backoff (500ms, 1000ms).
// Safe for both create_playlist (idempotent enough — worst case Spotify has a
// stray empty playlist we never referenced) and add_tracks (daily-builder
// chunks by SPOTIFY_ADD_CHUNK=50, so each spotifyCall carries ≤50 URIs and
// api/new/spotify's internal 100-URI chunking is a no-op — retrying the whole
// call re-adds the same 50, no dupes vs. partial success).
async function spotifyCall(origin, action, body) {
  const MAX_ATTEMPTS = 3;
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await spotifyAttempt(origin, action, body);
    if (last.ok) return last.data;
    if (!last.retriable || attempt === MAX_ATTEMPTS) throw last.error;
    const delay = 500 * attempt;
    console.warn(`[daily-builder] spotify ${action} ${last.status || 'network'} attempt ${attempt} — retrying after ${delay}ms: ${last.error?.message}`);
    await sleep(delay);
  }
  throw last?.error || new Error(`spotify ${action} failed`);
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

function playlistName(bizName, direction) {
  // Title fallback: direction.title_en, then the first genre (arbitrary but
  // stable) if title is missing on a legacy row, then a hard default.
  const firstGenre = Array.isArray(direction.genres) && direction.genres.length
    ? direction.genres[0]
    : direction.anchor_genre;
  const title = direction.title_en || firstGenre || 'Playlist';
  const clean = String(bizName || '').trim();
  return (clean ? `${clean} · ${title} · ${todayHe()}` : `${title} · ${todayHe()}`).slice(0, 100);
}

// -------- build one playlist --------

// Builds one Spotify playlist for one direction, registers a ledger row for
// expiry, writes a history row per served track, and returns a row shaped
// for INSERT into business_playlists. The batch caller then INSERTs all N
// rows in one call.
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

  // Row shaped for INSERT INTO business_playlists. `expanded_at` is set
  // eagerly — daily playlists are born at target length; the dashboard's
  // expand-playlist logic short-circuits on any row with expanded_at set.
  const row = {
    spotify_id:  created.id,
    business_id: businessId,
    url:         created.external_urls?.spotify || '',
    label:       direction.title_en || 'פלייליסט',
    ico:         '🎵',
    track_count: ids.length,
    genres:      Array.isArray(direction.genres) && direction.genres.length
      ? direction.genres
      : [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean),
    bpm_range:   null,
    expansion: {
      direction: {
        title_en:       direction.title_en,
        description_he: direction.description_he,
        genres:         Array.isArray(direction.genres) && direction.genres.length
          ? direction.genres
          : [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean),
        bpm_range:      direction.bpm_range,
      },
      popularityWindow,
    },
    event_id:    null,
    expanded_at: new Date().toISOString(),
    expires_at:  expiresAtIso,
    created_at:  new Date().toISOString(),
  };
  return { skipped: false, row };
}

// -------- batch: N directions → N INSERTs into business_playlists --------

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

  const built    = results.filter((r) => r && !r.skipped && r.row).map((r) => r.row);
  const failures = results.filter((r) => r && r.skipped).map((r) => ({ title: r.title, reason: r.reason }));

  if (built.length) {
    // Single INSERT for all N rows. ignoreDuplicates=true means a retry
    // that re-runs the batch won't error on the second attempt if the
    // first partially succeeded — Spotify creates new IDs each run so
    // this is defensive against the same request being replayed.
    try {
      await pgrInsert('business_playlists', built, { ignoreDuplicates: true });
    } catch (e) {
      console.error('[daily-builder] business_playlists batch insert failed:', e.message);
      throw e;
    }
  }

  return { built, failures };
}
