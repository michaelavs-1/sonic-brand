#!/usr/bin/env node
/**
 * Throwaway LIVE end-to-end walkthrough of the v7 Phase B daily-playlist path.
 *
 * ⚠️  BLAST RADIUS — READ BEFORE RUNNING:
 *   Unlike the Phase A walkthrough (Gemini + Supabase only), this script makes
 *   REAL Spotify writes to the SHARED "Robin - Sonic Brands" account. It
 *   creates ~6 real playlists (4 for the option1 business, 2 for option2),
 *   then unfollows them again as part of the run. It cleans up after itself
 *   (Spotify unfollow + ledger mark + CASCADE delete + user delete), but if it
 *   aborts hard mid-run you may need to run `scripts/purge-rubin-playlists.mjs`
 *   to sweep stragglers.
 *
 * WHAT IT VERIFIES (Phase B deliverables B1/B1b/B2/B3):
 *   - B1-wire path: generateEnergyDirections + save-energy-directions persists
 *     ≥2 high + ≥2 low rows into business_v7_directions.
 *   - B3 cron: /api/cron/v7-generate-daily (CRON_SECRET) picks up both v7
 *     businesses in one tick and branches on delivery_mode.
 *   - B1b buildOption1Batch: 4 business_playlists rows (2 high + 2 low), every
 *     one with direction_id = NULL (the v6-FK constraint), each with a matching
 *     created_playlists ledger row.
 *   - B2 buildOption2Batch: 2 full-length business_playlists rows, direction_id
 *     NULL, ledger rows present.
 *   - expire sweep: /api/cron/expire-playlists sweeps v7 playlists (they live
 *     in created_playlists) — proves the version-agnostic expiry cron covers v7.
 *
 * SCOPE NOTE: Phase A's prompts (R1 / taste-profile) are already verified, so
 * this script runs them ONCE to get a real, canonical-genre taste profile and
 * reuses it for BOTH throwaway businesses. Only generateEnergyDirections (the
 * Phase B prompt) plus the builders + cron are the focus here.
 *
 * WHY TWO BUSINESSES: the cron's `already-built-today` guard is per-business,
 * so option1 and option2 need separate businesses to both build in one tick.
 *
 * DEV-SERVER REQUIREMENT: the v7 cron POSTs SERVER-TO-SERVER to /api/new/spotify
 * via resolveSpotifyBase(), which in `vercel dev` resolves to
 * http://127.0.0.1:3000 (VERCEL_URL unset → the '127.0.0.1:3000' fallback).
 * So `vercel dev` MUST run on the DEFAULT port 3000, and this script must
 * target the same port. DEV_PORT therefore defaults to 3000 (not 3009).
 *
 * Usage (PowerShell, from repo root):
 *   # 1. Start the dev server on the default port in another terminal:
 *   #      vercel dev            (do NOT pass --listen; leave it on :3000)
 *   # 2. Load .env.local into the current shell:
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   # 3. Run:
 *   node scripts/_v7-phaseb-walkthrough.mjs
 *
 * Env required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (verify + teardown reads/writes)
 *   CRON_SECRET                              (trigger both crons)
 *   RUBIN_SPOTIFY_CLIENT_ID / _CLIENT_SECRET / RUBIN_REFRESH_TOKEN
 *                                            (teardown unfollow — optional but
 *                                             strongly recommended; without it
 *                                             stragglers are left for the purge
 *                                             script)
 * Endpoint-side env (GEMINI_API_KEY, RUBIN_*, etc.) comes from vercel dev's
 * cloud env — this script never calls Gemini/Spotify directly except the
 * teardown unfollow.
 */

import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');

const DEV_PORT = process.env.DEV_PORT || '3000';
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
// ANON_KEY: mint a test owner session (stands in for clicking the emailed
// magic link — v7 signup requires email verification and returns no session).
// INTERNAL_KEY: lets signup skip the email for our @example.invalid addresses.
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !INTERNAL_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / INTERNAL_API_KEY. Load .env.local first.');
  process.exit(1);
}
if (!CRON_SECRET) {
  console.error('Missing CRON_SECRET — required to trigger the v7 + expire crons. Load .env.local first.');
  process.exit(1);
}

