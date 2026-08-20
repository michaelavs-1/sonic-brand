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

async function postSpotify(action, body) {
  const r = await fetch('/api/new/spotify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || r.statusText;
    throw new Error(`spotify ${action} ${r.status}: ${msg}`);
  }
  return data;
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

// Fires all playlist builds in parallel. `onProgress(index, result)` is called
// each time one completes (in completion order, not rank order — the index
// matches its position in selectedDirections so the caller can update the
// right placeholder card). Returns the full results array once all promises
// settle, in original rank order.
export async function buildDirectionPlaylists({ selectedDirections, bizName, popularityWindow, onProgress }) {
  if (!Array.isArray(selectedDirections) || !selectedDirections.length) return [];

  const promises = selectedDirections.map(async (direction, index) => {
    let result;
    try {
      result = await buildOne({ direction, bizName, popularityWindow });
    } catch (err) {
      console.error(`v5 playlist "${direction.title_en}" (rank ${direction.rank}) failed:`, err);
      result = { direction, skipped: true, reason: err.message };
    }
    if (typeof onProgress === 'function') {
      try { onProgress(index, result); } catch (e) { console.error('v5 onProgress threw:', e); }
    }
    return result;
  });

  return Promise.all(promises);
}
