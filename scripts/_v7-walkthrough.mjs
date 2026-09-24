#!/usr/bin/env node
/**
 * Throwaway LIVE end-to-end walkthrough of the v7 onboarding front half.
 *
 * Drives the exact network-call sequence the v7 client makes, against a
 * running `vercel dev` (which reads cloud env → hits the migrated PROD
 * Supabase). Phase A builds NO Spotify playlists, so this is Gemini calls
 * + Supabase reads/writes only — no Spotify write volume.
 *
 * Sequence:
 *   1. generateMusicalDirections()  → real R1 8 probes (2 Gemini calls)
 *   2. simulate swipe (likes / dislikes / one super-liked genre + tally)
 *   3. one /api/v7/anchor-tracks call for a full 4-card page (v7_anchor_tracks RPC)
 *   4. generateTasteProfile()       → real flat 116-genre profile (1 Gemini call)
 *   5. POST /api/v7/account/signup (+ taste profile, email skipped via the
 *      internal key) → { business_id }, NO session (verification required)
 *   6. test-only owner session via admin generate_link + verify (stands in
 *      for the owner clicking the emailed magic link)
 *   7. POST /api/v7/account/set-delivery-mode  → business_v7_settings row
 *   8. VERIFY rows landed (service-role reads)
 *   9. TEARDOWN throwaway user + business (CASCADE)
 *
 * Usage (PowerShell, .env.local loaded, vercel dev on :3000):
 *   node scripts/_v7-walkthrough.mjs
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (verify + teardown),
 *   SUPABASE_ANON_KEY (test session), INTERNAL_API_KEY (skip the signup email —
 *   test addresses are @example.invalid; must match the key vercel dev runs with).
 * Endpoint env comes from vercel dev's cloud env.
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
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !INTERNAL_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / INTERNAL_API_KEY. Load .env.local first.');
  process.exit(1);
}

// ---- monkeypatch fetch: rewrite relative /api URLs to the dev server and
//      inject a localhost Origin so requireSite() passes. ----
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

// ---- dynamic import of the v7 client modules (they use relative /api fetch) ----
const mdUrl = pathToFileURL(join(repoRoot, 'v7', 'generation', 'musical-directions.js')).href;
const tpUrl = pathToFileURL(join(repoRoot, 'v7', 'generation', 'taste-profile.js')).href;

const stamp     = Date.now();
const testEmail = `test-v7walk-${stamp}@example.invalid`;
const bizName   = 'בר יין שכונתי (v7 walkthrough)';
const bizDesc   = 'בר יין קטן ואינטימי בלב תל אביב, אווירה בוהמיינית, קהל בגילאי 30-45, מוזיקה מגוונת ולא צפויה';
const atmospheres = ['אלגנטי', 'קליל'];
const musicalEmphases = 'אוהבים ג\'אז, סול וגרוב, פחות מוזיקה אלקטרונית קצבית';
const hours = { 0: { closed: true }, 1: { closed: false, open: '17:00', close: '01:00' }, 2: { closed: false, open: '17:00', close: '01:00' }, 3: { closed: false, open: '17:00', close: '01:00' }, 4: { closed: false, open: '17:00', close: '02:00' }, 5: { closed: false, open: '17:00', close: '02:00' }, 6: { closed: false, open: '17:00', close: '02:00' } };
const onboardingSessionId = `v7walk-${stamp}`;

let userId = null, businessId = null;

(async () => {
  try {
    console.log(`\n=== v7 LIVE WALKTHROUGH  (dev ${DEV_BASE}, session ${onboardingSessionId}) ===`);

    // --- STEP 1: R1 musical directions (2 real Gemini calls) ---
    console.log('\n[1/9] generateMusicalDirections (R1) ...');
    const { generateMusicalDirections } = await import(mdUrl);
    const r1 = await generateMusicalDirections({ bizName, bizDesc, atmospheres, musicalEmphases, place: null, onboardingSessionId });
    ok(!r1.error && Array.isArray(r1.directions) && r1.directions.length > 0, 'R1 page1 returned directions', r1.error || `len ${r1.directions?.length}`);
    if (r1.error) throw new Error(`R1 failed: ${r1.error} ${r1.reasoning_en || ''}`);
    let page2 = { directions: [] };
    if (r1.page2Promise) page2 = await r1.page2Promise;
    ok(!page2.error, 'R1 page2 resolved', page2.error || '');
    const round1Directions = [...r1.directions, ...(page2.directions || [])];
    ok(round1Directions.length >= 4, `R1 produced ${round1Directions.length} probes`, `${round1Directions.length}`);
    console.log('  probes:', round1Directions.map((d) => `#${d.rank} ${d.title_en} [${(d.genres || []).join(', ')}]`).join('\n         '));

    // --- STEP 2: simulate swipe decisions + per-genre tally ---
    console.log('\n[2/9] simulate swipe (likes / dislikes / super-like) ...');
    const likedDirections    = round1Directions.slice(0, 2);
    const dislikedDirections = round1Directions.slice(2, 4);
    const superLikedGenres   = (likedDirections[0]?.genres || []).slice(0, 1);
    const tally = new Map();
    const bump = (g, k) => { const t = tally.get(g) || { genre: g, like: 0, dislike: 0 }; t[k]++; tally.set(g, t); };
    likedDirections.forEach((d) => (d.genres || []).forEach((g) => bump(g, 'like')));
    dislikedDirections.forEach((d) => (d.genres || []).forEach((g) => bump(g, 'dislike')));
    const genreTally = [...tally.values()];
    ok(likedDirections.length === 2 && dislikedDirections.length === 2, 'swipe produced 2 liked / 2 disliked', '');
    ok(genreTally.length > 0 && superLikedGenres.length === 1, `tally ${genreTally.length} genres, 1 super-liked genre`, '');
    console.log(`  super-liked genre: ${superLikedGenres[0]}`);

    // --- STEP 3: one anchor-tracks call for a full swipe-deck page ---
    // Same request shape the real client (v7/preview.js fetchAnchorTracks)
    // sends for page 1: { specs: [{ rank, genre, inst_pref, pop_pref }] × 4 }
    // → { byRank }. A full 4-card page, not a single card: the 2026-09-23
    // swipe-deck outage only reproduced at page size (single cards squeaked
    // under the old anon 3s timeout).
    console.log('\n[3/9] /api/v7/anchor-tracks, 4-card page ...');
    const anchorSpecs = round1Directions.slice(0, 4).map((d) => ({
      rank: d.rank,
      genre: d === likedDirections[0] ? superLikedGenres[0] : (d.genres || [])[0],
      inst_pref: d.instrumentalness_preference || 'none',
      pop_pref:  d.popularity_preference       || 'none',
    }));
    const anchorT0 = Date.now();
    const anchorRes = await fetch('/api/v7/anchor-tracks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specs: anchorSpecs }),
    });
    const anchorJson = await anchorRes.json().catch(() => ({}));
    ok(anchorRes.ok, `anchor-tracks responded ${anchorRes.status} in ${Date.now() - anchorT0}ms`, JSON.stringify(anchorJson).slice(0, 160));
    const anchorHits = Object.keys(anchorJson?.byRank || {}).length;
    ok(anchorHits >= 3, `anchor-tracks returned ${anchorHits}/${anchorSpecs.length} cards`, JSON.stringify(anchorJson).slice(0, 160));
    const superLikedTracks = [];
    if (anchorRes.ok) {
      const tid = anchorJson?.byRank?.[String(likedDirections[0].rank)] || null;
      if (tid) superLikedTracks.push(tid);
      console.log(`  anchor track for super-like: ${tid || '(none — pool may be thin for this genre; continuing)'}`);
    }

    // --- STEP 4: taste profile (1 real Gemini call) ---
    console.log('\n[4/9] generateTasteProfile ...');
    const { generateTasteProfile, profileCoverage } = await import(tpUrl);
    const tp = await generateTasteProfile({
      bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases: '',
      round1Directions, round2Directions: [],
      likedDirections, dislikedDirections, superLikedGenres,
      instrumentalnessPreference: likedDirections[0]?.instrumentalness_preference || 'none',
      popularityPreference: likedDirections[0]?.popularity_preference || 'none',
      onboardingSessionId,
    });
    ok(!tp.error && tp.profile, 'taste profile returned', tp.error ? `${tp.error} ${tp.reasoning_en || ''}` : '');
    if (tp.error) throw new Error(`taste profile failed: ${tp.error} ${tp.reasoning_en || ''}`);
    const profile = tp.profile;
    const coverage = profileCoverage(profile);
    ok(coverage.size === 116, `all 116 genres bucketed (sum = ${coverage.size})`, `${coverage.size}`);
    ok(profile.energy_levels_total >= 2 && profile.energy_levels_total <= 6, `energy_levels_total in [2..6] (${profile.energy_levels_total})`, `${profile.energy_levels_total}`);
    console.log(`  approved ${profile.approved_genres.length} / conditional ${profile.conditional_genres.length} / excluded ${profile.excluded_genres.length}  · N=${profile.energy_levels_total}`);

    // --- STEP 5: signup (after payment + the bar; carries the taste profile) ---
    // skipEmail + the internal key: the test address is @example.invalid, so a
    // real magic-link send would bounce. Real owners always get the email.
    console.log('\n[5/9] POST /api/v7/account/signup ...');
    const signupRes = await fetch('/api/v7/account/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_KEY },
      body: JSON.stringify({
        email: testEmail, name: bizName, description: bizDesc, musicalEmphases,
        atmospheres, place: null, hours, longestMinutes: 540,
        superLikedTracks, onboardingSessionId,
        tasteProfile: profile, genreTally, skipEmail: true,
      }),
    });
    const signup = await signupRes.json().catch(() => ({}));
    ok(signupRes.ok && signup.ok && signup.business_id, `signup ok (biz ${signup.business_id || '?'})`, JSON.stringify(signup).slice(0, 200));
    ok(!('session' in signup), 'signup returns NO session (email verification required)', JSON.stringify(signup).slice(0, 200));
    ok(signup.emailed === false, 'email skipped for the internal test caller', `emailed=${signup.emailed}`);
    if (!signup.business_id) throw new Error(`signup did not return business_id: ${JSON.stringify(signup).slice(0, 200)}`);
    businessId = signup.business_id;

    // --- STEP 6: test-only owner session (stands in for clicking the magic link) ---
    console.log('\n[6/9] test-only owner session via admin generate_link + verify ...');
    const gen = await realFetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST', headers: HDR, body: JSON.stringify({ type: 'magiclink', email: testEmail }) }).then((r) => r.json());
    const ver = await realFetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: gen?.hashed_token || gen?.properties?.hashed_token }) }).then((r) => r.json());
    ok(!!ver?.access_token, 'test session minted', JSON.stringify(ver).slice(0, 160));
    if (!ver?.access_token) throw new Error('could not mint a test session');
    const accessToken = ver.access_token;
    userId = ver.user?.id || null;
    console.log(`  business_id ${businessId} · user ${userId}`);

    // --- STEP 7: set delivery mode (owner JWT) ---
    console.log('\n[7/9] POST /api/v7/account/set-delivery-mode ...');
    const modeRes = await fetch('/api/v7/account/set-delivery-mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ business_id: businessId, delivery_mode: 'option1' }),
    });
    const mode = await modeRes.json().catch(() => ({}));
    ok(modeRes.ok && mode.ok && mode.delivery_mode === 'option1', `set-delivery-mode ok (${modeRes.status})`, JSON.stringify(mode).slice(0, 200));

    // --- STEP 8: verify rows via service role ---
    console.log('\n[8/9] verify rows landed ...');
    const [bizRow] = await pgr('GET', 'businesses', { query: { id: `eq.${businessId}`, select: 'id,name,version,paid_at,business_description,musical_emphases' } });
    ok(bizRow?.version === 'v7', `businesses.version = 'v7'`, `got ${bizRow?.version}`);
    ok(!!bizRow?.paid_at, 'businesses.paid_at set', `got ${bizRow?.paid_at}`);
    ok(bizRow?.business_description === bizDesc, 'business_description persisted', '');

    const tpRows = await pgr('GET', 'business_taste_profiles', { query: { business_id: `eq.${businessId}`, select: '*' } });
    const tpRow = tpRows?.[0];
    ok(!!tpRow, 'business_taste_profiles row exists', `got ${tpRows?.length}`);
    if (tpRow) {
      ok(tpRow.energy_levels_total === profile.energy_levels_total, `energy_levels_total persisted (${tpRow.energy_levels_total})`, '');
      ok(Array.isArray(tpRow.approved_genres) && tpRow.approved_genres.length === profile.approved_genres.length, 'approved_genres persisted', '');
      ok(Array.isArray(tpRow.audit_tally) && tpRow.audit_tally.length === genreTally.length, `audit_tally persisted (${tpRow.audit_tally?.length})`, '');
    }

    const [setRow] = await pgr('GET', 'business_v7_settings', { query: { business_id: `eq.${businessId}`, select: 'business_id,delivery_mode' } });
    ok(setRow?.delivery_mode === 'option1', `business_v7_settings.delivery_mode = 'option1'`, `got ${setRow?.delivery_mode}`);

    const [hoursRow] = await pgr('GET', 'business_hours', { query: { business_id: `eq.${businessId}`, select: 'business_id,longest_minutes' } });
    ok(!!hoursRow, 'business_hours row exists', '');

    const slRows = await pgr('GET', 'super_liked_tracks', { query: { business_id: `eq.${businessId}`, select: 'spotify_id' } });
    ok(slRows.length === superLikedTracks.length, `super_liked_tracks rows = ${superLikedTracks.length}`, `got ${slRows.length}`);

    const dirRows = await pgr('GET', 'business_directions', { query: { business_id: `eq.${businessId}`, select: 'id' } });
    ok(dirRows.length === 0, 'NO business_directions rows (v7 has none)', `got ${dirRows.length}`);

    console.log('\n[9/9] (teardown runs in finally)');
  } catch (err) {
    console.error(`\nWALKTHROUGH ABORTED: ${err.message}`);
    failed++;
  } finally {
    console.log('\n=== TEARDOWN ===');
    try {
      if (businessId) { await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } }); console.log(`  business ${businessId} deleted (CASCADE)`); }
      if (userId)     { await authAdmin('DELETE', `/auth/v1/admin/users/${userId}`); console.log(`  user ${userId} deleted`); }
      else if (testEmail) {
        // Fallback: find the user by email if signup succeeded but we lost the id.
        const list = await authAdmin('GET', `/auth/v1/admin/users?per_page=200`);
        const u = (list?.users || []).find((x) => x.email === testEmail);
        if (u) { await authAdmin('DELETE', `/auth/v1/admin/users/${u.id}`); console.log(`  user ${u.id} deleted (by email)`); }
      }
    } catch (e) { console.warn(`  cleanup issue: ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
