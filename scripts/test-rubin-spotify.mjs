/*  scripts/test-rubin-spotify.mjs
    Single test call to verify Rubin's Spotify token can create playlists.
    Creates a throwaway playlist and immediately unfollows it (Spotify's
    equivalent of delete), so nothing sticks around in Rubin's library.

    Run: node scripts/test-rubin-spotify.mjs

    Exit 0 on success, 1 on failure. Prints exactly what happened.
*/

import fs from 'node:fs';

const env = fs.readFileSync('.env.local', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const CID  = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const CSEC = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const RTOK = process.env.RUBIN_REFRESH_TOKEN;
if (!CID || !CSEC || !RTOK) {
  console.error('Missing RUBIN_* env vars.');
  process.exit(1);
}

// 1. Refresh access token
console.log('1/3 refreshing Rubin access token...');
const basic = Buffer.from(`${CID}:${CSEC}`).toString('base64');
const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RTOK }),
});
if (!tokenRes.ok) {
  console.error('  ✗ token refresh failed:', tokenRes.status, await tokenRes.text());
  process.exit(1);
}
const { access_token: tok, scope } = await tokenRes.json();
console.log(`  ✓ token OK (scope: ${scope})`);

// 2. Attempt to create a throwaway playlist via the NEW endpoint (/me/playlists)
console.log('2/3 attempting POST /me/playlists ...');
const name = `TEST-DELETE-ME-${Date.now()}`;
const createRes = await fetch('https://api.spotify.com/v1/me/playlists', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, description: 'temporary test playlist — safe to delete', public: false }),
});
const createBody = await createRes.text();
console.log(`  status: ${createRes.status}`);
console.log(`  body:   ${createBody.slice(0, 300)}`);

if (!createRes.ok) {
  console.error(`\n✗ TEST FAILED — Rubin cannot create playlists (${createRes.status})`);
  if (createRes.status === 429) console.error('  (429 = rate-limited, still cooling down)');
  if (createRes.status === 403) console.error('  (403 = forbidden — see body above for reason)');
  process.exit(1);
}

const created = JSON.parse(createBody);
console.log(`  ✓ created ${created.id} — "${created.name}"`);

// 3. Immediately unfollow (Spotify's version of delete for playlists you own)
console.log('3/3 unfollowing to clean up...');
const delRes = await fetch(`https://api.spotify.com/v1/playlists/${created.id}/followers`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${tok}` },
});
if (!delRes.ok) {
  console.warn(`  ⚠ cleanup unfollow returned ${delRes.status} — you may need to manually remove ${name} from Rubin's library`);
} else {
  console.log(`  ✓ cleaned up`);
}

console.log('\n✓ TEST PASSED — Rubin can create playlists. Safe to flip SPOTIFY_WRITES_DISABLED back to false.');
