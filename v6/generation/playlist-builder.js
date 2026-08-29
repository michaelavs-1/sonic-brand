// v5 per-direction playlist builder.
//
// Input:
//   {
//     selectedDirections: [{ rank, title_en, description_he, genres,
//                            bpm_range }, ...],
//     bizName:            'שם העסק' | '',
//     popularityWindow:   [lo, hi] | null,
//   }
//
// Output:
//   [{ direction, url, id, name, trackCount, requested } | { direction, skipped, reason }]
//
// One playlist per selected direction:
//   1) POST /api/v5/direction-tracks with the direction's genres + BPM +
//      popularity window. Server returns up to TARGET_TRACKS random spotify_ids.
//   2) Create a private+collaborative playlist on Rubin's account
//      (reuses /api/new/spotify.js — same Rubin refresh token).
//   3) Add the tracks.
//
// Playlist name format (customer-facing, per user's screenshot):
//   "{bizName} · {title_en} · DD.MM.YYYY"
//   If bizName is empty: "{title_en} · DD.MM.YYYY"

const TARGET_TRACKS = 10;

function dateSuffix() {
  const d  = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function playlistName(bizName, direction) {
  const title = direction.title_en;
  const date  = dateSuffix();
  return bizName && bizName.trim()
    ? `${bizName.trim()} · ${title} · ${date}`
    : `${title} · ${date}`;
}

async function fetchDirectionTracks(direction, popularityWindow) {
  // New shape uses a flat `genres` list; fall back to legacy anchor+secondaries
  // if this direction came from persisted pre-refactor metadata.
  const genres = Array.isArray(direction.genres) && direction.genres.length
    ? direction.genres
    : [direction.anchor_genre, ...(direction.secondary_genres || [])].filter(Boolean);
  const body = {
    genres,
    bpm_range:  direction.bpm_range,
    popularity: popularityWindow,
    limit:      TARGET_TRACKS,
    // 'none' | 'soft' | 'hard' — the SQL RPC applies a strict WHERE
    // filter (hard) or an ORDER BY bias (soft) on ta.instrumentalness.
    instrumentalness_preference: direction.instrumentalness_preference || 'none',
  };
  const r = await fetch('/api/v5/direction-tracks', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`direction-tracks ${r.status}: ${data?.error || r.statusText}`);
  return data.spotify_ids || [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One fetch attempt against /api/new/spotify. Detects the wrapped
// 200-with-inner-error case that api/new/spotify uses for add_tracks
// (it ALWAYS returns 200 with a results[] array even when an inner
// Spotify call 4xx/5xx'd — without this check, a partial add_tracks
// failure would silently be treated as success). Returns a shape the
// retry loop can inspect: { ok:true, data } | { ok:false, status,
// retriable, error }.
async function postSpotifyOnce(action, body) {
  let r;
  try {
    r = await fetch('/api/new/spotify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action, ...body }),
    });
  } catch (err) {
    // Network / socket failure before any HTTP response — always retriable.
    return { ok: false, status: 0, retriable: true, error: err };
  }
  const data = await r.json().catch(() => ({}));
  const chunkFail = action === 'add_tracks' && Array.isArray(data?.results)
    ? data.results.find((x) => !x || x.status >= 400) : null;
  if (r.ok && !chunkFail) return { ok: true, data };
  const status  = chunkFail ? chunkFail.status : r.status;
  const errBody = chunkFail ? chunkFail.body   : data;
  const msg     = errBody?.error?.message || errBody?.error || `${action} ${status}`;
  // Global pause switch (api/new/spotify.js) returns 503 error='spotify_paused'.
  // Never retry it — the whole point is to stop hammering during a Spotify block.
  const paused = errBody?.error === 'spotify_paused'
              || (typeof errBody?.error === 'string' && errBody.error.includes('spotify_paused'));
  return {
    ok: false,
    status,
    retriable: !paused && (status >= 500 || status === 429),
    error: new Error(`spotify ${action}: ${msg}`),
  };
}

// 3 attempts with 500ms / 1000ms backoff on 5xx / 429 / network. Terminal
// failure (bad request, wrong token, unretriable) throws immediately.
// After MAX_ATTEMPTS the last error is thrown so the outer catch in
// buildDirectionPlaylists marks the whole playlist as skipped rather
// than lying about a success that never actually landed on Spotify.
async function postSpotify(action, body) {
  const MAX_ATTEMPTS = 3;
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await postSpotifyOnce(action, body);
    if (last.ok) return last.data;
    if (!last.retriable || attempt === MAX_ATTEMPTS) throw last.error;
    console.warn(`spotify ${action} attempt ${attempt} failed (${last.status || 'network'}), retrying in ${500 * attempt}ms:`, last.error?.message);
    await sleep(500 * attempt);
  }
  throw last?.error || new Error(`spotify ${action} failed`);
}

async function buildOne({ direction, bizName, popularityWindow }) {
  const ids = await fetchDirectionTracks(direction, popularityWindow);
  if (!ids.length) {
    return { direction, skipped: true, reason: 'no tracks matched BPM + popularity' };
  }

  const name        = playlistName(bizName, direction);
  const description = direction.description_he || direction.title_en;

  const playlist = await postSpotify('create_playlist', { name, description });
  if (!playlist?.id) throw new Error('create_playlist returned no id');

  await postSpotify('add_tracks', {
    playlist_id: playlist.id,
    uris:        ids.map((id) => `spotify:track:${id}`),
  });

  // Fire-and-forget: record the created playlist so the cron worker can
  // expire it 24h later. A failure here shouldn't break the user flow —
  // worst case the playlist just isn't auto-cleaned.
  fetch('/api/v5/record-playlist', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ spotify_id: playlist.id, name }),
  }).catch((e) => console.warn('v5 record-playlist failed:', e?.message));

  // Return everything the account-dashboard's background expansion needs so
  // it can grow the playlist to a full day's length without re-generating
  // directions or re-fetching atmosphere state. `direction` is trimmed to
  // just the fields expand-playlist reads.
  return {
    direction,
    skipped:    false,
    id:         playlist.id,
    url:        playlist.external_urls?.spotify || '',
    name,
    trackCount: ids.length,
    requested:  TARGET_TRACKS,
    // Actual Spotify track IDs used, in the order they were added to the
    // playlist. Passed through to the DB as business_playlists.track_ids
    // by signup so each playlist row is a complete snapshot of what was
    // built. expand-playlist appends the growth IDs on the same column
    // when the sample gets grown to full length on first dashboard visit.
    trackIds:   ids,
    // Fields carried forward into user_metadata for later expansion + for
    // the "closed day → generate daily" flow which needs title_en +
    // description_he to name the fresh playlists. `genres` replaces the
    // previous anchor_genre+secondary_genres shape — all genres are equal.
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
  };
}

