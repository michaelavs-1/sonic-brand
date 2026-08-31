import fs from 'node:fs';

const envText = fs.readFileSync('d:/Projects/algorithm/sonic-brand/.env.local', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

const TARGETS = {
  '7ipPPAWgaIbSywS5Y0YIBf': 'afro funk',
  '5fLJVeHk9t8aqMtflSqHSq': 'arabic funk',
  '4FfL8tIikV60QAh00v3nXw': 'greek funk',
  '0jNlBxk6RaVYrgbREOY1Zc': 'greek funk',
  '0tzHVhoFXRMbEWc89EEIJ7': 'ethio-jazz',
};
const wfPids = Object.keys(TARGETS);

// All world funk playlists currently in DB
const allWorldFunk = await get(`playlist_genres?genre=eq.world%20funk&select=playlist_id,position_in_genre&order=position_in_genre.asc`);
console.log(`\n=== Current 'world funk' pg rows in DB: ${allWorldFunk.length} ===`);
for (const r of allWorldFunk) console.log(`  ${r.playlist_id}  (position ${r.position_in_genre})`);

// Whether the 5 named pids currently have genre tags under their TARGET genre
const inList = wfPids.map(id => `"${id}"`).join(',');
const allPgForFive = await get(`playlist_genres?playlist_id=in.(${inList})&select=playlist_id,genre,position_in_genre&order=playlist_id.asc`);
console.log(`\n=== All current genre tags on the 5 named playlists ===`);
for (const r of allPgForFive) console.log(`  ${r.playlist_id}  →  ${r.genre}  (pos ${r.position_in_genre})`);

// Any of these target playlists already tagged under their new target?
console.log(`\n=== Preflight: target-genre collisions ===`);
for (const pid of wfPids) {
  const target = TARGETS[pid];
  const existing = allPgForFive.filter(r => r.playlist_id === pid && r.genre === target);
  if (existing.length) console.log(`  COLLISION: ${pid} already tagged under '${target}' (pos ${existing[0].position_in_genre})`);
  else console.log(`  clean: ${pid} → will INSERT '${target}'`);
}

// Does 'greek funk' exist at all right now?
const greek = await get(`playlist_genres?genre=eq.greek%20funk&select=playlist_id,position_in_genre`);
console.log(`\n=== Current 'greek funk' pg rows in DB: ${greek.length} ===`);
for (const r of greek) console.log(`  ${r.playlist_id}  (position ${r.position_in_genre})`);

// Highest position_in_genre for each target genre (need to append cleanly)
console.log(`\n=== Highest existing position_in_genre for target genres ===`);
for (const g of new Set(Object.values(TARGETS))) {
  const rows = await get(`playlist_genres?genre=eq.${encodeURIComponent(g)}&select=position_in_genre&order=position_in_genre.desc&limit=1`);
  console.log(`  ${g}: ${rows[0]?.position_in_genre ?? '(none)'}`);
}
