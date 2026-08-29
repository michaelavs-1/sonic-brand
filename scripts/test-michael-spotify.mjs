/*  scripts/test-michael-spotify.mjs
    Single test call to verify Michael's Spotify app still has grandfathered
    read access to GET /playlists/{id}/tracks. This endpoint is what the
    v4/precompute batch worker uses to fetch tracks for analysis; if it
    403s here, the track analysis errors have a Spotify root cause.

    Run: node scripts/test-michael-spotify.mjs
*/

import fs from 'node:fs';

const env = fs.readFileSync('.env.local', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const CID  = process.env.SPOTIFY_CLIENT_ID;
const CSEC = process.env.SPOTIFY_CLIENT_SECRET;
if (!CID || !CSEC) { console.error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET'); process.exit(1); }

// 1. Get Client Credentials token
console.log('1/2 requesting Client Credentials token from Michael\'s app...');
const basic = Buffer.from(`${CID}:${CSEC}`).toString('base64');
const tokRes = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
if (!tokRes.ok) {
  console.error('  ✗ token fetch failed:', tokRes.status, await tokRes.text());
  process.exit(1);
}
const { access_token: tok } = await tokRes.json();
console.log('  ✓ CC token OK');

// 2. Grab a real user-created playlist from Supabase — one we've actually
// scanned via the batch worker. Editorial playlists 404 for all third-party
// apps since Nov 2024, so we need a user playlist to test grandfathered access.
console.log('2/3 fetching a real Data Box playlist ID from Supabase...');
const SB = process.env.SUPABASE_URL, SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !SRV) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const pgRes = await fetch(`${SB}/rest/v1/playlist_tracks?select=playlist_id&limit=3`, {
  headers: { apikey: SRV, authorization: `Bearer ${SRV}` },
});
const pgRows = await pgRes.json();
if (!Array.isArray(pgRows) || !pgRows.length) { console.error('  ✗ no playlist_tracks rows found in Supabase'); process.exit(1); }
const PLAYLIST_ID = pgRows[0].playlist_id;
console.log(`  ✓ using playlist_id ${PLAYLIST_ID}`);

// 3. GET /playlists/{id}/tracks on that user playlist
console.log(`3/3 GET /playlists/${PLAYLIST_ID}/tracks?limit=5 ...`);
const r = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks?limit=5`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const body = await r.text();
console.log(`  status: ${r.status}`);
console.log(`  body:   ${body.slice(0, 300)}`);

if (!r.ok) {
  console.error(`\n✗ TEST FAILED — Michael's CC token cannot read this user playlist (${r.status})`);
  if (r.status === 401) console.error('  (401 = token issue, unusual for CC)');
  if (r.status === 403) console.error('  (403 = grandfather access likely revoked — this would break the batch worker)');
  if (r.status === 404) console.error('  (404 = this specific playlist got deleted/private — try re-running to pick another)');
  process.exit(1);
}

const data = JSON.parse(body);
console.log(`  ✓ got ${data.items?.length || 0} tracks (playlist total: ${data.total})`);
console.log('\n✓ TEST PASSED — Michael\'s grandfathered read access to user playlists is intact. Track analysis errors are elsewhere (RapidAPI, Supabase, etc.).');
