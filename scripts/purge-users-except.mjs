#!/usr/bin/env node
/**
 * Delete every Supabase auth user EXCEPT a specified allow-list, plus each
 * deleted user's `businesses` rows and every Spotify playlist owned by
 * their account (unfollowed on the shared Rubin Spotify account).
 *
 * DEFAULT IS DRY-RUN. It prints what it would touch and stops. Pass
 * --confirm to actually delete.
 *
 * Order of operations per user targeted for deletion:
 *   1. Read user_metadata.sonic.b[*].playlists[].id → collect spotify_ids.
 *   2. Unfollow each of those on Rubin's Spotify account (soft-continue on
 *      individual failures) + mark the created_playlists ledger row
 *      deleted so the expire-playlists cron doesn't keep chasing them.
 *   3. DELETE their businesses rows.
 *   4. DELETE the auth user.
 *
 * Usage (PowerShell, from repo root):
 *   # 1. Load env vars from .env.local
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *
 *   # 2. Dry-run first — list the users that WOULD be deleted
 *   node scripts/purge-users-except.mjs --keep=a@b.com,c@d.com,e@f.com
 *
 *   # 3. Actually delete
 *   node scripts/purge-users-except.mjs --keep=a@b.com,c@d.com,e@f.com --confirm
 *
 * Flags:
 *   --keep=EMAIL[,EMAIL,...]   REQUIRED. Comma-separated emails to keep.
 *   --confirm                  Actually delete. Default is dry-run.
 *   --skip-spotify             Skip Spotify unfollow (ledger + business + user
 *                              still get deleted; playlists linger in Rubin's
 *                              library and the cron will pick them up later).
 */

// ---------- config ----------
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CLIENT_ID     = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.RUBIN_REFRESH_TOKEN;

// ---------- args ----------
const args = process.argv.slice(2);
const CONFIRM      = args.includes('--confirm');
const SKIP_SPOTIFY = args.includes('--skip-spotify');
const KEEP_EMAILS = (() => {
  const a = args.find((x) => x.startsWith('--keep='));
  if (!a) return null;
  return a.slice('--keep='.length)
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
})();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}
if (!KEEP_EMAILS || !KEEP_EMAILS.length) {
  console.error('Missing --keep=EMAIL[,EMAIL,...] flag. Refusing to run without an allow-list.');
  console.error('Example: node scripts/purge-users-except.mjs --keep=roni.mark@gmail.com,test@example.com');
  process.exit(1);
}
if (!SKIP_SPOTIFY && (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN)) {
  console.error('Missing one of: RUBIN_SPOTIFY_CLIENT_ID, RUBIN_SPOTIFY_CLIENT_SECRET, RUBIN_REFRESH_TOKEN.');
  console.error('Pass --skip-spotify to purge users + businesses without touching Spotify.');
  process.exit(1);
}

const KEEP_SET = new Set(KEEP_EMAILS);

// ---------- admin helpers ----------
function adminHeaders() {
  return {
    apikey:         SUPABASE_SERVICE_KEY,
    Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function listAllUsers() {
  const all = [];
  let page = 1;
  const perPage = 1000;
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: adminHeaders(),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`list users page ${page} failed: ${r.status} ${t.slice(0, 200)}`);
    }
    const j = await r.json().catch(() => ({}));
    const users = Array.isArray(j) ? j : (j?.users || []);
    all.push(...users);
    if (users.length < perPage) break;
    page += 1;
  }
  return all;
}

async function readSonic(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: adminHeaders() });
  if (!r.ok) return {};
  const j = await r.json().catch(() => ({}));
  return j?.user_metadata?.sonic || {};
}

function spotifyIdsFromSonic(sonic) {
  const out = [];
  const b = sonic?.b || {};
  for (const bizId of Object.keys(b)) {
    const arr = Array.isArray(b[bizId]?.playlists) ? b[bizId].playlists : [];
    for (const p of arr) if (p?.id) out.push(p.id);
  }
  return out;
}