// Rubin creds — optional. Without them, teardown can't unfollow (the expire
// sweep step usually handles the Spotify side anyway; anything left is a
// purge-rubin-playlists.mjs job).
const RUBIN_ID     = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const RUBIN_SECRET = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const RUBIN_TOKEN  = process.env.RUBIN_REFRESH_TOKEN;
const RUBIN_OK     = !!(RUBIN_ID && RUBIN_SECRET && RUBIN_TOKEN);
if (!RUBIN_OK) {
  console.warn('WARN: RUBIN_SPOTIFY_* env not fully set — teardown will rely on the expire-cron sweep only.');
}

// ---- monkeypatch fetch: rewrite relative /api URLs to the dev server and
//      inject a localhost Origin so requireSite() passes. Preserves any
//      Authorization header the caller set (used for the CRON_SECRET triggers).
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  let url = typeof input === 'string' ? input : input?.url;
  if (typeof url === 'string' && url.startsWith('/')) {
    url = DEV_BASE + url;
    const headers = new Headers(init.headers || {});
    if (!headers.has('Origin')) headers.set('Origin', DEV_BASE);
    return realFetch(url, { ...init, headers });
  }
  return realFetch(input, init);
};

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}

// ---- service-role PostgREST + GoTrue admin helpers (verify + teardown) ----
const HDR = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function pgr(method, path, { body, query, prefer } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (query) { const qs = new URLSearchParams(query).toString(); if (qs) url += `?${qs}`; }
  const r = await realFetch(url, { method, headers: prefer ? { ...HDR, Prefer: prefer } : HDR, body: body == null ? undefined : JSON.stringify(body) });
  const txt = await r.text(); let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) { const e = new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`); e.status = r.status; throw e; }
  return data;
}
async function authAdmin(method, path) {
  const r = await realFetch(`${SUPABASE_URL}${path}`, { method, headers: HDR });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

// ---- Rubin Spotify teardown helpers (copied from purge-rubin-playlists.mjs,
//      made tolerant of already-gone playlists). Uses realFetch — these are
//      absolute Spotify URLs, not /api relative. ----
async function refreshRubinToken() {
  const basic = Buffer.from(`${RUBIN_ID}:${RUBIN_SECRET}`).toString('base64');
  const r = await realFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RUBIN_TOKEN }),
  });
  if (!r.ok) throw new Error(`Rubin token refresh failed: ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return (await r.json()).access_token;
}
async function spotifyUnfollow(token, playlistId) {
  const r = await realFetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  if (r.ok) return 'unfollowed';
  if ([400, 403, 404, 410].includes(r.status)) return `already-gone(${r.status})`;
  throw new Error(`unfollow ${playlistId} → ${r.status}`);
}
async function markLedgerDeleted(spotifyId) {
  try {
    await pgr('PATCH', 'created_playlists', {
      query: { spotify_id: `eq.${spotifyId}` },
      body: { deleted_at: new Date().toISOString(), error: null },
      prefer: 'return=minimal',
    });
  } catch (e) { console.warn(`    ledger mark failed for ${spotifyId}: ${e.message}`); }
}

// ---- dynamic import of the v7 client modules (relative /api fetch) ----
const mdUrl = pathToFileURL(join(repoRoot, 'v7', 'generation', 'musical-directions.js')).href;
const tpUrl = pathToFileURL(join(repoRoot, 'v7', 'generation', 'taste-profile.js')).href;
const edUrl = pathToFileURL(join(repoRoot, 'v7', 'generation', 'energy-directions.js')).href;
const plUrl = pathToFileURL(join(repoRoot, 'v7', 'generation', 'playlist-length.js')).href;

const stamp = Date.now();
const bizName = 'בר יין שכונתי (v7 Phase B)';
const bizDesc = 'בר יין קטן ואינטימי בלב תל אביב, אווירה בוהמיינית, קהל בגילאי 30-45, מוזיקה מגוונת ולא צפויה';
const atmospheres = ['אלגנטי', 'קליל'];
const musicalEmphases = 'אוהבים ג\'אז, סול וגרוב, פחות מוזיקה אלקטרונית קצבית';
const onboardingSessionId = `v7phaseb-${stamp}`;

