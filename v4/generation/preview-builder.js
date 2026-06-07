// v4 preview-track resolver.
// For each input genre, finds its Tab 2 row (case-insensitive, trim), picks a
// random playlist, samples tracks from it, optionally runs each through the
// track-analysis API to filter by the user's atmosphere-derived `screenParams`,
// and returns one passing random track per resolvable genre.
//
// Network:
//   POST /api/v4/spotify         (Client Credentials via Michael's app)
//   POST /api/v4/track-analysis  (RapidAPI — only when screenParams is non-empty)

import { evaluateTrack, activeParams, PARAMS } from './atmosphere-params.js?v=04062026f';

const FIELDS = 'items(track(id,name,artists(name),album(name),is_playable))';
const MARKET = 'IL';

// Cap the number of tracks we run track-analysis on per playlist attempt.
// Spotify page returns up to 50; analyzing all 50 burns RapidAPI quota fast.
const ANALYSIS_SAMPLE_SIZE = 20;

// Screen the sample in batches of this size, returning as soon as any batch
// has a passer. We only need ONE passing track per genre, so analyzing 20 in
// parallel just to throw 19 away is wasteful.
const SCREEN_BATCH_SIZE = 3;

// Global rate limit on RapidAPI track-analysis calls. The current plan allows
// 5 starts per second; we pace request starts at exactly that to use the full
// quota without ever crossing it (a plain concurrency cap could undershoot or
// overshoot depending on call latency). Calls beyond the rate simply wait
// their slot in a 200ms-spaced queue, no 429s.
const ANALYSIS_RATE_PER_SEC = 5;

const _analysisRateLimiter = (() => {
  const intervalMs = 1000 / ANALYSIS_RATE_PER_SEC; // 200ms
  let nextSlot = 0;
  return {
    async wait() {
      const now     = Date.now();
      const startAt = Math.max(now, nextSlot);
      nextSlot      = startAt + intervalMs;
      const delay   = startAt - now;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    },
  };
})();

// How many playlists we try WITH the atmosphere screen before giving up on
// screening. After this many fails we fall back to picking from an unscreened
// playlist page so the genre is never dropped. RapidAPI cost ceiling per genre
// is MAX_SCREENED_ATTEMPTS × ANALYSIS_SAMPLE_SIZE.
const MAX_SCREENED_ATTEMPTS = 2;

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildGenreIndex(tab2Rows) {
  const idx = new Map();
  for (const r of tab2Rows) {
    if (!r?.genre) continue;
    idx.set(normalize(r.genre), r);
  }
  return idx;
}

async function fetchOnePlaylistPage(playlistId, offset) {
  const r = await fetch('/api/v4/spotify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'get_playlist_tracks',
      playlist_id: playlistId,
      offset,
      limit: 50,
      fields: FIELDS,
      market: MARKET,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`spotify ${r.status}: ${data?.error?.message || data?.error || r.statusText}`);
  // Drop tracks Spotify reports as unplayable in the configured market.
  return (data.items || [])
    .map(it => it?.track)
    .filter(t => t && t.id && t.is_playable !== false);
}

