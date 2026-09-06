#!/usr/bin/env node
/**
 * Purge every Rubin-owned playlist whose name does NOT contain a "keep"
 * substring (default: today's date in DD.MM.YYYY, Asia/Jerusalem).
 *
 * Rubin's playlist-naming convention is `<biz> · <direction> · DD.MM.YYYY`,
 * and the account only holds ephemeral daily/event playlists — anything not
 * dated today is either the previous day's rollover about to expire, a
 * pre-cron leftover, or test cruft. So a date-substring filter is a
 * cheaper, more honest signal than cross-checking the ledger (which has
 * gaps and misses manually-created rows anyway).
 *
 * Default DRY-RUN. Prints candidates, exits. Re-run with --confirm to
 * actually unfollow.
 *
 * Usage (PowerShell, from repo root):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/purge-pre-cron-playlists.mjs --refresh-token=<NEW_TOKEN>
 *   node scripts/purge-pre-cron-playlists.mjs --refresh-token=<NEW_TOKEN> --confirm
 *
 * Flags:
 *   --refresh-token=STR  override RUBIN_REFRESH_TOKEN (for testing a new
 *                        scope-widened token before it's in .env.local)
 *   --keep=STR           substring; playlists whose NAME contains this
 *                        are preserved (default: today's DD.MM.YYYY in IL)
 *   --exclude=id1,id2    additional Spotify playlist ids to preserve
 *   --confirm            actually unfollow (default: dry-run)
 */

const CLIENT_ID     = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const REFRESH_TOKEN = (() => {
  const a = args.find((x) => x.startsWith('--refresh-token='));
  return a ? a.slice('--refresh-token='.length) : process.env.RUBIN_REFRESH_TOKEN;
})();
const EXCLUDE_IDS = (() => {
  const a = args.find((x) => x.startsWith('--exclude='));
  if (!a) return new Set();
  return new Set(a.slice('--exclude='.length).split(',').map((s) => s.trim()).filter(Boolean));
})();
const KEEP_SUBSTR = (() => {
  const a = args.find((x) => x.startsWith('--keep='));
  if (a) return a.slice('--keep='.length);
  // Default: today's date in DD.MM.YYYY, Asia/Jerusalem.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const dd = parts.find((p) => p.type === 'day').value;
  const mm = parts.find((p) => p.type === 'month').value;
  const yy = parts.find((p) => p.type === 'year').value;
  return `${dd}.${mm}.${yy}`;
})();

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Missing one of: RUBIN_SPOTIFY_CLIENT_ID, RUBIN_SPOTIFY_CLIENT_SECRET, RUBIN_REFRESH_TOKEN (or --refresh-token=...)');
  process.exit(1);
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
  return { access_token: j.access_token, scope: j.scope };
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

async function listAllOwnedPlaylists(token, myId) {
  const out = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
  let page = 0;
  while (url) {
    page++;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`GET /me/playlists (page ${page}) failed: ${r.status} ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    for (const p of j.items || []) {
      if (p.owner?.id === myId) {
        out.push({
          id:            p.id,
          name:          p.name,
          tracks:        p.tracks?.total ?? 0,
          public:        !!p.public,
          collaborative: !!p.collaborative,
        });
      }
    }
    url = j.next;
  }
  return out;
}

// 2000ms inter-call pacing — well under Spotify's rate limits (see the
// Spotify resilience layer notes) and gives a full 282-item run ~10min
// of gentle throughput. No urgency, so err on the safe side.
const DELAY_MS = 2000;

function ts() {
  // HH:MM:SS wall clock, local time.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unfollow with light retry handling: honour 429 Retry-After, back off on
// transient 5xx, treat 404 as already-gone, throw everything else.
async function unfollowWithRetry(token, id) {
  let attempt = 0;
  while (true) {
    attempt++;
    const r = await fetch(`https://api.spotify.com/v1/playlists/${id}/followers`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) return 'ok';
    if (r.status === 404) return 'gone';
    if (r.status === 429 && attempt <= 4) {
      const retryAfter = parseInt(r.headers.get('retry-after') || '30', 10);
      console.log(`   [${ts()}]   ...429 rate-limited; sleeping ${retryAfter}s then retry #${attempt + 1}`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (r.status >= 500 && attempt <= 3) {
      const backoff = 2000 * attempt;
      console.log(`   [${ts()}]   ...${r.status} transient; sleeping ${backoff}ms then retry #${attempt + 1}`);
      await sleep(backoff);
      continue;
    }
    const t = await r.text().catch(() => '');
    throw new Error(`${r.status} ${t.slice(0, 200)}`);
  }
}

// Best-effort ledger cleanup: mark the created_playlists row deleted so
// the expire-playlists cron doesn't pointlessly retry it. Silent no-op if
// Supabase creds aren't in env, or if the row doesn't exist (pre-ledger).
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function markLedgerDeleted(id) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/created_playlists?spotify_id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey:         SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify({ deleted_at: new Date().toISOString(), error: null }),
  });
}

