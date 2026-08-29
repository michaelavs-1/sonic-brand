/*  scripts/build-today-oneoff.mjs
    Manual recovery: build today's daily playlists for every eligible business,
    ONE direction at a time, with generous inter-call pacing. Bypasses the
    Vercel cron and the /api/new/spotify proxy — talks direct to Spotify and
    Supabase.

    Why this exists: on 2026-08-26 the natural hourly cron ticks between 03:00
    and 08:00 UTC didn't fire (Vercel side), so 8 businesses that would have
    built one-per-hour piled into a single tick. That pileup blew past
    Rubin's Spotify Development-mode quota → cascading 429s that also poisoned
    my own retry attempts. This script processes things at a pace Spotify can
    sustain so we can recover the day.

    Design:
      - Same guards as api/cron/generate-daily.js (onboarding done, hours,
        open today, within window, not already built today, active directions).
      - Direct Spotify API (no api/new/spotify) so we can pace freely and
        pick which credentials to use.
      - Serial: one business at a time, one direction at a time, one Spotify
        call at a time. Real sleeps between calls.
      - Same Supabase writes the cron would do (business_playlists row +
        created_playlists ledger row + v6_daily_track_history rows).
      - Same track-selection RPC (v6_direction_tracks_recent) with the same
        DEDUP_WINDOW_DAYS=7 primary + p_exclude_days=0 fallback.

    Credentials (Spotify):
      Defaults to RUBIN_* env vars. To use a fresh account for this run
      (recommended if Rubin's token is cooling from a 429 storm), set
      SCRIPT_SPOTIFY_CLIENT_ID + SCRIPT_SPOTIFY_CLIENT_SECRET +
      SCRIPT_SPOTIFY_REFRESH_TOKEN in .env.local — the script uses those
      when present and falls back to RUBIN_* otherwise.

    Run:
      node scripts/build-today-oneoff.mjs             # dry-run (shows plan)
      node scripts/build-today-oneoff.mjs --confirm   # actually build
      node scripts/build-today-oneoff.mjs --confirm --only=<biz_uuid>  # single biz
*/

import fs from 'node:fs';
import {
  computeTargetTracks,
  dayMinutesFromHours,
  dailyPlaylistExpiryIso,
  directionKey,
  ilPartsFromDate,
} from '../v6/generation/playlist-length.js';

// ---------- env ----------
const env = fs.readFileSync('.env.local', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const CONFIRM  = process.argv.includes('--confirm');
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY_BIZ = ONLY_ARG ? ONLY_ARG.split('=')[1] : null;

// Pacing — deliberately loose. Rubin is in Spotify Development Mode which has
// a low per-app quota; 24 direction builds × ~4 calls each = ~96 calls, and
// at these delays that's ~15 min end-to-end. Fine.
const SLEEP_BETWEEN_SPOTIFY_CALLS_MS = 3500;
const SLEEP_BETWEEN_DIRECTIONS_MS    = 6000;
const SLEEP_BETWEEN_BUSINESSES_MS    = 12000;

// Same defaults as api/cron/generate-daily.js.
const LEAD_MINUTES      = 120;
const DEDUP_WINDOW_DAYS = 7;

// ---------- config ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env.local');
  process.exit(1);
}