// Builds playlists serially with a small inter-playlist gap. `onProgress(index,
// result)` is called each time one completes (now equivalent to rank order,
// since we're serial). Returns the full results array in rank order.
//
// Pacing (2026-08-29 post-Aug-22-incident): switched from Promise.all fan-out
// to serial + 2s stagger. The onboarding path can burst-fire ~4-8 playlists
// per user, and combined with other traffic that contributed to the Aug 22
// rate-limit escalation. UX cost: an extra ~8-15s from first card populated
// to last, while placeholder cards keep the user oriented. See the parallel
// pacing change in api/v6/account/_daily-builder.js (same rationale, different
// caller — cron rather than onboarding).
const INTER_BUILD_MS = 2000;

export async function buildDirectionPlaylists({ selectedDirections, bizName, popularityWindow, onProgress }) {
  if (!Array.isArray(selectedDirections) || !selectedDirections.length) return [];

  const results = new Array(selectedDirections.length);
  for (let index = 0; index < selectedDirections.length; index++) {
    if (index > 0) await sleep(INTER_BUILD_MS);
    const direction = selectedDirections[index];
    let result;
    try {
      result = await buildOne({ direction, bizName, popularityWindow });
    } catch (err) {
      console.error(`v5 playlist "${direction.title_en}" (rank ${direction.rank}) failed:`, err);
      result = { direction, skipped: true, reason: err.message };
    }
    results[index] = result;
    if (typeof onProgress === 'function') {
      try { onProgress(index, result); } catch (e) { console.error('v5 onProgress threw:', e); }
    }
  }
  return results;
}