async function analyzeTrack(spotifyId) {
  await _analysisRateLimiter.wait();
  try {
    const r = await fetch('/api/v4/track-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'analyze_track', spotify_id: spotifyId }),
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    if (data.found === false) return null;
    return data;
  } catch {
    return null;
  }
}

function fmtArtists(t) {
  return (t.artists || []).map(a => a.name).filter(Boolean).join(', ');
}

function fmtFeatures(analysis) {
  if (!analysis) return '(no analysis)';
  return PARAMS
    .map(p => (typeof analysis[p] === 'number' ? `${p}=${analysis[p]}` : null))
    .filter(Boolean)
    .join('  ');
}

async function screenTracks(tracks, screenParams, genre, playlistId) {
  if (!activeParams(screenParams).length) return tracks;
  const sample = shuffleInPlace(tracks.slice()).slice(0, ANALYSIS_SAMPLE_SIZE);
  const prefix = `[${genre} / ${playlistId}]`;
  console.log(`${prefix} screening up to ${sample.length} of ${tracks.length} tracks (early-exit on first pass)`);

  let analyzedCount = 0;
  for (let i = 0; i < sample.length; i += SCREEN_BATCH_SIZE) {
    const batch = sample.slice(i, i + SCREEN_BATCH_SIZE);
    const results = await Promise.all(batch.map(async (t) => {
      const a   = await analyzeTrack(t.id);
      const res = evaluateTrack(a, screenParams);
      const mark   = res.pass ? '✓ PASS' : '✗ FAIL';
      const reason = res.pass ? ''       : ` | reason: ${res.reason}`;
      console.log(`${prefix} ${mark}  "${t.name}" — ${fmtArtists(t)}  | ${fmtFeatures(a)}${reason}`);
      return res.pass ? t : null;
    }));
    analyzedCount += batch.length;
    const passers = results.filter(Boolean);
    if (passers.length) {
      console.log(`${prefix} → found ${passers.length} pass(es) after ${analyzedCount}/${sample.length} analyses — stopping`);
      return passers;
    }
  }
  console.log(`${prefix} → 0 / ${analyzedCount} passed (sample exhausted)`);
  return [];
}

async function tryPlaylist(playlistId, screenParams, genre) {
  const offset = Math.floor(Math.random() * 100);
  try {
    let tracks = await fetchOnePlaylistPage(playlistId, offset);
    if (!tracks.length && offset > 0) {
      tracks = await fetchOnePlaylistPage(playlistId, 0);
    }
    if (!tracks.length) return { reason: 'empty' };
    tracks = await screenTracks(tracks, screenParams, genre, playlistId);
    if (!tracks.length) return { reason: 'all filtered' };
    return { tracks };
  } catch (err) {
    return { reason: err.message };
  }
}

// Walk this genre's playlists in random order.
// - First MAX_SCREENED_ATTEMPTS playlists are tried WITH the atmosphere filter.
// - If none of those yield a passing track, switch to unscreened mode: take any
//   non-empty playlist page and pick a random track. This guarantees a card per
//   genre rather than dropping incompatible combos (e.g. punk × danceable).
// - Only returns null if every single playlist for the genre is unreachable.
async function resolveOneGenre(genre, tab2Row, screenParams) {
  const playlists = Array.isArray(tab2Row?.playlists) ? tab2Row.playlists : [];
  if (!playlists.length) return null;

  const order            = shuffleInPlace(playlists.slice());
  const screening        = activeParams(screenParams).length > 0;
  let   announcedDropout = false;

  for (let i = 0; i < order.length; i++) {
    const pl                  = order[i];
    const useScreen           = screening && i < MAX_SCREENED_ATTEMPTS;

    if (screening && !useScreen && !announcedDropout) {
      console.warn(`[${genre}] screen exhausted after ${MAX_SCREENED_ATTEMPTS} attempts — falling back to unscreened pick`);
      announcedDropout = true;
    }

    const result = await tryPlaylist(pl.id, useScreen ? screenParams : {}, genre);
    if (result.tracks) {
      const t  = pickRandom(result.tracks);
      const ts = useScreen ? 'PICKED' : 'PICKED (fallback, no screening)';
      console.log(`[${genre}] ${ts}  "${t.name}" — ${(t.artists || []).map(a => a.name).filter(Boolean).join(', ')}  (id=${t.id})`);
      return {
        genre,
        trackId: t.id,
        name:    t.name || '',
        artists: (t.artists || []).map(a => a.name).filter(Boolean),
        album:   t.album?.name || '',
      };
    }
    console.warn(`preview: genre "${genre}" / playlist ${pl.id} failed (${result.reason}) — trying next`);
  }
  return null;
}

export async function buildGenrePreviews(genres, tab2Rows, screenParams = {}) {
  if (!Array.isArray(genres) || !genres.length) return [];
  const idx = buildGenreIndex(tab2Rows);

  const active = activeParams(screenParams);
  if (active.length) {
    const windows = active.map(p => `${p}=[${screenParams[p].join(',')}]`).join('  ');
    console.log(`v4 preview: screening ON  ${windows}`);
  } else {
    console.log('v4 preview: screening OFF (no atmosphere selected, or no constrained params)');
  }

  const tasks = genres.map(async (genre) => {
    const row = idx.get(normalize(genre));
    if (!row) {
      return { genre, preview: null, reason: 'not in Tab 2' };
    }
    if (!row.playlists?.length) {
      return { genre, preview: null, reason: 'Tab 2 row has no playlists' };
    }
    const preview = await resolveOneGenre(genre, row, screenParams);
    if (preview) return { genre, preview };
    return { genre, preview: null, reason: `all ${row.playlists.length} Tab 2 playlists exhausted` };
  });

  const results = await Promise.all(tasks);
  const previews = results.filter(r => r.preview).map(r => r.preview);
  const dropped  = results.filter(r => !r.preview);
  if (dropped.length) {
    console.warn(
      `v4 preview: resolved ${previews.length}/${results.length} genres. Dropped: ` +
      dropped.map(d => `"${d.genre}" (${d.reason})`).join(', ')
    );
  } else {
    console.log(`v4 preview: resolved all ${previews.length} genres`);
  }
  return previews;
}
