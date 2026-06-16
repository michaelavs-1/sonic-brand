// v4 final-playlist builder.
//
// Input:  { bizType, bizName, strictGenres, relaxedGenres, screenParams }
// Output: { url, id, trackCount, perGenre, requested } on success,
//         { skipped: true, reason } if nothing to build.
//
// Strict vs relaxed: genres in `strictGenres` are filtered by the atmosphere
// windows; genres in `relaxedGenres` are NOT — they're sourced from the full
// cached pool, no energy/danceability/popularity filter. A genre lands in
// `relaxedGenres` when the user picked at least one preview card from it
// whose matched_screen=false (i.e. no track from that genre actually passed
// the screen, but they liked the unscreened sample). That's the user telling
// us "yes, I want this genre even though it doesn't fit the atmosphere".
//
// Pipeline:
//   1) POST /api/v4/cached-playlist with both genre lists + screen params.
//      Server applies the screen only to the strict list. Returns up to ~200
//      random track IDs per genre.
//   2) Balance picks across all selected genres equal-as-possible with
//      leftover redistribution (see balanceAcrossGenres below), shuffle the
//      final pool, cap at TARGET_TRACKS.
//   3) Create a private + collaborative playlist on the Rubin Spotify user
//      account via /api/new/spotify (reused from the v3/new pipeline —
//      already wired to RUBIN_REFRESH_TOKEN).
//   4) add_tracks the chosen IDs in a single call (Spotify allows 100/req;
//      40 is well under).

const TARGET_TRACKS = 40;
const PER_GENRE_CAP = 200;

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Equal-as-possible distribution with leftover redistribution.
//
// We walk the genres sorted by candidate-pool-size ASC so the most-constrained
// genre is handled first. Each iteration computes its quota as
// ceil(remaining / remainingGenres), takes min(pool, quota), and passes any
// deficit forward to the still-untouched (and larger) pools. Result: genres
// with enough material get whatever the constrained ones couldn't supply.
//
// Returns { picks: { [genre]: [ids] }, totalPicked }
function balanceAcrossGenres(tracksByGenre, target) {
  const entries = Object.entries(tracksByGenre)
    .map(([g, ids]) => ({ genre: g, pool: shuffle(ids) }))
    .filter((e) => e.pool.length);
  if (!entries.length) return { picks: {}, totalPicked: 0 };

  entries.sort((a, b) => a.pool.length - b.pool.length);

  const picks    = {};
  let   remaining = target;
  let   remainingGenres = entries.length;

  for (const { genre, pool } of entries) {
    const quota = Math.ceil(remaining / remainingGenres);
    const take  = Math.min(pool.length, quota);
    picks[genre] = pool.slice(0, take);
    remaining       -= take;
    remainingGenres -= 1;
  }

  let totalPicked = 0;
  for (const ids of Object.values(picks)) totalPicked += ids.length;
  return { picks, totalPicked };
}

function dateSuffix() {
  const d  = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
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

async function fetchCandidates(strictGenres, relaxedGenres, screenParams) {
  const r = await fetch('/api/v4/cached-playlist', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      strict_genres:  strictGenres,
      relaxed_genres: relaxedGenres,
      screen_params:  screenParams,
      per_genre:      PER_GENRE_CAP,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`cached-playlist ${r.status}: ${data?.error || r.statusText}`);
  }
  return data.tracksByGenre || {};
}

export async function buildFinalPlaylist({ bizType, bizName, strictGenres, relaxedGenres, screenParams }) {
  const strict  = Array.isArray(strictGenres)  ? strictGenres  : [];
  const relaxed = Array.isArray(relaxedGenres) ? relaxedGenres : [];
  if (!strict.length && !relaxed.length) {
    return { skipped: true, reason: 'no desired genres selected' };
  }

  console.log(
    `v4 playlist: requesting candidates — strict=${strict.length} relaxed=${relaxed.length}`,
    { strict, relaxed },
  );
  const tracksByGenre = await fetchCandidates(strict, relaxed, screenParams || {});

  const perGenrePool = Object.fromEntries(
    Object.entries(tracksByGenre).map(([g, ids]) => [g, ids.length])
  );
  console.log('v4 playlist: candidate pool sizes per genre', perGenrePool);

  const { picks, totalPicked } = balanceAcrossGenres(tracksByGenre, TARGET_TRACKS);

  // Dedupe across genres (a track could theoretically land in two genres'
  // pools; cached_playlist DISTINCTs per-genre but not across). Preserve the
  // first occurrence so genre attribution stays meaningful.
  const seen     = new Set();
  const finalIds = [];
  const perGenre = {};
  for (const [genre, ids] of Object.entries(picks)) {
    perGenre[genre] = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      finalIds.push(id);
      perGenre[genre] += 1;
    }
  }

  // Final shuffle so consecutive playlist tracks aren't bucketed by genre.
  const shuffled = shuffle(finalIds).slice(0, TARGET_TRACKS);

  console.log(
    `v4 playlist: picked ${shuffled.length}/${TARGET_TRACKS} tracks ` +
    `(target=${TARGET_TRACKS}, totalPicked=${totalPicked})`,
    perGenre,
  );

  if (!shuffled.length) {
    return {
      skipped: true,
      reason:  'no tracks matched the atmosphere screen for any selected genre',
      perGenrePool,
    };
  }

  const displayName = (bizName && String(bizName).trim()) || bizType;
  const name        = `${displayName} · ${dateSuffix()}`;
  const description = displayName;

  console.log(`v4 playlist: creating "${name}" on Rubin account`);
  const playlist = await postSpotify('create_playlist', { name, description });
  if (!playlist?.id) throw new Error('create_playlist returned no id');

  await postSpotify('add_tracks', {
    playlist_id: playlist.id,
    uris:        shuffled.map((id) => `spotify:track:${id}`),
  });

  return {
    skipped:      false,
    id:           playlist.id,
    url:          playlist.external_urls?.spotify || '',
    name,
    trackCount:   shuffled.length,
    requested:    TARGET_TRACKS,
    perGenre,
    perGenrePool,
  };
}