const SP_CLIENT_ID     = process.env.SCRIPT_SPOTIFY_CLIENT_ID     || process.env.RUBIN_SPOTIFY_CLIENT_ID;
const SP_CLIENT_SECRET = process.env.SCRIPT_SPOTIFY_CLIENT_SECRET || process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const SP_REFRESH_TOKEN = process.env.SCRIPT_SPOTIFY_REFRESH_TOKEN || process.env.RUBIN_REFRESH_TOKEN;
const USING_OVERRIDE   = !!process.env.SCRIPT_SPOTIFY_REFRESH_TOKEN;
if (!SP_CLIENT_ID || !SP_CLIENT_SECRET || !SP_REFRESH_TOKEN) {
  console.error('Spotify creds missing. Need SCRIPT_SPOTIFY_* or RUBIN_* in .env.local');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Supabase helpers ----------
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
  if (!r.ok) throw new Error(`supabase ${path} ${r.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

// ---------- Spotify helpers ----------
let spTok = null, spExp = 0;

async function spRefreshToken() {
  const basic = Buffer.from(`${SP_CLIENT_ID}:${SP_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: SP_REFRESH_TOKEN }),
  });
  if (!r.ok) throw new Error(`spotify token refresh ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  spTok = d.access_token;
  spExp = Date.now() + (d.expires_in * 1000) - 60_000;
}

async function spToken() {
  if (spTok && Date.now() < spExp) return spTok;
  await spRefreshToken();
  return spTok;
}

// Wrapper: full-Retry-After honoring (NOT capped at 5s like the proxy does),
// because we have no Vercel timeout to worry about here. If we get 429 with
// Retry-After: 60, we actually wait 60s.
async function spFetch(path, init = {}, attempt = 1) {
  const tok = await spToken();
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { ...(init.headers || {}), 'Authorization': `Bearer ${tok}` },
  });
  if (r.status === 429) {
    if (attempt > 3) throw new Error(`spotify 429 after ${attempt} attempts`);
    const ra = parseInt(r.headers.get('retry-after') || '30', 10);
    console.log(`      [spotify 429] Retry-After=${ra}s (attempt ${attempt}/3) — sleeping full duration`);
    await sleep(ra * 1000);
    return spFetch(path, init, attempt + 1);
  }
  if (r.status === 401 && attempt === 1) {
    spTok = null;
    return spFetch(path, init, attempt + 1);
  }
  return r;
}

// Uses /me/playlists (introduced Feb 2026 migration). The old
// /users/{id}/playlists endpoint was deprecated on 2026-03-09 and now
// returns 403 for every caller — do NOT switch back to it.
async function spCreatePlaylist(name, description) {
  const r = await spFetch(`/me/playlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, public: false }),
  });
  if (!r.ok) throw new Error(`spotify create_playlist ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function spAddTracksChunked(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    // /playlists/{id}/items (Feb 2026 migration). The old /tracks POST is deprecated.
    const r = await spFetch(`/playlists/${playlistId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: chunk }),
    });
    if (!r.ok) throw new Error(`spotify add_tracks ${r.status} ${(await r.text()).slice(0, 200)}`);
    console.log(`      + added chunk ${i / 100 + 1} (${chunk.length} tracks)`);
    await sleep(SLEEP_BETWEEN_SPOTIFY_CALLS_MS);
  }
}

// ---------- track selection ----------
async function fetchTracks(businessId, direction, popularityWindow, target) {
  const key     = directionKey(direction);
  const genres  = Array.isArray(direction.genres) ? direction.genres : [];
  const [lo, hi] = Array.isArray(popularityWindow) ? popularityWindow.map((v) => Math.round(v)) : [0, 100];
  const inst    = (direction.instrumentalness_preference === 'hard' || direction.instrumentalness_preference === 'soft')
    ? direction.instrumentalness_preference : 'none';
  const baseArgs = {
    p_genres:        genres,
    p_bpm_lo:        Math.floor(direction.bpm_range?.min ?? 0),
    p_bpm_hi:        Math.ceil (direction.bpm_range?.max ?? 300),
    p_pop_lo:        lo,
    p_pop_hi:        hi,
    p_biz_id:        businessId,
    p_direction_key: key,
    p_inst_pref:     inst,
  };
  const primary = await sb('rpc/v6_direction_tracks_recent', {
    method: 'POST',
    body:   JSON.stringify({ ...baseArgs, p_limit: target, p_exclude_days: DEDUP_WINDOW_DAYS }),
  });
  const ids = (primary || []).map((r) => r.spotify_id).filter(Boolean);
  if (ids.length < target) {
    const seen = new Set(ids);
    const fill = await sb('rpc/v6_direction_tracks_recent', {
      method: 'POST',
      body:   JSON.stringify({ ...baseArgs, p_limit: target * 2, p_exclude_days: 0 }),
    });
    for (const r of (fill || [])) {
      if (r?.spotify_id && !seen.has(r.spotify_id)) {
        ids.push(r.spotify_id);
        seen.add(r.spotify_id);
        if (ids.length >= target) break;
      }
    }
  }
  return { ids, key };
}

