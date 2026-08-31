import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function get(path) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
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

const KEEP = new Set([
  '7ipPPAWgaIbSywS5Y0YIBf',
  '5fLJVeHk9t8aqMtflSqHSq',
  '4FfL8tIikV60QAh00v3nXw',
  '0jNlBxk6RaVYrgbREOY1Zc',
  '0tzHVhoFXRMbEWc89EEIJ7',
]);
const DOOM = [
  '1wVXfJA0uiOCX0ohySHxan',
  '5lHRZlPhVlYuQ76C640252',
  '0pRtayTQifQyZhoc1tKfRv',
  '1lq2I8XFgXuTD6QLDlaTDD',
  '3gcZeTnpMILN1Jv0tQcTit',
  '0UWFIElyqzoJ2fOzZrmOqa',
  '1i5wFjjRtkFBe8smswJwen',
  '0Se53PlGky5P7pkteDgfKp',
  '3TpVQxQIKwQaB3S0ElRigQ',
];

// 1. All tracks in the 9 doomed playlists
const doomInList = DOOM.map(id => `"${id}"`).join(',');
const doomedPt = await get(`playlist_tracks?playlist_id=in.(${doomInList})&select=playlist_id,spotify_id`);
const doomedTrackIds = [...new Set(doomedPt.map(r => r.spotify_id))];
console.log(`Doomed playlists: ${DOOM.length}`);
console.log(`Total playlist_tracks rows to delete: ${doomedPt.length}`);
console.log(`Distinct spotify_ids in doomed playlists: ${doomedTrackIds.length}`);

// 2. Of those distinct spotify_ids, how many are ALSO in any kept playlist (any playlist NOT in DOOM)?
// Chunk the lookup — 3.7k ids can't go in one URL.
const CHUNK = 200;
const alsoElsewhereSet = new Set();
for (let i = 0; i < doomedTrackIds.length; i += CHUNK) {
  const slice = doomedTrackIds.slice(i, i + CHUNK);
  const inList = slice.map(id => `"${id}"`).join(',');
  const rows = await get(`playlist_tracks?spotify_id=in.(${inList})&select=playlist_id,spotify_id`);
  for (const r of rows) {
    if (!DOOM.includes(r.playlist_id)) alsoElsewhereSet.add(r.spotify_id);
  }
}
console.log(`\nOf ${doomedTrackIds.length} distinct doomed track ids:`);
console.log(`  ${alsoElsewhereSet.size} are ALSO present in kept playlists — KEEP their track_analyses row`);
console.log(`  ${doomedTrackIds.length - alsoElsewhereSet.size} are exclusive to doomed playlists — SAFE to delete from track_analyses`);

// 3. Of the deletable track_analyses rows, how many are status=ok vs error?
const deletableIds = doomedTrackIds.filter(id => !alsoElsewhereSet.has(id));
let okCount = 0, errCount = 0, otherCount = 0, missingCount = 0;
for (let i = 0; i < deletableIds.length; i += CHUNK) {
  const slice = deletableIds.slice(i, i + CHUNK);
  const inList = slice.map(id => `"${id}"`).join(',');
  const rows = await get(`track_analyses?spotify_id=in.(${inList})&select=spotify_id,status`);
  const seen = new Set(rows.map(r => r.spotify_id));
  for (const r of rows) {
    if (r.status === 'ok') okCount++;
    else if (r.status === 'error') errCount++;
    else otherCount++;
  }
  for (const id of slice) if (!seen.has(id)) missingCount++;
}
console.log(`\ntrack_analyses status of the ${deletableIds.length} deletable ids:`);
console.log(`  ok:      ${okCount}`);
console.log(`  error:   ${errCount}`);
console.log(`  other:   ${otherCount}`);
console.log(`  missing (never analyzed): ${missingCount}`);