async function listBusinessesByOwner(ownerId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${ownerId}&select=id,name`,
    { headers: adminHeaders() },
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`list businesses for ${ownerId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function deleteBusinessesByOwner(ownerId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${ownerId}`,
    { method: 'DELETE', headers: { ...adminHeaders(), Prefer: 'return=minimal' } },
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`delete businesses for ${ownerId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

async function deleteAuthUser(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`delete user ${userId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

async function markLedgerDeleted(spotifyId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/created_playlists?spotify_id=eq.${spotifyId}`,
    {
      method: 'PATCH',
      headers: { ...adminHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ deleted_at: new Date().toISOString(), error: null }),
    },
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`ledger patch ${spotifyId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

// ---------- spotify helpers ----------
async function refreshSpotifyToken() {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`spotify token refresh failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.access_token;
}

async function spotifyUnfollow(token, playlistId) {
  const r = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 / 410 = already gone → treat as success.
  if (r.status === 404 || r.status === 410) return;
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`unfollow ${playlistId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

// ---------- main ----------
async function main() {
  console.log('==========================================');
  console.log('Purge users (except allow-list)');
  console.log('==========================================');
  console.log('Mode:         ', CONFIRM ? 'CONFIRM (will delete)' : 'dry-run (nothing will change)');
  console.log('Keep emails:  ', [...KEEP_SET].join(', '));
  console.log('Skip Spotify: ', SKIP_SPOTIFY ? 'yes' : 'no');
  console.log('------------------------------------------');

  const users = await listAllUsers();
  console.log(`Total auth users: ${users.length}`);

  const toKeep = users.filter((u) => KEEP_SET.has(String(u.email || '').toLowerCase()));
  const toDelete = users.filter((u) => !KEEP_SET.has(String(u.email || '').toLowerCase()));

  console.log(`Keeping:  ${toKeep.length}`);
  for (const u of toKeep) console.log(`   ✓ ${u.email}  (id=${u.id})`);
  console.log(`Deleting: ${toDelete.length}\n`);

  // Which requested emails don't exist? Nice-to-know.
  const foundEmails = new Set(toKeep.map((u) => String(u.email || '').toLowerCase()));
  const missing = [...KEEP_SET].filter((e) => !foundEmails.has(e));
  if (missing.length) {
    console.warn(`⚠️  These --keep emails aren't in auth.users: ${missing.join(', ')}\n`);
  }

  if (!toDelete.length) {
    console.log('Nothing to delete.');
    return;
  }

  // Build the full deletion plan (playlists + businesses) BEFORE any writes,
  // so dry-run can print it and confirm-mode can execute in a tight loop.
  const plan = [];
  for (const u of toDelete) {
    const sonic       = await readSonic(u.id);
    const spotifyIds  = spotifyIdsFromSonic(sonic);
    const businesses  = await listBusinessesByOwner(u.id);
    plan.push({ user: u, spotifyIds, businesses });
  }

  console.log('Deletion plan:');
  for (const p of plan) {
    console.log(` - ${p.user.email}  (id=${p.user.id})`);
    console.log(`     businesses: ${p.businesses.length}${p.businesses.length ? '  [' + p.businesses.map((b) => b.id).join(', ') + ']' : ''}`);
    console.log(`     playlists:  ${p.spotifyIds.length}${p.spotifyIds.length ? '  [' + p.spotifyIds.slice(0, 4).join(', ') + (p.spotifyIds.length > 4 ? ', …' : '') + ']' : ''}`);
  }

  const totalPlaylists  = plan.reduce((n, p) => n + p.spotifyIds.length, 0);
  const totalBusinesses = plan.reduce((n, p) => n + p.businesses.length, 0);
  console.log(`\nSummary: ${plan.length} users, ${totalBusinesses} businesses, ${totalPlaylists} playlists`);

  if (!CONFIRM) {
    console.log('\nDry run — pass --confirm to actually delete.');
    return;
  }

  const spotifyToken = SKIP_SPOTIFY ? null : await refreshSpotifyToken();

  console.log('\nExecuting deletion...\n');
  let userDone = 0, userFail = 0;
  let plDone   = 0, plFail   = 0;
  let ledgerDone = 0, ledgerFail = 0;
  let bizDone  = 0, bizFail  = 0;

  for (const p of plan) {
    console.log(`→ ${p.user.email}  (id=${p.user.id})`);

    // 1) Spotify unfollow (soft-continue on failures).
    if (!SKIP_SPOTIFY && p.spotifyIds.length) {
      for (const sid of p.spotifyIds) {
        try {
          await spotifyUnfollow(spotifyToken, sid);
          plDone++;
          try { await markLedgerDeleted(sid); ledgerDone++; }
          catch (e) { ledgerFail++; console.warn(`   ledger fail ${sid}: ${e.message}`); }
          await new Promise((r) => setTimeout(r, 60)); // gentle pacing
        } catch (e) {
          plFail++;
          console.warn(`   unfollow fail ${sid}: ${e.message}`);
        }
      }
    }

    // 2) Delete businesses rows for this owner.
    try {
      await deleteBusinessesByOwner(p.user.id);
      bizDone += p.businesses.length;
    } catch (e) {
      bizFail += p.businesses.length;
      console.warn(`   businesses delete fail: ${e.message}`);
      // Still try to remove the auth user — leaving orphaned businesses is
      // worse than an orphaned businesses row with a stale owner_id.
    }

    // 3) Delete the auth user itself.
    try {
      await deleteAuthUser(p.user.id);
      userDone++;
    } catch (e) {
      userFail++;
      console.warn(`   user delete fail: ${e.message}`);
    }
  }

  console.log('\n==========================================');
  console.log('Done.');
  console.log(`  users:      ${userDone} deleted, ${userFail} failed`);
  console.log(`  businesses: ${bizDone} deleted, ${bizFail} failed`);
  if (!SKIP_SPOTIFY) {
    console.log(`  playlists:  ${plDone} unfollowed, ${plFail} failed`);
    console.log(`  ledger:     ${ledgerDone} marked, ${ledgerFail} failed`);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
