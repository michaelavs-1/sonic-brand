// Stage 3: pull tracks from the source playlists assigned to each energy slot,
// and create two public Spotify playlists on Michael's account.
//
// Input:  assignment from assignEnergyRows() + the matched bizType (string)
// Output: { skipped, calm, energetic } — with URLs on success, or skipped=true
//         when the assignment is a single shared row (waiting on audio-features API).
//
// Talks to /api/new/spotify.

const TARGET_TRACKS         = 30;
const MAX_SOURCE_PLAYLISTS  = 5;
const PULL_CONCURRENCY      = 4;

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickRandomSubset(arr, n) {
  if (arr.length <= n) return arr.slice();
  return shuffle(arr).slice(0, n);
}

async function postSpotify(action, body) {
  const r = await fetch('/api/new/spotify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || r.statusText;
    throw new Error(`spotify ${action} ${r.status}: ${msg} | body=${JSON.stringify(data)}`);
  }
  return data;
}

async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  const n = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function fetchTrackIdsFromPlaylist(playlistId) {
  const tryFetch = async (offset) => {
    const data = await postSpotify('get_playlist_tracks', {
      playlist_id: playlistId,
      offset,
      limit: 50,
      fields: 'items(track(id))',
    });
    return (data.items || []).map(it => it?.track?.id).filter(Boolean);
  };
  const offset = Math.floor(Math.random() * 100);
  let ids = await tryFetch(offset);
  if (!ids.length && offset > 0) ids = await tryFetch(0);
  return ids;
}

async function pickTracksForRow(row) {
  const playlists = Array.isArray(row?.playlists) ? row.playlists : [];
  if (!playlists.length) return [];

  const selected = pickRandomSubset(playlists, MAX_SOURCE_PLAYLISTS);
  const tasks = selected.map(p => () => fetchTrackIdsFromPlaylist(p.id).catch(() => []));
  const perPlaylist = await runWithConcurrency(tasks, PULL_CONCURRENCY);

  const unique = [...new Set(perPlaylist.flat())];
  return shuffle(unique).slice(0, TARGET_TRACKS);
}

function dateSuffix() {
  const d = new Date();
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

async function createAndFillPlaylist(name, description, trackIds) {
  if (!trackIds.length) throw new Error(`No tracks to add for playlist "${name}"`);
  const playlist = await postSpotify('create_playlist', { name, description });
  if (!playlist?.id) throw new Error(`create_playlist returned no id (${name})`);
  await postSpotify('add_tracks', {
    playlist_id: playlist.id,
    uris: trackIds.map(id => `spotify:track:${id}`),
  });
  return {
    id: playlist.id,
    url: playlist.external_urls?.spotify || '',
    trackCount: trackIds.length,
  };
}

export async function buildPlaylists(assignment, bizType, bizName = null) {
  if (!assignment || !bizType) throw new Error('buildPlaylists: missing assignment or bizType');
  const displayName = (typeof bizName === 'string' && bizName.trim()) ? bizName.trim() : bizType;

  if (assignment.isCalmAndEnergeticFromSameRow) {
    return {
      skipped: true,
      reason: 'one-row biz type — energy splitting requires audio-features API (not implemented yet)',
      calm: null,
      energetic: null,
    };
  }

  const [calmIds, energeticIds] = await Promise.all([
    pickTracksForRow(assignment.calm),
    pickTracksForRow(assignment.energetic),
  ]);

  const ds = dateSuffix();
  const calm = await createAndFillPlaylist(
    `${displayName} · רגוע · ${ds}`,
    displayName,
    calmIds,
  );
  const energetic = await createAndFillPlaylist(
    `${displayName} · אנרגטי · ${ds}`,
    displayName,
    energeticIds,
  );

  return { skipped: false, calm, energetic };
}
