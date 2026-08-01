#!/usr/bin/env node
/**
 * One-off purge of every playlist owned by the SonicBrands / Rubin Spotify
 * account. Spotify has no "delete playlist" verb — instead we unfollow each
 * playlist, which for an OWNED playlist removes it entirely from that user's
 * library. That's exactly what the v5 cron-expire-playlists worker does; we
 * just do it for everything the account has ever created.
 *
 * DEFAULT IS DRY-RUN. It prints what it would touch and stops. Pass --confirm
 * to actually unfollow.
 *
 * Usage (PowerShell, from repo root):
 *   # 1. Load Rubin env vars from .env.local
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *
 *   # 2. Dry-run first
 *   node scripts/purge-rubin-playlists.mjs
 *
 *   # 3. Actually purge
 *   node scripts/purge-rubin-playlists.mjs --confirm
 *
 * Optional flags:
 *   --confirm         actually unfollow (default: dry-run only)
 *   --all             include playlists Rubin FOLLOWS but doesn't own
 *                     (default: only owned)
 *   --name=STR        only touch playlists whose name contains STR
 *                     (case-insensitive; useful to purge only test runs)
 */

const CLIENT_ID     = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.RUBIN_REFRESH_TOKEN;

// Supabase (for marking rows deleted in the v5_created_playlists ledger, so
// the expire-playlists cron doesn't keep retrying).
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const CONFIRM     = args.includes('--confirm');
const INCLUDE_ALL = args.includes('--all');
const NAME_FILTER = (() => {
  const a = args.find((x) => x.startsWith('--name='));
  return a ? a.slice('--name='.length).toLowerCase() : null;
})();

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Missing one of: RUBIN_SPOTIFY_CLIENT_ID, RUBIN_SPOTIFY_CLIENT_SECRET, RUBIN_REFRESH_TOKEN');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — will skip ledger cleanup.');
}

async function refreshAccessToken() {
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
    throw new Error(`token refresh failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.access_token;
}

async function getMe(token) {
  const r = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`GET /me failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

// Enumerate playlists from Supabase's v5_created_playlists ledger. Every
// playlist created via /api/new/spotify since v5 is logged here — v5, v6,
// event-playlist, expand-playlist all write to it. Rows with deleted_at
// already set are skipped (they've been unfollowed on a previous run).
//
// (We can't list via GET /me/playlists because the Rubin refresh token was
// seeded with playlist-modify-private only, not playlist-read-private. That
// route requires re-seeding the OAuth token with a wider scope.)
async function listFromLedger() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required for ledger source');
  }
  const url = `${SUPABASE_URL}/rest/v1/v5_created_playlists?deleted_at=is.null&select=spotify_id,name,expires_at&limit=10000`;
  const r = await fetch(url, {
    headers: {
      apikey:        SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`ledger read failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const rows = await r.json();
  // Shape rows into the same field names the rest of the script expects.
  return rows.map((row) => ({
    id:     row.spotify_id,
    name:   row.name,
    tracks: null,               // not stored in ledger — undefined count is fine
    owner:  { id: null },       // ownership not tracked here — --all flag is moot
    _expiresAt: row.expires_at,
  }));
}

async function unfollow(token, playlistId) {
  const r = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`unfollow ${playlistId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

// Mark a v5_created_playlists row as deleted so the expire-playlists cron
// won't try to re-process it. Silently no-ops if the row doesn't exist
// (playlist was created before the tracking table existed).
async function markLedgerDeleted(spotifyId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const url = `${SUPABASE_URL}/rest/v1/v5_created_playlists?spotify_id=eq.${spotifyId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey:         SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify({ deleted_at: new Date().toISOString(), error: null }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`ledger patch ${spotifyId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

async function main() {
  console.log('==========================================');
  console.log('Rubin playlist purge (source: ledger)');
  console.log('==========================================');
  console.log('Mode:      ', CONFIRM ? 'CONFIRM (will unfollow)' : 'dry-run (nothing will change)');
  if (NAME_FILTER) console.log('Name filter:', NAME_FILTER);
  console.log('------------------------------------------');

  const token = await refreshAccessToken();
  const me    = await getMe(token);
  console.log(`Rubin user: id=${me.id} display_name="${me.display_name}"`);

  const playlists = await listFromLedger();
  console.log(`Un-deleted rows in v5_created_playlists: ${playlists.length}`);

  const targets = playlists.filter((p) => {
    if (NAME_FILTER && !String(p.name || '').toLowerCase().includes(NAME_FILTER)) return false;
    return true;
  });
  console.log(`Matching purge criteria: ${targets.length}\n`);

  if (!targets.length) {
    console.log('Nothing to do.');
    return;
  }

  for (const p of targets) {
    console.log(` - ${p.name}  (id=${p.id}, ${p.tracks?.total ?? '?'} tracks)`);
  }

  if (!CONFIRM) {
    console.log('\nDry run — pass --confirm to actually unfollow these playlists.');
    return;
  }

  console.log(`\nUnfollowing ${targets.length} playlists...`);
  let done = 0, failed = 0, ledgerMarked = 0, ledgerFailed = 0;
  for (const p of targets) {
    try {
      await unfollow(token, p.id);
      done++;
      // Mark the corresponding ledger row deleted so the cron doesn't chase
      // it. If the row doesn't exist (pre-tracking playlist), PATCH returns
      // 200 with zero rows affected — harmless.
      try {
        await markLedgerDeleted(p.id);
        ledgerMarked++;
      } catch (e) {
        ledgerFailed++;
        console.warn(`  ledger patch failed for ${p.id}: ${e.message}`);
      }
      if (done % 25 === 0) console.log(`  ${done}/${targets.length}`);
      // Gentle pacing — Spotify's rate limits are generous but we're firing many.
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) {
      failed++;
      console.warn(`  FAIL ${p.name} (${p.id}): ${e.message}`);
    }
  }
  console.log(`\nDone. ${done} unfollowed, ${failed} failed.`);
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    console.log(`Ledger: ${ledgerMarked} rows marked deleted, ${ledgerFailed} failed.`);
  } else {
    console.log('Ledger: skipped (no Supabase credentials in env).');
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
