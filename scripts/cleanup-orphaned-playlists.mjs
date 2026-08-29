/*  scripts/cleanup-orphaned-playlists.mjs
    One-off cleanup for `created_playlists` rows whose expires_at is in the
    past and deleted_at is still null. These are playlists the expire cron
    tried (or was blocked from trying) but never finished cleaning up.

    Talks direct to Spotify — bypasses api/new/spotify (so the
    SPOTIFY_WRITES_DISABLED kill switch does not block this script).

    Per playlist (matches api/new/spotify.js unfollow flow):
      1. PUT   /playlists/{id}                — rename to "expired · <original>"
      2. PUT   /playlists/{id}/items          — empty via `uris: []`
      3. DELETE /playlists/{id}/followers     — unfollow from Rubin's library
      4. PATCH created_playlists              — set deleted_at
    404 on any Spotify step = playlist already gone → treat as success.

    Pacing: 5s between Spotify calls (well under 180/min ceiling).
    Estimated runtime for 31 items: ~10-15 minutes.

    Run:
      node scripts/cleanup-orphaned-playlists.mjs             # dry-run
      node scripts/cleanup-orphaned-playlists.mjs --confirm
*/

import fs from 'node:fs';

const env = fs.readFileSync('.env.local', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const CONFIRM = process.argv.includes('--confirm');
const SPOTIFY_CALL_SLEEP_MS = 5000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CID  = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const CSEC = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const RTOK = process.env.RUBIN_REFRESH_TOKEN;
if (!SUPABASE_URL || !SERVICE_KEY || !CID || !CSEC || !RTOK) {
  console.error('Missing env vars (SUPABASE_* and/or RUBIN_*)');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Supabase ----------
async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey:         SERVICE_KEY,
      authorization:  `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

// ---------- Spotify ----------
let spTok = null, spExp = 0;
async function spToken() {
  if (spTok && Date.now() < spExp) return spTok;
  const basic = Buffer.from(`${CID}:${CSEC}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RTOK }),
  });
  if (!r.ok) throw new Error(`token refresh ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  spTok = d.access_token;
  spExp = Date.now() + (d.expires_in * 1000) - 60_000;
  return spTok;
}

// Honors full Retry-After (no cap). Retries a 429 exactly once — if the
// second try also 429s, we bail loudly (probably back in an escalated block).
async function spFetch(path, init = {}, attempt = 1) {
  const tok = await spToken();
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}` },
  });
  if (r.status === 429 && attempt === 1) {
    const ra = parseInt(r.headers.get('retry-after') || '60', 10);
    // Also try to parse body to see reason (QUOTA_EXCEEDED vs plain rate limit)
    const bodyText = await r.clone().text();
    let reason = null;
    try { reason = JSON.parse(bodyText)?.error?.reason || null; } catch {}
    console.log(`      [spotify 429 reason=${reason || 'n/a'}] waiting full Retry-After=${ra}s...`);
    await sleep(ra * 1000);
    return spFetch(path, init, 2);
  }
  return r;
}

// 404 = playlist already gone from Spotify's side. Not an error for cleanup.
function isGone(status) { return status === 404 || status === 410; }

// ---------- main ----------
async function cleanupOne({ spotify_id, name }) {
  const original = name || '(unnamed)';
  console.log(`\n[${spotify_id}] "${original}"`);

  // 1. Rename
  const renameName = `expired · ${original}`.slice(0, 100);
  const r1 = await spFetch(`/playlists/${spotify_id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: renameName }),
  });
  if (isGone(r1.status)) { console.log(`  [gone] 404 on rename — skipping Spotify steps, marking DB`); }
  else if (!r1.ok)       { throw new Error(`rename ${r1.status}: ${(await r1.text()).slice(0, 200)}`); }
  else                   { console.log(`  ✓ renamed`); await sleep(SPOTIFY_CALL_SLEEP_MS); }

  // 2. Empty
  if (!isGone(r1.status)) {
    const r2 = await spFetch(`/playlists/${spotify_id}/items`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [] }),
    });
    if (isGone(r2.status)) { console.log(`  [gone] 404 on empty`); }
    else if (!r2.ok)       { throw new Error(`empty ${r2.status}: ${(await r2.text()).slice(0, 200)}`); }
    else                   { console.log(`  ✓ emptied`); await sleep(SPOTIFY_CALL_SLEEP_MS); }
  }

  // 3. Unfollow
  const r3 = await spFetch(`/playlists/${spotify_id}/followers`, { method: 'DELETE' });
  if (isGone(r3.status))  { console.log(`  [gone] 404 on unfollow`); }
  else if (!r3.ok)        { throw new Error(`unfollow ${r3.status}: ${(await r3.text()).slice(0, 200)}`); }
  else                    { console.log(`  ✓ unfollowed`); await sleep(SPOTIFY_CALL_SLEEP_MS); }

  // 4. Mark deleted_at in DB
  await sb(`created_playlists?spotify_id=eq.${spotify_id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body:    JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  console.log(`  ✓ marked deleted_at in Supabase`);
}

(async () => {
  console.log(`cleanup-orphaned-playlists — ${CONFIRM ? 'CONFIRM' : 'DRY-RUN'}`);
  const backlog = await sb(`created_playlists?expires_at=lt.${new Date().toISOString()}&deleted_at=is.null&select=spotify_id,name,expires_at&order=expires_at.asc&limit=500`);
  console.log(`\nBacklog: ${backlog.length} playlists expired but never cleaned`);
  for (const p of backlog) console.log(`  ${p.expires_at.slice(0,19)}Z ${p.spotify_id} — ${p.name || '(unnamed)'}`);
  if (!backlog.length) { console.log('\nNothing to clean.'); return; }
  if (!CONFIRM) { console.log('\n(dry-run — pass --confirm to actually clean)'); return; }

  console.log(`\n=== CLEANING (${SPOTIFY_CALL_SLEEP_MS}ms between Spotify calls, estimated ${((backlog.length * 3 * SPOTIFY_CALL_SLEEP_MS) / 60000).toFixed(1)} min) ===`);
  const t0 = Date.now();
  let ok = 0, fail = 0;
  for (let i = 0; i < backlog.length; i++) {
    try {
      await cleanupOne(backlog[i]);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ✗ FAILED: ${e.message}`);
      // If we hit a 429 that couldn't recover, stop — Spotify's already blocking us.
      if (/429/.test(e.message)) {
        console.error('\n429 detected — Spotify is blocking. Stopping to avoid escalation. Rerun later.');
        break;
      }
    }
  }
  console.log(`\n=== DONE — ${ok} cleaned, ${fail} failed, ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