async function main() {
  console.log('==========================================');
  console.log('Rubin playlist purge (date-substring keep)');
  console.log('==========================================');
  console.log('Mode:       ', CONFIRM ? 'CONFIRM (will unfollow)' : 'dry-run (nothing will change)');
  console.log('Keep names containing:', JSON.stringify(KEEP_SUBSTR));
  if (EXCLUDE_IDS.size) console.log('Also keeping ids:', [...EXCLUDE_IDS].join(','));
  console.log('------------------------------------------');

  const { access_token, scope } = await refreshAccessToken();
  console.log(`Token scopes: ${scope}`);
  if (!scope.includes('playlist-read-private')) {
    throw new Error('Refresh token is missing playlist-read-private scope — cannot enumerate playlists.');
  }

  const me = await getMe(access_token);
  console.log(`Rubin user: id=${me.id} display_name="${me.display_name}"`);

  console.log('\nEnumerating owned playlists...');
  const owned = await listAllOwnedPlaylists(access_token, me.id);
  console.log(`Owned playlists on Spotify: ${owned.length}`);

  const kept    = owned.filter((p) => (p.name || '').includes(KEEP_SUBSTR) || EXCLUDE_IDS.has(p.id));
  const targets = owned.filter((p) => !(p.name || '').includes(KEEP_SUBSTR) && !EXCLUDE_IDS.has(p.id));

  console.log(`Keeping (name has "${KEEP_SUBSTR}" or in --exclude): ${kept.length}`);
  console.log(`Targets to unfollow: ${targets.length}\n`);

  if (kept.length) {
    console.log('KEEP:');
    for (const p of kept) console.log(`   . ${p.name}  (id=${p.id}, ${p.tracks} tracks)`);
    console.log('');
  }

  if (!targets.length) {
    console.log('Nothing to delete.');
    return;
  }

  if (!CONFIRM) {
    console.log(`Would unfollow ${targets.length} playlists (sample of first 20):`);
    for (const p of targets.slice(0, 20)) {
      console.log(` - ${p.name}  (id=${p.id}, ${p.tracks} tracks)`);
    }
    if (targets.length > 20) console.log(`   ... and ${targets.length - 20} more`);
    console.log('\nDry run. Re-run with --confirm to actually unfollow.');
    return;
  }

  const etaSec = Math.round((targets.length * DELAY_MS) / 1000);
  const etaMin = Math.ceil(etaSec / 60);
  console.log(`Unfollowing ${targets.length} playlists at ${DELAY_MS}ms/each (~${etaMin}min ETA)`);
  console.log('Ctrl+C to abort at any time; already-unfollowed playlists cannot be recovered.\n');

  const startedAt = Date.now();
  let done = 0, gone = 0, failed = 0, ledgerMarked = 0;
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    const idx   = String(i + 1).padStart(String(targets.length).length, ' ');
    const label = `[${ts()}] [${idx}/${targets.length}]`;
    try {
      const outcome = await unfollowWithRetry(access_token, p.id);
      if (outcome === 'gone') {
        gone++;
        console.log(`${label} GONE  ${p.name}  (id=${p.id})  — 404, already unfollowed`);
      } else {
        done++;
        console.log(`${label} OK    ${p.name}  (id=${p.id}, ${p.tracks} tracks)`);
      }
      try { await markLedgerDeleted(p.id); ledgerMarked++; } catch { /* swallow */ }
    } catch (e) {
      failed++;
      console.warn(`${label} FAIL  ${p.name}  (id=${p.id}) — ${e.message}`);
    }
    if (i < targets.length - 1) await sleep(DELAY_MS);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const elapsedMin = (elapsedSec / 60).toFixed(1);
  console.log('');
  console.log(`Done in ${elapsedMin}min (${elapsedSec}s).`);
  console.log(`  Unfollowed:      ${done}`);
  console.log(`  Already gone:    ${gone}  (404 on delete — nothing to remove)`);
  console.log(`  Failed:          ${failed}`);
  console.log(`  Ledger marked:   ${ledgerMarked}  (best-effort; 0 for pre-ledger rows)`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
