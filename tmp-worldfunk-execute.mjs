import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HDRS = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function paged(path) {
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

async function del(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'DELETE', headers: HDRS });
  if (!r.ok) throw new Error(`DELETE ${path} ${r.status}: ${await r.text()}`);
  const rows = await r.json().catch(() => []);
  return rows.length;
}

async function insert(table, rows) {
  const r = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST',
    headers: HDRS,
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`INSERT ${table} ${r.status}: ${await r.text()}`);
  return (await r.json()).length;
}

const KEEP_MAP = {
  '7ipPPAWgaIbSywS5Y0YIBf': { genre: 'afro funk',   position: 9  },
  '5fLJVeHk9t8aqMtflSqHSq': { genre: 'arabic funk', position: 10 },
  '4FfL8tIikV60QAh00v3nXw': { genre: 'greek funk',  position: 1  },
  '0jNlBxk6RaVYrgbREOY1Zc': { genre: 'greek funk',  position: 2  },
  '0tzHVhoFXRMbEWc89EEIJ7': { genre: 'ethio-jazz',  position: 13 },
};
const KEEP_IDS = Object.keys(KEEP_MAP);
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

const CHUNK = 200;
const inList = (arr) => arr.map(x => `"${x}"`).join(',');

console.log('=== STEP 1: Compute deletable-from-track_analyses set ===');
const doomInList = inList(DOOM);
const doomedPt = await paged(`playlist_tracks?playlist_id=in.(${doomInList})&select=playlist_id,spotify_id`);
const doomedTrackIds = [...new Set(doomedPt.map(r => r.spotify_id))];
const alsoElsewhere = new Set();
for (let i = 0; i < doomedTrackIds.length; i += CHUNK) {
  const slice = doomedTrackIds.slice(i, i + CHUNK);
  const rows = await paged(`playlist_tracks?spotify_id=in.(${inList(slice)})&select=playlist_id,spotify_id`);
  for (const r of rows) {
    if (!DOOM.includes(r.playlist_id)) alsoElsewhere.add(r.spotify_id);
  }
}
const deletableTrackIds = doomedTrackIds.filter(id => !alsoElsewhere.has(id));
console.log(`  playlist_tracks rows in doomed playlists: ${doomedPt.length}`);
console.log(`  distinct doomed spotify_ids: ${doomedTrackIds.length}`);
console.log(`  → deletable from track_analyses: ${deletableTrackIds.length}`);
console.log(`  → keep (also in kept playlists): ${alsoElsewhere.size}`);

console.log('\n=== STEP 2: DELETE track_analyses for exclusive-to-doomed spotify_ids ===');
let taDeleted = 0;
for (let i = 0; i < deletableTrackIds.length; i += CHUNK) {
  const slice = deletableTrackIds.slice(i, i + CHUNK);
  taDeleted += await del(`track_analyses?spotify_id=in.(${inList(slice)})`);
}
console.log(`  deleted ${taDeleted} track_analyses rows`);

console.log('\n=== STEP 3: DELETE playlist_tracks for all 9 doomed playlists ===');
const ptDeleted = await del(`playlist_tracks?playlist_id=in.(${doomInList})`);
console.log(`  deleted ${ptDeleted} playlist_tracks rows`);

console.log('\n=== STEP 4: DELETE playlist_genres for all 9 doomed playlists (their world funk rows) ===');
const pgDoomDel = await del(`playlist_genres?playlist_id=in.(${doomInList})&genre=eq.world%20funk`);
console.log(`  deleted ${pgDoomDel} playlist_genres rows`);

console.log('\n=== STEP 5: INSERT re-tag playlist_genres for the 5 kept playlists ===');
const insertRows = KEEP_IDS.map(pid => ({
  playlist_id: pid,
  genre: KEEP_MAP[pid].genre,
  position_in_genre: KEEP_MAP[pid].position,
}));
const pgInserted = await insert('playlist_genres', insertRows);
console.log(`  inserted ${pgInserted} playlist_genres rows`);
for (const r of insertRows) console.log(`    ${r.playlist_id} → ${r.genre} (pos ${r.position_in_genre})`);

console.log('\n=== STEP 6: DELETE world funk playlist_genres rows for the 5 renamed playlists ===');
const keepInList = inList(KEEP_IDS);
const pgKeepDel = await del(`playlist_genres?playlist_id=in.(${keepInList})&genre=eq.world%20funk`);
console.log(`  deleted ${pgKeepDel} playlist_genres rows`);

console.log('\n=== STEP 7: DELETE biztype_genres rows referencing world funk ===');
const btDeleted = await del(`biztype_genres?genre=eq.world%20funk`);
console.log(`  deleted ${btDeleted} biztype_genres rows`);

console.log('\n=== VERIFY: world funk should be 0 everywhere ===');
const pgLeft = await paged(`playlist_genres?genre=eq.world%20funk&select=playlist_id`);
const btLeft = await paged(`biztype_genres?genre=eq.world%20funk&select=business_type`);
console.log(`  playlist_genres world funk remaining: ${pgLeft.length}`);
console.log(`  biztype_genres  world funk remaining: ${btLeft.length}`);

console.log('\n=== VERIFY: new/updated genre counts ===');
for (const g of ['afro funk', 'arabic funk', 'greek funk', 'ethio-jazz']) {
  const rows = await paged(`playlist_genres?genre=eq.${encodeURIComponent(g)}&select=playlist_id`);
  console.log(`  ${g}: ${rows.length} playlists`);
}

console.log('\nDONE.');
