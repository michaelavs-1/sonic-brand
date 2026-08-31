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

const CHUNK = 200;
const inList = (arr) => arr.map(x => `"${x}"`).join(',');

console.log('=== STEP 1: Preflight — collect brit funk footprint ===');
const bfPg = await paged(`playlist_genres?genre=eq.brit%20funk&select=playlist_id,position_in_genre`);
const bfPids = bfPg.map(r => r.playlist_id);
console.log(`  playlist_genres brit funk rows: ${bfPg.length}`);
for (const r of bfPg) console.log(`    ${r.playlist_id}  (pos ${r.position_in_genre})`);

if (bfPids.length === 0) {
  console.log('\nNothing to do — brit funk has no playlist_genres rows.');
  process.exit(0);
}

const bfPt = await paged(`playlist_tracks?playlist_id=in.(${inList(bfPids)})&select=playlist_id,spotify_id`);
const bfTrackIds = [...new Set(bfPt.map(r => r.spotify_id))];
console.log(`  playlist_tracks rows in brit funk playlists: ${bfPt.length}`);
console.log(`  distinct spotify_ids: ${bfTrackIds.length}`);

// Which of those tracks are ALSO in playlists NOT in bfPids?
const alsoElsewhere = new Set();
for (let i = 0; i < bfTrackIds.length; i += CHUNK) {
  const slice = bfTrackIds.slice(i, i + CHUNK);
  const rows = await paged(`playlist_tracks?spotify_id=in.(${inList(slice)})&select=playlist_id,spotify_id`);
  for (const r of rows) {
    if (!bfPids.includes(r.playlist_id)) alsoElsewhere.add(r.spotify_id);
  }
}
const deletableTrackIds = bfTrackIds.filter(id => !alsoElsewhere.has(id));
console.log(`  → deletable from track_analyses: ${deletableTrackIds.length}`);
console.log(`  → keep (also in other genre's playlists): ${alsoElsewhere.size}`);

// biztype_genres
const btBf = await paged(`biztype_genres?genre=eq.brit%20funk&select=business_type,column_letter,position_in_column`);
console.log(`  biztype_genres brit funk rows: ${btBf.length}`);
for (const r of btBf) console.log(`    ${r.business_type} (${r.column_letter}${r.position_in_column})`);

console.log('\n=== STEP 2: DELETE track_analyses for exclusive-to-brit-funk spotify_ids ===');
let taDeleted = 0;
for (let i = 0; i < deletableTrackIds.length; i += CHUNK) {
  const slice = deletableTrackIds.slice(i, i + CHUNK);
  taDeleted += await del(`track_analyses?spotify_id=in.(${inList(slice)})`);
}
console.log(`  deleted ${taDeleted} track_analyses rows`);

console.log('\n=== STEP 3: DELETE playlist_tracks for all brit funk playlists ===');
const ptDeleted = await del(`playlist_tracks?playlist_id=in.(${inList(bfPids)})`);
console.log(`  deleted ${ptDeleted} playlist_tracks rows`);

console.log('\n=== STEP 4: DELETE playlist_genres brit funk rows ===');
const pgDeleted = await del(`playlist_genres?genre=eq.brit%20funk`);
console.log(`  deleted ${pgDeleted} playlist_genres rows`);

console.log('\n=== STEP 5: DELETE biztype_genres brit funk rows (harmless — v6 doesn\'t read this table) ===');
const btDeleted = await del(`biztype_genres?genre=eq.brit%20funk`);
console.log(`  deleted ${btDeleted} biztype_genres rows`);

console.log('\n=== VERIFY ===');
const pgLeft = await paged(`playlist_genres?genre=eq.brit%20funk&select=playlist_id`);
const btLeft = await paged(`biztype_genres?genre=eq.brit%20funk&select=business_type`);
console.log(`  playlist_genres brit funk remaining: ${pgLeft.length}`);
console.log(`  biztype_genres  brit funk remaining: ${btLeft.length}`);

console.log('\nDONE.');
