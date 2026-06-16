// One-off counting script: walks all playlists in the business-type rows
// whose H column (genres2) is populated, dedupes the union of their track
// IDs, and prints unique-track totals. No RapidAPI calls. No writes besides
// the optional output JSON listing the unique IDs (for the Phase 3 batch).
//
// Mirrors the v4 preview-builder's filtering: market=IL + drop tracks Spotify
// reports as unplayable, so the count reflects what the runtime would actually
// preview.
//
// Run, in two terminals:
//   1) vercel dev                                      (serves /api/v4/* on :3000)
//   2) node tests/.test-count-unique-tracks.mjs        (this script)
//
// Optional env vars:
//   DEV_BASE=https://sonic-brand.vercel.app    hit prod instead of localhost
//   OUT_PATH=.unique-track-ids.json            override output file path
//   PLAYLIST_CONCURRENCY=4                     parallel playlist fetches

import fs from 'node:fs/promises';

const DEV_BASE             = process.env.DEV_BASE || 'http://localhost:3000';
const OUT_PATH             = process.env.OUT_PATH || '.unique-track-ids.json';
const PLAYLIST_CONCURRENCY = Number(process.env.PLAYLIST_CONCURRENCY || 4);

const PAGE_LIMIT = 100;  // Spotify max per page on /playlists/{id}/tracks
const MARKET     = 'IL';
const FIELDS     = 'items(track(id,is_playable))';

const norm = (s) => String(s || '').trim().toLowerCase();

async function getJSON(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GET ${url} ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function fetchPlaylistTrackIds(playlistId) {
  const ids = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${DEV_BASE}/api/v4/spotify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:      'get_playlist_tracks',
        playlist_id: playlistId,
        offset,
        limit:       PAGE_LIMIT,
        fields:      FIELDS,
        market:      MARKET,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn(`  ! playlist ${playlistId} offset=${offset} -> HTTP ${r.status}: ${data?.error?.message || data?.error || r.statusText}`);
      return ids;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    for (const it of items) {
      const t = it?.track;
      if (t && t.id && t.is_playable !== false) ids.push(t.id);
    }
    if (items.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
  return ids;
}

async function processInPool(items, concurrency, worker) {
  let next = 0;
  const lanes = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

async function main() {
  console.log(`Base: ${DEV_BASE}`);
  console.log('Fetching Tab 1 (databox)...');
  const tab1     = await getJSON(`${DEV_BASE}/api/v4/databox?fresh=1`);
  const tab1Rows = tab1.rows || [];
  const active   = tab1Rows.filter((r) => Array.isArray(r.genres2) && r.genres2.length > 0);
  console.log(`  Tab 1 rows total:                                 ${tab1Rows.length}`);
  console.log(`  Tab 1 rows with non-empty genres2 (column H):     ${active.length}`);

  const wantedGenres = new Set();
  for (const r of active) {
    for (const g of (r.genres1 || [])) wantedGenres.add(norm(g));
    for (const g of (r.genres2 || [])) wantedGenres.add(norm(g));
  }
  console.log(`  Unique genres across G u H of active rows:        ${wantedGenres.size}`);

  console.log('Fetching Tab 2 (databox-genres)...');
  const tab2     = await getJSON(`${DEV_BASE}/api/v4/databox-genres?fresh=1`);
  const tab2Rows = tab2.rows || [];
  const matching = tab2Rows.filter((r) => wantedGenres.has(norm(r.genre)));
  console.log(`  Tab 2 rows matching wanted genres:                ${matching.length} / ${tab2Rows.length}`);

  const seenGenres = new Set(matching.map((r) => norm(r.genre)));
  const missing    = [...wantedGenres].filter((g) => !seenGenres.has(g));
  if (missing.length) {
    console.log(`  Wanted genres NOT found in Tab 2 (${missing.length}): ${missing.join(', ')}`);
  }

  const rawPlaylists = [];
  for (const r of matching) {
    for (const pl of (r.playlists || [])) {
      if (pl?.id) rawPlaylists.push({ genre: r.genre, id: pl.id });
    }
  }
  const uniquePlaylistIds = [...new Set(rawPlaylists.map((p) => p.id))];
  console.log(`  Playlist refs (raw, with dupes across genre rows): ${rawPlaylists.length}`);
  console.log(`  Unique playlist IDs to scan:                      ${uniquePlaylistIds.length}`);

  console.log(`\nScanning playlists (concurrency=${PLAYLIST_CONCURRENCY})...`);
  const t0           = Date.now();
  const uniqueTracks = new Set();
  let totalSlots     = 0;
  let done           = 0;

  await processInPool(uniquePlaylistIds, PLAYLIST_CONCURRENCY, async (playlistId) => {
    const ids   = await fetchPlaylistTrackIds(playlistId);
    totalSlots += ids.length;
    for (const id of ids) uniqueTracks.add(id);
    done++;
    if (done % 25 === 0 || done === uniquePlaylistIds.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${done}/${uniquePlaylistIds.length} playlists | raw slots: ${totalSlots} | unique: ${uniqueTracks.size} | ${elapsed}s`);
    }
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n=== RESULT ===');
  console.log(`  Active Tab 1 rows (H populated):     ${active.length}`);
  console.log(`  Unique genres (G u H):               ${wantedGenres.size}`);
  console.log(`  Matching Tab 2 rows:                 ${matching.length}`);
  console.log(`  Unique playlists scanned:            ${uniquePlaylistIds.length}`);
  console.log(`  Total raw track slots:               ${totalSlots}`);
  console.log(`  Unique playable track IDs:           ${uniqueTracks.size}`);
  if (uniquePlaylistIds.length) {
    console.log(`  Avg tracks per playlist (raw):       ${(totalSlots / uniquePlaylistIds.length).toFixed(1)}`);
  }
  if (totalSlots) {
    console.log(`  Dedup factor:                        ${((uniqueTracks.size / totalSlots) * 100).toFixed(1)}% unique`);
  }
  console.log(`  Scan time:                           ${elapsed}s`);

  await fs.writeFile(OUT_PATH, JSON.stringify([...uniqueTracks], null, 0));
  console.log(`\nWrote ${uniqueTracks.size} unique IDs to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
