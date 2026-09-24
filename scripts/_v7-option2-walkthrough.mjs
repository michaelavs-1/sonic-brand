#!/usr/bin/env node
/**
 * v7 Option 2 (energy timeline) — LIVE end-to-end walkthrough.
 *
 * Runs against `vercel dev` (default :3000) → prod Supabase + REAL Spotify.
 * Creates ~6 real Spotify playlists on Rubin's account and unfollows them
 * again in teardown. Throwaway user/business, self-cleaning (CASCADE delete +
 * user delete). Fixture taste profile → no Gemini calls.
 *
 * Needs migration v5/precompute/migrations/2026-09-24-v7-timeline-pool.sql.
 *
 * What it checks:
 *   1. set-delivery-mode option2 with a 2-group timeline → stored normalised;
 *      no live playlists yet → replace.eligible false.
 *   2. v7 update-hours → the timeline follows the hours (clock times kept).
 *   3. generate-daily → 2 "Daily Mix" playlists: disjoint tracks, durations
 *      cover [max(now, opening), closing + 30], per-track levels recorded,
 *      ledger rows expire close + 2h.
 *   4. update-timeline → replace.eligible true, 2 left.
 *   5. generate-daily replaceToday → new set; old rows hidden from the
 *      dashboard (business_playlists.expires_at ≤ now) but their ledger rows
 *      keep the original expiry (a phone still playing them isn't cut off).
 *   6. two replaceToday calls at once → one is refused 'build-in-progress'.
 *   7. a 3rd replacement → 429 'replace-cap'.
 *
 * Usage (PowerShell, from the repo root):
 *   Get-Content .env.local | ForEach-Object { if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') { Set-Item "env:$($matches[1])" $matches[2] } }
 *   node scripts/_v7-option2-walkthrough.mjs
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *      INTERNAL_API_KEY (must match vercel dev's), RUBIN_SPOTIFY_CLIENT_ID /
 *      _SECRET / RUBIN_REFRESH_TOKEN (teardown unfollow; optional — without
 *      them run scripts/purge-rubin-playlists.mjs --confirm afterwards).
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_BASE = `http://127.0.0.1:${process.env.DEV_PORT || '3000'}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !INTERNAL_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / INTERNAL_API_KEY. Load .env.local first.');
  process.exit(1);
}
const RUBIN_OK = !!(process.env.RUBIN_SPOTIFY_CLIENT_ID && process.env.RUBIN_SPOTIFY_CLIENT_SECRET && process.env.RUBIN_REFRESH_TOKEN);

const { reconcileTimeline, businessWindowAt, fmtHM } = await import(pathToFileURL(join(repoRoot, 'v7/generation/energy-timeline.js')).href);
const { ilPartsFromDate } = await import(pathToFileURL(join(repoRoot, 'v7/generation/playlist-length.js')).href);

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
};

const HDR = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function pgr(method, path, { body, query, prefer } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (query) url += `?${new URLSearchParams(query)}`;
  const r = await fetch(url, { method, headers: prefer ? { ...HDR, Prefer: prefer } : HDR, body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${typeof d === 'string' ? d : JSON.stringify(d)}`);
  return d;
}
const api = (path, { token, body, internal } = {}) => fetch(`${DEV_BASE}${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Origin: DEV_BASE,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(internal ? { 'x-sonic-internal': INTERNAL_KEY } : {}),
  },
  body: JSON.stringify(body || {}),
});
// generate-daily streams ndjson; collect the whole stream.
async function build(token, businessId, extra = {}) {
  const r = await api('/api/v7/account/generate-daily', { token, body: { businessId, bizName: 'Option2 walkthrough', ...extra } });
  const text = await r.text();
  if (!r.ok) { let j = {}; try { j = JSON.parse(text); } catch { } return { status: r.status, error: j.error, code: j.code, lines: [] }; }
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, lines, built: lines.filter((l) => l.type === 'built').map((l) => l.row), replaced: lines.filter((l) => l.type === 'replaced').flatMap((l) => l.spotify_ids) };
}

async function rubinToken() {
  const basic = Buffer.from(`${process.env.RUBIN_SPOTIFY_CLIENT_ID}:${process.env.RUBIN_SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.RUBIN_REFRESH_TOKEN }),
  });
  if (!r.ok) throw new Error(`Rubin token refresh failed: ${r.status}`);
  return (await r.json()).access_token;
}

// Hours: today open from ~1h ago to ~6h from now; tomorrow 10:00–18:00 (a
// second hours group); the rest closed.
const il = ilPartsFromDate(new Date());
const nowMins = il.hour * 60 + il.minute;
const openM = Math.max(0, nowMins - 60), closeM = Math.min(1439, Math.max(nowMins + 360, openM + 120));
const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { closed: true, open: '10:00', close: '22:00' }]));
hours[il.dayIdx] = { closed: false, open: fmtHM(openM), close: fmtHM(closeM) };
hours[(il.dayIdx + 1) % 7] = { closed: false, open: '10:00', close: '18:00' };

const stamp = Date.now();
const email = `test-v7o2-${stamp}@example.invalid`;
const tasteProfile = {
  energy_levels_total: 3,
  approved_genres: [
    { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Jazz (Standards)', energy_level: 1 },
    { genre: 'Neo Soul', energy_level: 2 }, { genre: 'Acid Jazz', energy_level: 2 },
    { genre: 'Funk', energy_level: 3 }, { genre: 'Disco', energy_level: 3 },
  ],
  conditional_genres: [], excluded_genres: [],
  instrumentalness_preference: 'none', popularity_preference: 'none', reasoning_en: 'fixture (option2 walkthrough)',
};

let businessId = null, userId = null;
try {
  console.log(`\n=== v7 Option 2 walkthrough (dev ${DEV_BASE}) — today ${fmtHM(openM)}–${fmtHM(closeM)} IL ===`);
  const su = await (await api('/api/v7/account/signup', { internal: true, body: {
    email, name: 'Option2 walkthrough', description: 'fixture', musicalEmphases: '', atmospheres: [], place: null,
    hours, longestMinutes: closeM - openM, superLikedTracks: [], onboardingSessionId: `o2walk-${stamp}`, tasteProfile, genreTally: [], skipEmail: true,
  } })).json();
  if (!su.business_id) throw new Error(`signup failed: ${JSON.stringify(su).slice(0, 200)}`);
  businessId = su.business_id;
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: HDR, body: JSON.stringify({ type: 'magiclink', email }) }).then((r) => r.json());
  const ses = await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gen?.hashed_token || gen?.properties?.hashed_token }) }).then((r) => r.json());
  if (!ses.access_token) throw new Error('session mint failed');
  userId = ses.user.id;
  const token = ses.access_token;
  console.log(`  business ${businessId}`);

  // 1. Option 2 + a 2-group timeline (today: calm → peak → calm)
  console.log('\n[1] set-delivery-mode option2 + timeline');
  const tl = reconcileTimeline(null, hours);
  const todayGroup = tl.groups.find((g) => g.days.includes(il.dayIdx));
  const mid = Math.round((openM + closeM) / 2 / 30) * 30;
  todayGroup.points = [{ m: openM, e: .1 }, { m: mid, e: .95 }, { m: closeM, e: .15 }];
  const sm = await (await api('/api/v7/account/set-delivery-mode', { token, body: { business_id: businessId, delivery_mode: 'option2', timeline: tl } })).json();
  ok(sm.ok && sm.timeline?.groups?.length === 2, `stored with 2 groups (${sm.timeline?.groups?.length})`, JSON.stringify(sm).slice(0, 200));
  ok(sm.replace && sm.replace.eligible === false, `no live playlists → no replace question (${sm.replace?.reason})`);

  // 2. hours change → timeline follows (tomorrow 10–18 → 11–18: 10:00 edge moves to 11:00)
  console.log('\n[2] v7 update-hours reconciles the timeline');
  const tomorrow = (il.dayIdx + 1) % 7;
  const hours2 = { ...hours, [tomorrow]: { closed: false, open: '11:00', close: '18:00' } };
  const uh = await (await api('/api/v7/account/update-hours', { token, body: { businessId, hours: hours2, longestMinutes: closeM - openM } })).json();
  const tg = uh.timeline?.groups?.find((g) => g.days.includes(tomorrow));
  ok(uh.ok && tg?.open === '11:00' && tg.points[0].m === 660 && tg.points.some((p) => p.m === 840), `tomorrow's group: edge → 11:00, 14:00 dot kept (${tg?.points?.map((p) => fmtHM(p.m)).join(' ')})`);

  // 3. today's build
  console.log('\n[3] generate-daily (Option 2 timeline builder)');
  const b1 = await build(token, businessId);
  ok(b1.status === 200 && b1.built?.length === 2, `built 2 mixes (status ${b1.status}, ${b1.error || ''})`);
  const rows1 = b1.built || [];
  ok(rows1.every((r) => r.expansion?.v7_timeline), 'rows carry the timeline metadata (not the naive fallback)', rows1[0] ? JSON.stringify(Object.keys(rows1[0].expansion || {})) : '');
  const ids1 = rows1.flatMap((r) => r.track_ids);
  ok(new Set(ids1).size === ids1.length, `the two mixes share no track (${ids1.length} tracks)`);
  const w = businessWindowAt(hours2, new Date());
  for (const r of rows1) {
    const meta = r.expansion?.v7_timeline;
    if (!meta) continue;
    const durs = await pgr('GET', 'track_analyses', { query: { spotify_id: `in.(${r.track_ids.join(',')})`, select: 'spotify_id,duration_sec' } });
    const secOf = new Map(durs.map((d) => [d.spotify_id, d.duration_sec || 250]));
    const total = r.track_ids.reduce((n, id) => n + (secOf.get(id) || 250), 0);
    const need = (meta.window[1] - meta.window[0]) * 60;
    ok(total >= need - 60 && total - (secOf.get(r.track_ids.at(-1)) || 250) < need,
      `${r.label}: ${r.track_ids.length} tracks, ${(total / 60).toFixed(0)} min fill ${fmtHM(meta.window[0])}–${fmtHM(meta.window[1])}`);
    ok(meta.levels?.length === r.track_ids.length && meta.window[0] >= Math.min(w.nowMin, w.openMin) - 1, `${r.label}: per-track levels + start at max(now, opening)`);
    ok(Object.keys(r.track_genres || {}).length === r.track_ids.length, `${r.label}: per-track genres recorded`);
  }
  const ledger1 = await pgr('GET', 'created_playlists', { query: { spotify_id: `in.(${rows1.map((r) => r.spotify_id).join(',')})`, select: 'spotify_id,expires_at' } });
  ok(ledger1.length === 2 && ledger1.every((l) => Math.abs(Date.parse(l.expires_at) - Date.parse(w.expiryIso)) < 60e3), `ledger rows expire close + 2h (${w.expiryIso})`);

  // 4. timeline edit → replace question applies
  console.log('\n[4] update-timeline → replace status');
  todayGroup.points = [{ m: openM, e: .9 }, { m: mid, e: .2 }, { m: closeM, e: .9 }];
  const ut = await (await api('/api/v7/account/update-timeline', { token, body: { business_id: businessId, timeline: tl } })).json();
  ok(ut.ok && ut.replace?.eligible === true && ut.replace.left === 2, `eligible, 2 replacements left (${JSON.stringify(ut.replace)})`);

  // 5. replace now
  console.log('\n[5] generate-daily replaceToday');
  const b2 = await build(token, businessId, { replaceToday: true });
  ok(b2.status === 200 && b2.built?.length === 2, `replacement built 2 (status ${b2.status}, ${b2.error || ''})`);
  ok(rows1.every((r) => b2.replaced?.includes(r.spotify_id)), `old playlists reported replaced (${b2.replaced?.length})`);
  const old = await pgr('GET', 'business_playlists', { query: { spotify_id: `in.(${rows1.map((r) => r.spotify_id).join(',')})`, select: 'spotify_id,expires_at' } });
  ok(old.every((o) => Date.parse(o.expires_at) <= Date.now()), 'old rows hidden from the dashboard');
  const oldLedger = await pgr('GET', 'created_playlists', { query: { spotify_id: `in.(${rows1.map((r) => r.spotify_id).join(',')})`, select: 'expires_at,deleted_at' } });
  ok(oldLedger.every((l) => Date.parse(l.expires_at) > Date.now() && !l.deleted_at), 'old ledger rows keep their close + 2h expiry (not cut off mid-song)');

  // 6. two replacements at once → build lock
  console.log('\n[6] concurrent replaceToday → build lock');
  const [c1, c2] = await Promise.all([build(token, businessId, { replaceToday: true }), build(token, businessId, { replaceToday: true })]);
  const codes = [c1, c2].map((c) => `${c.status}${c.code ? ':' + c.code : ''}`);
  ok([c1, c2].some((c) => c.status === 409 && c.code === 'build-in-progress') && [c1, c2].some((c) => c.status === 200), `one ran, one refused (${codes.join(', ')})`);

  // 7. cap
  console.log('\n[7] third replacement → cap');
  const b4 = await build(token, businessId, { replaceToday: true });
  ok(b4.status === 429 && b4.code === 'replace-cap', `refused at the cap (${b4.status} ${b4.code}: ${b4.error})`);
} catch (e) {
  console.error(`\nWALKTHROUGH ABORTED: ${e.message}`);
  failed++;
} finally {
  console.log('\n=== TEARDOWN ===');
  try {
    if (businessId) {
      const pls = await pgr('GET', 'created_playlists', { query: { business_id: `eq.${businessId}`, select: 'spotify_id' } });
      if (pls.length && RUBIN_OK) {
        const t = await rubinToken();
        for (const { spotify_id } of pls) {
          const r = await fetch(`https://api.spotify.com/v1/playlists/${spotify_id}/followers`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } });
          await pgr('PATCH', 'created_playlists', { query: { spotify_id: `eq.${spotify_id}` }, body: { deleted_at: new Date().toISOString(), error: null }, prefer: 'return=minimal' }).catch(() => {});
          console.log(`  unfollow ${spotify_id} → ${r.status}`);
        }
      } else if (pls.length) {
        console.warn(`  ${pls.length} playlists left on Rubin's account — run scripts/purge-rubin-playlists.mjs --confirm`);
      }
      await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } });
      console.log(`  business ${businessId} deleted (CASCADE)`);
    }
    if (userId) { await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: HDR }); console.log(`  user ${userId} deleted`); }
  } catch (e) { console.warn(`  cleanup issue: ${e.message}`); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