// Track every business/user we create so `finally` can tear them down even on
// a mid-run abort.
const created = []; // { mode, businessId, userId, accessToken }

// Build a hours object where TODAY (IL) is OPEN and inside the cron's build
// window, and no other day matters. Guarantees the cron passes closed-today,
// past-close, and too-early guards:
//   - open  ≈ now − 60min  (already open by an hour → minsToOpen ≤ 0 ≤ LEAD)
//   - close ≈ now + 6h, clamped to 23:59 so we never trip the overnight-wrap
//     branch of dailyPlaylistExpiryIso (which would move close+2h to tomorrow —
//     still valid, but keeping it same-day is simpler to reason about).
// close+2h is always strictly after now, so past-close never fires.
function computeTodayHours(ilNow) {
  const nowMins = ilNow.hour * 60 + ilNow.minute;
  let openMins  = Math.max(0, nowMins - 60);
  let closeMins = Math.min(1439, nowMins + 360);
  if (closeMins - openMins < 60) closeMins = Math.min(1439, openMins + 60);
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const hours = {};
  for (let d = 0; d < 7; d++) hours[d] = { closed: true };
  hours[ilNow.dayIdx] = { closed: false, open: fmt(openMins), close: fmt(closeMins) };
  return { hours, longestMinutes: closeMins - openMins };
}

// Test-only owner session: admin generate_link + verify. Stands in for the
// owner clicking the emailed magic link (real signups return no session).
async function mintTestSession(email) {
  const gen = await realFetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: HDR, body: JSON.stringify({ type: 'magiclink', email }) }).then((r) => r.json());
  const ver = await realFetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gen?.hashed_token || gen?.properties?.hashed_token }) }).then((r) => r.json());
  if (!ver?.access_token) throw new Error(`test session mint failed: ${JSON.stringify(ver).slice(0, 160)}`);
  return ver;
}

// Provision one throwaway v7 business fully: signup (carries the taste
// profile; email skipped via the internal key) → test session →
// set-delivery-mode → (option1 only) save-energy-directions → backdate the
// mode timestamp. Returns the tracking record (also pushed onto `created`).
async function provision({ mode, profile, genreTally, energyDirections, hours, longestMinutes }) {
  const email = `test-v7pb-${mode}-${stamp}@example.invalid`;

  const signupRes = await fetch('/api/v7/account/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_KEY },
    body: JSON.stringify({
      email, name: bizName, description: bizDesc, musicalEmphases,
      atmospheres, place: null, hours, longestMinutes,
      superLikedTracks: [], onboardingSessionId: `${onboardingSessionId}-${mode}`,
      tasteProfile: profile, genreTally, skipEmail: true,
    }),
  });
  const signup = await signupRes.json().catch(() => ({}));
  if (!signupRes.ok || !signup.business_id) {
    throw new Error(`signup(${mode}) failed: ${JSON.stringify(signup).slice(0, 200)}`);
  }
  const session = await mintTestSession(email);
  const rec = {
    mode, email,
    businessId:  signup.business_id,
    userId:      session.user?.id || null,
    accessToken: session.access_token,
  };
  created.push(rec);
  console.log(`  [${mode}] signup ok (profile saved, no session returned) — biz ${rec.businessId} · user ${rec.userId}`);

  const modeRes = await fetch('/api/v7/account/set-delivery-mode', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rec.accessToken}` },
    body: JSON.stringify({ business_id: rec.businessId, delivery_mode: mode }),
  });
  const modeJson = await modeRes.json().catch(() => ({}));
  if (!modeRes.ok || modeJson.delivery_mode !== mode) throw new Error(`set-delivery-mode(${mode}) failed: ${JSON.stringify(modeJson).slice(0, 200)}`);

  if (mode === 'option1') {
    const edRes = await fetch('/api/v7/account/save-energy-directions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rec.accessToken}` },
      body: JSON.stringify({ business_id: rec.businessId, directions: energyDirections }),
    });
    const ed = await edRes.json().catch(() => ({}));
    if (!edRes.ok || !ed.ok) throw new Error(`save-energy-directions failed: ${JSON.stringify(ed).slice(0, 200)}`);
    console.log(`  [${mode}] save-energy-directions ok — count ${ed.count}`);
  }

  // The v7 cron skips a business for 15 min after a delivery-mode change
  // (`mode-just-set` — the dashboard builds day 1 itself). This test drives
  // the cron directly, so backdate the mode timestamp past that window.
  await pgr('PATCH', 'business_v7_settings', {
    query: { business_id: `eq.${rec.businessId}` },
    body: { updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    prefer: 'return=minimal',
  });
  return rec;
}

