// Genre status with ORDERED pagination + self-verification.
// Fixes the drift the unordered dry-run-orphans has been showing.

import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Ordered paginated fetch. `orderCol` MUST be a column with a unique value
// per row (or at least stable ordering) — this is what unordered pagination
// was missing in dry-run-orphans.
async function pagedOrdered(path, orderCol) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  const sep = path.includes('?') ? '&' : '?';
  while (true) {
    const url = `${SB}/rest/v1/${path}${sep}order=${orderCol}.asc`;
    const r = await fetch(url, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok && r.status !== 206) throw new Error(`${path} ${r.status}: ${await r.text()}`);
    const chunk = await r.json();
    if (chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < PAGE) break;
    from += chunk.length;
  }
  return out;
}

// Exact row count via Content-Range (independent of pagination) — used to
// verify pagination didn't miss anything.
async function exactCount(table) {
  const r = await fetch(`${SB}/rest/v1/${table}?select=spotify_id`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const range = r.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// Per-chunk IN query — used to verify "orphan" candidates truly aren't in
// track_analyses (belt-and-suspenders against pagination drift).
async function chunkExists(table, ids) {
  const CHUNK = 200;
  const found = new Set();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const inList = slice.map(x => `"${x}"`).join(',');
    const r = await fetch(`${SB}/rest/v1/${table}?spotify_id=in.(${inList})&select=spotify_id`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    const rows = await r.json();
    for (const row of rows) found.add(row.spotify_id);
  }
  return found;
}

console.log('Fetching with ordered pagination…');
const [pgRows, ptRows, taRows, promptGenres, pgCount, ptCount, taCount] = await Promise.all([
  // playlist_genres uses composite PK-ish (playlist_id, genre) — order by both for stability
  pagedOrdered('playlist_genres?select=playlist_id,genre', 'playlist_id'),
  pagedOrdered('playlist_tracks?select=playlist_id,spotify_id', 'spotify_id'),
  pagedOrdered('track_analyses?select=spotify_id,status', 'spotify_id'),
  import('./v6/generation/genre-list.js').then(m => new Set(m.GENRES.map(g => g.toLowerCase()))),
  exactCount('playlist_genres'),
  exactCount('playlist_tracks'),
  exactCount('track_analyses'),
]);

// Sanity: our fetched counts vs exact counts
console.log(`  playlist_genres: fetched=${pgRows.length}  exact=${pgCount}  ${pgRows.length === pgCount ? 'OK' : 'MISMATCH'}`);
console.log(`  playlist_tracks: fetched=${ptRows.length}  exact=${ptCount}  ${ptRows.length === ptCount ? 'OK' : 'MISMATCH'}`);
console.log(`  track_analyses : fetched=${taRows.length}  exact=${taCount}  ${taRows.length === taCount ? 'OK' : 'MISMATCH'}`);

// De-duplicate track_analyses just in case pagination somehow doubled a row
const taById = new Map();
for (const r of taRows) taById.set(r.spotify_id, r.status);
console.log(`  track_analyses distinct spotify_ids: ${taById.size}`);
const okSet = new Set([...taById.entries()].filter(([, s]) => s === 'ok').map(([id]) => id));
const anyStatusSet = new Set(taById.keys());

// Verify: sample 50 candidate orphans and 50 cached, check via chunked IN query
const allPtIds = [...new Set(ptRows.map(r => r.spotify_id))];
const orphanCandidates = allPtIds.filter(id => !anyStatusSet.has(id));
const cachedCandidates = allPtIds.filter(id =>  anyStatusSet.has(id));
console.log(`\nCandidate orphan count from paginated diff: ${orphanCandidates.length}`);
console.log(`Candidate cached count from paginated diff : ${cachedCandidates.length}`);

const orphanSample = orphanCandidates.slice(0, 50);
const cachedSample = cachedCandidates.slice(0, 50);
const orphanCheck = await chunkExists('track_analyses', orphanSample);
const cachedCheck = await chunkExists('track_analyses', cachedSample);
console.log(`\nVerification (via single-request IN queries):`);
console.log(`  of ${orphanSample.length} sampled orphans:  ${orphanCheck.size} actually EXIST in track_analyses (should be 0)`);
console.log(`  of ${cachedSample.length} sampled cached :  ${cachedCheck.size} actually EXIST in track_analyses (should be 50)`);

const orphanFalse = orphanCheck.size;
const cachedFalse = cachedSample.length - cachedCheck.size;
const trustworthy = orphanFalse === 0 && cachedFalse === 0;
console.log(`\nRESULT: ${trustworthy ? '✅ paginated diff is verified — proceeding with per-genre report' : '⚠️  DRIFT DETECTED — paginated diff still wrong, results below are UNRELIABLE'}`);

if (!trustworthy) {
  console.log(`\nDrift detected. Re-checking every candidate orphan against track_analyses via IN queries…`);
  const trueOrphansSet = new Set(orphanCandidates);
  const actuallyInTa = await chunkExists('track_analyses', orphanCandidates);
  for (const id of actuallyInTa) trueOrphansSet.delete(id);
  console.log(`  after full re-check: ${trueOrphansSet.size} true orphans (of ${orphanCandidates.length} candidates)`);
  // Rebuild anyStatusSet to include the falsely-orphan tracks
  for (const id of actuallyInTa) anyStatusSet.add(id);
  // We don't know the status of the newly-added; fetch it
  const missingStatus = [...actuallyInTa].filter(id => !taById.has(id));
  if (missingStatus.length) {
    console.log(`  fetching status for ${missingStatus.length} newly-found rows…`);
    const CHUNK = 200;
    for (let i = 0; i < missingStatus.length; i += CHUNK) {
      const slice = missingStatus.slice(i, i + CHUNK);
      const inList = slice.map(x => `"${x}"`).join(',');
      const r = await fetch(`${SB}/rest/v1/track_analyses?spotify_id=in.(${inList})&select=spotify_id,status`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      });
      const rows = await r.json();
      for (const row of rows) {
        taById.set(row.spotify_id, row.status);
        if (row.status === 'ok') okSet.add(row.spotify_id);
      }
    }
  }
}

// Per-genre report — using the verified sets
const tracksByPlaylist = new Map();
for (const r of ptRows) {
  if (!tracksByPlaylist.has(r.playlist_id)) tracksByPlaylist.set(r.playlist_id, new Set());
  tracksByPlaylist.get(r.playlist_id).add(r.spotify_id);
}
const playlistsByGenre = new Map();
for (const r of pgRows) {
  if (!playlistsByGenre.has(r.genre)) playlistsByGenre.set(r.genre, new Set());
  playlistsByGenre.get(r.genre).add(r.playlist_id);
}

const rows = [];
for (const [genre, pids] of playlistsByGenre) {
  const okTracks = new Set();
  const orphanTracks = new Set();
  for (const pid of pids) {
    for (const sid of (tracksByPlaylist.get(pid) || [])) {
      if (okSet.has(sid)) okTracks.add(sid);
      if (!anyStatusSet.has(sid)) orphanTracks.add(sid);
    }
  }
  rows.push({ genre, ok: okTracks.size, orphans: orphanTracks.size, inPrompt: promptGenres.has(genre) });
}
rows.sort((a, b) => b.ok - a.ok || a.genre.localeCompare(b.genre));

console.log('\n=== Per-genre report ===');
console.log('genre'.padEnd(30) + '     ok  orphans   in prompt');
console.log('-'.repeat(64));
for (const r of rows) {
  console.log(
    r.genre.padEnd(30) +
    String(r.ok).padStart(7) +
    String(r.orphans).padStart(9) +
    '   ' + (r.inPrompt ? 'yes' : 'NO ⚠️')
  );
}
console.log('-'.repeat(64));
console.log(`Total DB genres: ${rows.length}`);
console.log(`Total distinct ok tracks: ${okSet.size}`);
console.log(`Total distinct orphans (across DB): ${[...new Set(ptRows.map(r => r.spotify_id))].filter(id => !anyStatusSet.has(id)).length}`);

const missingFromPrompt = rows.filter(r => !r.inPrompt).map(r => r.genre);
console.log(`DB genres NOT in prompt list: ${missingFromPrompt.length ? missingFromPrompt.join(', ') : '(none)'}`);
const dbGenres = new Set(rows.map(r => r.genre));
const promptOnly = [...promptGenres].filter(g => !dbGenres.has(g));
console.log(`Prompt genres NOT in DB: ${promptOnly.length ? promptOnly.join(', ') : '(none)'}`);