function playlistName(bizName, dir) {
  const d = new Date();
  const today = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const title = dir.title_en || (dir.genres?.[0]) || 'Playlist';
  const clean = String(bizName || '').trim();
  return (clean ? `${clean} · ${title} · ${today}` : `${title} · ${today}`).slice(0, 100);
}

function hhmmToMins(s) {
  const [h, m] = String(s || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// ---------- planning pass (same guards as cron) ----------
async function planWork() {
  const now = new Date();
  const ilNow = ilPartsFromDate(now);
  console.log(`IL now: ${ilNow.isoDate} ${String(ilNow.hour).padStart(2,'0')}:${String(ilNow.minute).padStart(2,'0')} (dayIdx=${ilNow.dayIdx})`);

  const bizFilter = ONLY_BIZ ? `&id=eq.${ONLY_BIZ}` : '';
  const businesses = await sb(`businesses?select=id,owner_id,name,onboarding_expanded&order=created_at.asc&limit=500${bizFilter}`);
  console.log(`Considering ${businesses.length} businesses${ONLY_BIZ ? ` (--only=${ONLY_BIZ})` : ''}`);

  const plan = [];
  for (const biz of businesses) {
    const label = `${biz.name || '(unnamed)'} [${biz.id.slice(0, 8)}]`;
    if (!biz.onboarding_expanded) { console.log(`  skip ${label}: not-onboarding-done`); continue; }
    const hoursRows = await sb(`business_hours?business_id=eq.${biz.id}&select=hours&limit=1`);
    const hours = hoursRows[0]?.hours;
    if (!hours) { console.log(`  skip ${label}: no-hours`); continue; }
    const h = hours[ilNow.dayIdx];
    if (!h || h.closed) { console.log(`  skip ${label}: closed-today`); continue; }
    const expiryIso = dailyPlaylistExpiryIso({ hours, now });
    if (expiryIso && Date.parse(expiryIso) <= now.getTime()) { console.log(`  skip ${label}: past-close`); continue; }
    const openMins = hhmmToMins(h.open);
    if (openMins == null) { console.log(`  skip ${label}: bad-hours`); continue; }
    const nowMins = ilNow.hour * 60 + ilNow.minute;
    const minsToOpen = openMins - nowMins;
    if (minsToOpen > LEAD_MINUTES) { console.log(`  skip ${label}: too-early (opens in ${minsToOpen} min)`); continue; }
    const existing = await sb(`business_playlists?business_id=eq.${biz.id}&event_id=is.null&select=created_at&order=created_at.desc&limit=10`);
    const built = (existing || []).some((p) => String(p.created_at).slice(0, 10) === ilNow.isoDate);
    if (built) { console.log(`  skip ${label}: already-built-today`); continue; }
    const dirs = await sb(`business_directions?business_id=eq.${biz.id}&active=is.true&select=id,rank,title_en,description_he,genres,bpm_range,popularity_window,instrumentalness_preference&order=rank.asc.nullslast`);
    if (!dirs.length) { console.log(`  skip ${label}: no-directions`); continue; }
    plan.push({ biz, hours, dirs, expiryIso, ilNow });
    console.log(`  BUILD ${label}: ${dirs.length} directions, opens ${h.open}, target expires ${expiryIso}`);
  }
  return plan;
}

// ---------- build ----------
async function buildBusiness(item) {
  const { biz, hours, dirs, expiryIso, ilNow } = item;
  const dayMins  = dayMinutesFromHours(hours, ilNow.dayIdx);
  const target   = computeTargetTracks(dayMins);
  const popularityWindow = dirs.find((d) => Array.isArray(d.popularity_window))?.popularity_window || null;
  console.log(`\n--- ${biz.name} (${biz.id}) — target=${target} tracks/direction, ${dirs.length} directions ---`);
  let built = 0, failed = 0;
  for (const dir of dirs) {
    const t0 = Date.now();
    console.log(`  → building "${dir.title_en}"`);
    try {
      const { ids, key } = await fetchTracks(biz.id, dir, popularityWindow, target);
      if (!ids.length) { console.log(`    ✗ no tracks matched — skipping direction`); failed++; continue; }
      console.log(`    fetched ${ids.length} track ids from Supabase`);

      const name = playlistName(biz.name, dir);
      const desc = dir.description_he || '';
      const p    = await spCreatePlaylist(name, desc);
      console.log(`    created Spotify playlist ${p.id} — "${name}"`);
      await sleep(SLEEP_BETWEEN_SPOTIFY_CALLS_MS);

      await spAddTracksChunked(p.id, ids.map((id) => `spotify:track:${id}`));

      // Ledger — Prefer merge so a re-run doesn't 409 on duplicate PK.
      await sb('created_playlists', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          spotify_id:  p.id,
          name,
          expires_at:  expiryIso,
          owner_id:    biz.owner_id,
          business_id: biz.id,
        }),
      });

      // business_playlists row — this is what the dashboard reads.
      await sb('business_playlists', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          spotify_id:   p.id,
          business_id:  biz.id,
          url:          p.external_urls?.spotify || `https://open.spotify.com/playlist/${p.id}`,
          label:        dir.title_en,
          ico:          '🎵',
          track_count:  ids.length,
          genres:       dir.genres,
          bpm_range:    dir.bpm_range,
          expansion:    null,
          event_id:     null,
          direction_id: dir.id,
          track_ids:    ids,
          expanded_at:  null,
          expires_at:   expiryIso,
          created_at:   new Date().toISOString(),
        }),
      });

      // Track history — non-fatal on failure.
      try {
        await sb('v6_daily_track_history', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(ids.map((sid) => ({
            business_id:   biz.id,
            direction_key: key,
            spotify_id:    sid,
          }))),
        });
      } catch (e) {
        console.warn(`    (history insert failed, non-fatal: ${e.message})`);
      }

      built++;
      console.log(`    ✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      failed++;
      console.error(`    ✗ FAILED: ${e.message}`);
    }
    await sleep(SLEEP_BETWEEN_DIRECTIONS_MS);
  }
  console.log(`--- ${biz.name}: ${built} built, ${failed} failed ---`);
  return { built, failed };
}

// ---------- main ----------
(async () => {
  console.log(`build-today-oneoff — ${CONFIRM ? 'CONFIRM (will write)' : 'DRY-RUN'} — Spotify creds: ${USING_OVERRIDE ? 'SCRIPT_SPOTIFY_* override' : 'RUBIN_* (default)'}`);
  const plan = await planWork();
  console.log(`\n${plan.length} business(es) would be built:`);
  for (const item of plan) {
    console.log(`  ${item.biz.name} (${item.biz.id}) → ${item.dirs.length} directions`);
  }

  if (!plan.length) { console.log('\nNothing to build.'); return; }
  if (!CONFIRM) { console.log('\n(dry-run — pass --confirm to actually build)'); return; }

  console.log(`\n=== BUILDING (pacing: ${SLEEP_BETWEEN_SPOTIFY_CALLS_MS}ms per Spotify call, ${SLEEP_BETWEEN_DIRECTIONS_MS}ms between directions, ${SLEEP_BETWEEN_BUSINESSES_MS}ms between businesses) ===`);
  const t0 = Date.now();
  let totalBuilt = 0, totalFailed = 0;
  for (let i = 0; i < plan.length; i++) {
    const r = await buildBusiness(plan[i]);
    totalBuilt += r.built;
    totalFailed += r.failed;
    if (i < plan.length - 1) {
      console.log(`... sleeping ${SLEEP_BETWEEN_BUSINESSES_MS}ms before next business ...`);
      await sleep(SLEEP_BETWEEN_BUSINESSES_MS);
    }
  }
  console.log(`\n=== DONE — ${totalBuilt} playlists built, ${totalFailed} failed, ${((Date.now() - t0) / 1000).toFixed(1)}s total ===`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