(async () => {
  try {
    console.log(`\n=== v7 PHASE B WALKTHROUGH  (dev ${DEV_BASE}, session ${onboardingSessionId}) ===`);
    console.log('    NOTE: this creates ~6 real Spotify playlists and unfollows them again.\n');

    const { ilPartsFromDate } = await import(plUrl);
    const now = new Date();
    const ilNow = ilPartsFromDate(now);
    const { hours, longestMinutes } = computeTodayHours(ilNow);
    console.log(`  IL now ${ilNow.isoDate} ${String(ilNow.hour).padStart(2, '0')}:${String(ilNow.minute).padStart(2, '0')} (dayIdx ${ilNow.dayIdx})`);
    console.log(`  today's test hours: open ${hours[ilNow.dayIdx].open} close ${hours[ilNow.dayIdx].close}`);

    // --- STEP 1: R1 musical directions (2 Gemini calls) ---
    console.log('\n[1/10] generateMusicalDirections (R1) ...');
    const { generateMusicalDirections } = await import(mdUrl);
    const r1 = await generateMusicalDirections({ bizName, bizDesc, atmospheres, musicalEmphases, place: null, onboardingSessionId });
    if (r1.error) throw new Error(`R1 failed: ${r1.error} ${r1.reasoning_en || ''}`);
    let page2 = { directions: [] };
    if (r1.page2Promise) page2 = await r1.page2Promise;
    const round1Directions = [...r1.directions, ...(page2.directions || [])];
    ok(round1Directions.length >= 4, `R1 produced ${round1Directions.length} probes`, `${round1Directions.length}`);

    // --- STEP 2: simulate swipe (likes / dislikes / super-like) ---
    console.log('\n[2/10] simulate swipe ...');
    const likedDirections    = round1Directions.slice(0, 3);
    const dislikedDirections = round1Directions.slice(3, 5);
    const superLikedGenres   = (likedDirections[0]?.genres || []).slice(0, 1);
    const tally = new Map();
    const bump = (g, k) => { const t = tally.get(g) || { genre: g, like: 0, dislike: 0 }; t[k]++; tally.set(g, t); };
    likedDirections.forEach((d) => (d.genres || []).forEach((g) => bump(g, 'like')));
    dislikedDirections.forEach((d) => (d.genres || []).forEach((g) => bump(g, 'dislike')));
    const genreTally = [...tally.values()];
    ok(likedDirections.length >= 2, `swipe produced ${likedDirections.length} liked`, '');

    // --- STEP 3: taste profile (1 Gemini call) ---
    console.log('\n[3/10] generateTasteProfile ...');
    const { generateTasteProfile, profileCoverage } = await import(tpUrl);
    const tp = await generateTasteProfile({
      bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases: '',
      round1Directions, round2Directions: [],
      likedDirections, dislikedDirections, superLikedGenres,
      instrumentalnessPreference: likedDirections[0]?.instrumentalness_preference || 'none',
      popularityPreference: likedDirections[0]?.popularity_preference || 'none',
      onboardingSessionId,
    });
    if (tp.error) throw new Error(`taste profile failed: ${tp.error} ${tp.reasoning_en || ''}`);
    const profile = tp.profile;
    const coverage = profileCoverage(profile);
    ok(coverage.size === 116, `all 116 genres bucketed (${coverage.size})`, `${coverage.size}`);
    ok(profile.approved_genres.length > 0, `approved_genres non-empty (${profile.approved_genres.length})`, '');
    console.log(`  approved ${profile.approved_genres.length} / conditional ${profile.conditional_genres.length} / excluded ${profile.excluded_genres.length} · N=${profile.energy_levels_total}`);

    // --- STEP 4: energy directions (1 Gemini call — the Phase B prompt) ---
    console.log('\n[4/10] generateEnergyDirections ...');
    const { generateEnergyDirections } = await import(edUrl);
    const ed = await generateEnergyDirections({
      tasteProfile: profile, bizName, bizDesc, atmospheres, musicalEmphases,
      place: null, onboardingSessionId,
    });
    if (ed.error) throw new Error(`energy directions failed: ${ed.error} ${ed.reasoning_en || ''}`);
    const energyDirections = ed.directions;
    const edHigh = energyDirections.filter((d) => d.energy_tier === 'high').length;
    const edLow  = energyDirections.filter((d) => d.energy_tier === 'low').length;
    ok(edHigh >= 2 && edLow >= 2, `energy directions ≥2 high + ≥2 low (got ${edHigh} high / ${edLow} low)`, JSON.stringify(energyDirections.map((d) => `${d.energy_tier}:${d.title_en}`)));
    console.log('  ' + energyDirections.map((d) => `[${d.energy_tier}] ${d.title_en} {${d.genres.join(', ')}}`).join('\n  '));

    // --- STEP 5: provision the option1 business ---
    console.log('\n[5/10] provision option1 business ...');
    const biz1 = await provision({ mode: 'option1', profile, genreTally, energyDirections, hours, longestMinutes });

    // --- STEP 6: provision the option2 business ---
    console.log('\n[6/10] provision option2 business ...');
    const biz2 = await provision({ mode: 'option2', profile, genreTally, energyDirections: null, hours, longestMinutes });

    // --- STEP 7: verify business_v7_directions for option1 ---
    console.log('\n[7/10] verify business_v7_directions (option1) ...');
    const v7dirs = await pgr('GET', 'business_v7_directions', { query: { business_id: `eq.${biz1.businessId}`, active: 'is.true', select: 'energy_tier,rank,title_en,genres' } });
    const dbHigh = v7dirs.filter((d) => d.energy_tier === 'high').length;
    const dbLow  = v7dirs.filter((d) => d.energy_tier === 'low').length;
    ok(dbHigh >= 2 && dbLow >= 2, `persisted ≥2 high + ≥2 low (got ${dbHigh} high / ${dbLow} low)`, `${v7dirs.length} rows`);

    // --- STEP 8: trigger the v7 cron once (builds BOTH businesses this tick) ---
    console.log('\n[8/10] trigger /api/cron/v7-generate-daily ...');
    const cronRes = await fetch('/api/cron/v7-generate-daily', {
      method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    const cron = await cronRes.json().catch(() => ({}));
    ok(cronRes.ok && cron.ok, `v7 cron responded ${cronRes.status}`, JSON.stringify(cron).slice(0, 300));
    const b1res = (cron.breakdown || []).find((r) => r.id === biz1.businessId);
    const b2res = (cron.breakdown || []).find((r) => r.id === biz2.businessId);
    console.log(`  option1 → ${JSON.stringify(b1res)}`);
    console.log(`  option2 → ${JSON.stringify(b2res)}`);
    ok(b1res && b1res.built === 4, `option1 built 4 playlists`, JSON.stringify(b1res));
    ok(b2res && b2res.built === 2, `option2 built 2 playlists`, JSON.stringify(b2res));

    // --- STEP 9: verify business_playlists + ledger ---
    console.log('\n[9/10] verify business_playlists + created_playlists ledger ...');
    const pl1 = await pgr('GET', 'business_playlists', { query: { business_id: `eq.${biz1.businessId}`, select: 'spotify_id,label,direction_id,track_count,event_id' } });
    const pl2 = await pgr('GET', 'business_playlists', { query: { business_id: `eq.${biz2.businessId}`, select: 'spotify_id,label,direction_id,track_count,event_id' } });
    ok(pl1.length === 4, `option1 has 4 business_playlists rows`, `got ${pl1.length}`);
    ok(pl2.length === 2, `option2 has 2 business_playlists rows`, `got ${pl2.length}`);
    ok(pl1.every((p) => p.direction_id === null), `option1 rows all direction_id NULL (v6-FK safe)`, JSON.stringify(pl1.map((p) => p.direction_id)));
    ok(pl2.every((p) => p.direction_id === null), `option2 rows all direction_id NULL (v6-FK safe)`, JSON.stringify(pl2.map((p) => p.direction_id)));

    const allIds = [...pl1, ...pl2].map((p) => p.spotify_id).filter(Boolean);
    console.log(`  built spotify_ids: ${allIds.join(', ')}`);
    if (allIds.length) {
      const ledger = await pgr('GET', 'created_playlists', { query: { spotify_id: `in.(${allIds.join(',')})`, select: 'spotify_id,expires_at,deleted_at' } });
      ok(ledger.length === allIds.length, `ledger has a row per built playlist (${ledger.length}/${allIds.length})`, '');
      ok(ledger.every((r) => !r.deleted_at), `ledger rows not yet deleted`, '');
    }

    // --- STEP 10: expire sweep — prove the version-agnostic cron covers v7 ---
    // Force the test rows past expiry, then trigger the expire cron. This also
    // does the real Spotify unfollow, so it doubles as teardown for these rows.
    console.log('\n[10/10] expire sweep via /api/cron/expire-playlists ...');
    if (allIds.length) {
      const pastIso = new Date(Date.now() - 60 * 1000).toISOString();
      await pgr('PATCH', 'created_playlists', {
        query: { spotify_id: `in.(${allIds.join(',')})` },
        body: { expires_at: pastIso },
        prefer: 'return=minimal',
      });
      const expRes = await fetch('/api/cron/expire-playlists', {
        method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      const exp = await expRes.json().catch(() => ({}));
      ok(expRes.ok, `expire cron responded ${expRes.status}`, JSON.stringify(exp).slice(0, 200));
      const after = await pgr('GET', 'created_playlists', { query: { spotify_id: `in.(${allIds.join(',')})`, select: 'spotify_id,deleted_at' } });
      const sweptCount = after.filter((r) => r.deleted_at).length;
      ok(sweptCount === allIds.length, `expire cron swept all ${allIds.length} v7 playlists`, `swept ${sweptCount}`);
    } else {
      ok(false, 'expire sweep skipped — no playlists were built', '');
    }
  } catch (err) {
    console.error(`\nWALKTHROUGH ABORTED: ${err.message}`);
    failed++;
  } finally {
    console.log('\n=== TEARDOWN ===');
    let rubinToken = null;
    if (RUBIN_OK) { try { rubinToken = await refreshRubinToken(); } catch (e) { console.warn(`  Rubin token refresh failed: ${e.message}`); } }
    for (const rec of created) {
      try {
        // Enumerate this business's playlists BEFORE deleting the business
        // (CASCADE would remove business_playlists). Unfollow any not-yet-swept.
        let ids = [];
        try {
          const rows = await pgr('GET', 'business_playlists', { query: { business_id: `eq.${rec.businessId}`, select: 'spotify_id' } });
          ids = rows.map((r) => r.spotify_id).filter(Boolean);
        } catch { /* ignore */ }
        for (const id of ids) {
          if (rubinToken) {
            try { const s = await spotifyUnfollow(rubinToken, id); if (s === 'unfollowed') await markLedgerDeleted(id); }
            catch (e) { console.warn(`    unfollow ${id} failed: ${e.message}`); }
          }
        }
        await pgr('DELETE', 'businesses', { query: { id: `eq.${rec.businessId}` } });
        console.log(`  [${rec.mode}] business ${rec.businessId} deleted (CASCADE), ${ids.length} playlist(s) handled`);
        if (rec.userId) { await authAdmin('DELETE', `/auth/v1/admin/users/${rec.userId}`); console.log(`  [${rec.mode}] user ${rec.userId} deleted`); }
      } catch (e) { console.warn(`  [${rec.mode}] cleanup issue: ${e.message}`); }
    }
    if (!RUBIN_OK) console.warn('  NOTE: Rubin creds absent — if any playlists were NOT swept by the expire step, run scripts/purge-rubin-playlists.mjs --confirm');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
