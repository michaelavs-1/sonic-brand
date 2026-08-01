#!/usr/bin/env node
/**
 * Fully purge one or more test accounts:
 *   1. Enumerate each user's playlists from user_metadata + v5_created_playlists.
 *   2. Unfollow every playlist from Rubin's Spotify account.
 *   3. Mark the ledger rows deleted.
 *   4. Delete the user's businesses rows (public.businesses.owner_id = user.id).
 *   5. Delete the auth.users row (drops raw_user_meta_data with it).
 *
 * DEFAULT IS DRY-RUN. Prints exactly what it would do and stops.
 *
 * Usage (PowerShell from repo root):
 *   # 1. Load env vars
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *
 *   # 2. Dry-run
 *   node scripts/purge-users.mjs a@example.com b@example.com
 *
 *   # 3. Actually delete
 *   node scripts/purge-users.mjs a@example.com b@example.com --confirm
 *
 * Env required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (for auth admin + business/ledger)
 *   RUBIN_SPOTIFY_CLIENT_ID, RUBIN_SPOTIFY_CLIENT_SECRET, RUBIN_REFRESH_TOKEN
 *                                             (for Spotify unfollow)
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_ID            = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET        = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN        = process.env.RUBIN_REFRESH_TOKEN;

const args     = process.argv.slice(2);
const CONFIRM  = args.includes('--confirm');
const EMAILS   = args.filter((a) => !a.startsWith('--')).map((a) => a.trim().toLowerCase()).filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Missing Rubin Spotify credentials (RUBIN_SPOTIFY_CLIENT_ID / _SECRET / RUBIN_REFRESH_TOKEN).');
  process.exit(1);
}
if (!EMAILS.length) {
  console.error('Pass at least one email address:');
  console.error('  node scripts/purge-users.mjs a@example.com b@example.com [--confirm]');
  process.exit(1);
}

// --------- Supabase helpers (via REST / admin API) ---------

function adminHeaders() {
  return {
    apikey:        SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Admin GET /auth/v1/admin/users?email= isn't a native filter; the admin
// list endpoint returns everyone paginated. Simpler: use the admin
// generate_link magiclink form which returns the matching user object
// without sending an email. If the email isn't registered, this returns
// an error we swallow.
async function findUserByEmail(email) {
  // The admin list endpoint DOES accept ?email= as a Postgrest-style filter
  // on the underlying auth.users table. Not officially documented but works
  // in practice and doesn't have the side-effect of the magiclink hack.
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: adminHeaders(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`admin users lookup failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const j = await r.json().catch(() => ({}));
  const users = Array.isArray(j?.users) ? j.users : (Array.isArray(j) ? j : []);
  return users.find((u) => (u.email || '').toLowerCase() === email) || null;
}

async function listBusinesses(ownerId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${ownerId}&select=id,name`,
    { headers: adminHeaders() },
  );
  if (!r.ok) throw new Error(`businesses lookup failed: ${r.status}`);
  return r.json();
}

async function deleteBusinesses(ownerId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${ownerId}`,
    { method: 'DELETE', headers: { ...adminHeaders(), Prefer: 'return=minimal' } },
  );
  if (!r.ok) throw new Error(`businesses delete failed: ${r.status}`);
}

async function deleteAuthUser(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`auth user delete failed (${r.status}): ${t.slice(0, 200)}`);
  }
}

async function markLedgerDeleted(spotifyId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/v5_created_playlists?spotify_id=eq.${spotifyId}`,
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

// --------- Spotify (Rubin's account) ---------

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
    throw new Error(`Spotify token refresh failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.access_token;
}

async function unfollow(token, playlistId) {
  const r = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 = playlist already gone. Treat as success (matches expire-cron behavior).
  if (!r.ok && r.status !== 404) {
    const t = await r.text().catch(() => '');
    throw new Error(`unfollow ${playlistId} failed (${r.status}): ${t.slice(0, 200)}`);
  }
}

// Pull every spotify_id from a user's user_metadata.sonic.b[bizId].playlists.
function collectPlaylistIds(user) {
  const b = user?.user_metadata?.sonic?.b || {};
  const ids = new Set();
  const items = [];
  for (const [bizId, row] of Object.entries(b)) {
    const arr = Array.isArray(row?.playlists) ? row.playlists : [];
    for (const p of arr) {
      if (p?.id && !ids.has(p.id)) {
        ids.add(p.id);
        items.push({ spotify_id: p.id, name: p.label || '(unknown)', bizId });
      }
    }
  }
  return items;
}

// --------- main ---------

async function main() {
  console.log('==========================================');
  console.log('User purge');
  console.log('==========================================');
  console.log('Mode:  ', CONFIRM ? 'CONFIRM (will delete)' : 'dry-run (nothing will change)');
  console.log('Emails:', EMAILS.join(', '));
  console.log('------------------------------------------');

  // Refresh Spotify token upfront so a failure aborts before any DB writes.
  const spotifyToken = await refreshSpotifyToken();

  const plans = [];
  for (const email of EMAILS) {
    const user = await findUserByEmail(email);
    if (!user) {
      console.log(`\n[${email}] NOT FOUND — skipping.`);
      continue;
    }
    const playlists = collectPlaylistIds(user);
    const businesses = await listBusinesses(user.id);
    plans.push({ email, user, playlists, businesses });

    console.log(`\n[${email}]`);
    console.log(`  user.id:        ${user.id}`);
    console.log(`  businesses:     ${businesses.length}${businesses.length ? '  — ' + businesses.map((b) => `${b.id.slice(0, 8)}(${b.name || 'unnamed'})`).join(', ') : ''}`);
    console.log(`  playlists:      ${playlists.length}${playlists.length ? '  — first few: ' + playlists.slice(0, 3).map((p) => p.name).join(', ') + (playlists.length > 3 ? ` (+${playlists.length - 3} more)` : '') : ''}`);
  }

  if (!plans.length) {
    console.log('\nNothing to do.');
    return;
  }

  if (!CONFIRM) {
    console.log('\nDry-run only. Re-run with --confirm to actually delete.');
    return;
  }

  console.log('\n============ EXECUTING ============');
  for (const plan of plans) {
    console.log(`\n[${plan.email}]`);

    // 1. Unfollow all Spotify playlists.
    let unfollowed = 0, unfollowFail = 0;
    for (const p of plan.playlists) {
      try {
        await unfollow(spotifyToken, p.spotify_id);
        unfollowed++;
        await new Promise((r) => setTimeout(r, 60)); // gentle pacing
      } catch (e) {
        unfollowFail++;
        console.warn(`  unfollow FAIL ${p.spotify_id}: ${e.message}`);
      }
    }
    console.log(`  unfollowed:     ${unfollowed} / ${plan.playlists.length}${unfollowFail ? ` (${unfollowFail} failed)` : ''}`);

    // 2. Mark ledger rows deleted.
    let ledgerMarked = 0, ledgerFail = 0;
    for (const p of plan.playlists) {
      try {
        await markLedgerDeleted(p.spotify_id);
        ledgerMarked++;
      } catch (e) {
        ledgerFail++;
        console.warn(`  ledger FAIL ${p.spotify_id}: ${e.message}`);
      }
    }
    console.log(`  ledger marked:  ${ledgerMarked} / ${plan.playlists.length}${ledgerFail ? ` (${ledgerFail} failed)` : ''}`);

    // 3. Delete businesses rows.
    try {
      await deleteBusinesses(plan.user.id);
      console.log(`  businesses:     deleted ${plan.businesses.length}`);
    } catch (e) {
      console.warn(`  businesses delete FAIL: ${e.message}`);
    }

    // 4. Delete the auth user.
    try {
      await deleteAuthUser(plan.user.id);
      console.log(`  auth.users:     deleted`);
    } catch (e) {
      console.warn(`  auth user delete FAIL: ${e.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch((e) => { console.error('\nFatal:', e); process.exit(1); });
