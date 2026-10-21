#!/usr/bin/env node
/**
 * v7 "today only" energy for one Option 1 playlist (the circles under each
 * daily playlist; api/v7/account/energy-nudge.js, 2026-10-21) — LIVE walkthrough.
 *
 * Runs against `vercel dev` (default :3000) → prod Supabase + REAL Spotify.
 * Builds today's 4 playlists on Rubin's account for a throwaway Option 1
 * business and unfollows them in teardown (CASCADE delete + user delete).
 * Fixture taste profile + recipes → no Gemini calls. Avoid :00 / :30 (crons).
 *
 * What it checks:
 *   1. today's build: energetic playlists 50–80, calm ones 30–60 (the new default).
 *   2. refusals: the usual circle ("same"), a playlist that isn't today's.
 *   3. the change: "אנרגיה גבוהה #1" one step up (60–90) —
 *      same Spotify playlist, same length; the songs kept are the old ones in
 *      60–90; the new ones are new (none from the old list); the row records
 *      the window + the usual one; per-track genres; Spotify holds exactly the
 *      new list, in order; the change is logged.
 *   4. a second change the same day → 409 nudge-used.
 *
 * Usage (PowerShell, from the repo root):
 *   Get-Content .env.local | ForEach-Object { if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') { Set-Item "env:$($matches[1])" $matches[2] } }
 *   node scripts/_v7-energy-nudge-walkthrough.mjs
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *      INTERNAL_API_KEY (must match vercel dev's), RUBIN_SPOTIFY_CLIENT_ID /
 *      _SECRET / RUBIN_REFRESH_TOKEN (Spotify check + teardown unfollow).
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

const { fmtHM } = await import(pathToFileURL(join(repoRoot, 'v7/generation/energy-timeline.js')).href);
const { ilPartsFromDate, undatedLabel } = await import(pathToFileURL(join(repoRoot, 'v7/generation/playlist-length.js')).href);

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
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });

async function rubinToken() {
  const basic = Buffer.from(`${process.env.RUBIN_SPOTIFY_CLIENT_ID}:${process.env.RUBIN_SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.RUBIN_REFRESH_TOKEN }),
  });
  if (!r.ok) throw new Error(`Rubin token refresh failed: ${r.status}`);
  return (await r.json()).access_token;
}
async function spotifyItems(token, playlistId) {
  const ids = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?fields=items(item(id)),next&limit=100`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(`items ${r.status}: ${JSON.stringify(d).slice(0, 120)}`);
    ids.push(...(d.items || []).map((x) => x.item?.id).filter(Boolean));   // the playlist items API names it "item"
    url = d.next;
  }
  return ids;
}
async function energies(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await pgr('GET', 'track_analyses', { query: { spotify_id: `in.(${ids.slice(i, i + 100).join(',')})`, select: 'spotify_id,energy' } });
    for (const r of rows) out.set(r.spotify_id, r.energy);
  }
  return out;
}

// Today open from ~1h ago to ~6h from now.
const il = ilPartsFromDate(new Date());
const nowMins = il.hour * 60 + il.minute;
const openM = Math.max(0, nowMins - 60), closeM = Math.min(1439, Math.max(nowMins + 360, openM + 120));
const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { closed: true, open: '10:00', close: '22:00' }]));
hours[il.dayIdx] = { closed: false, open: fmtHM(openM), close: fmtHM(closeM) };

const stamp = Date.now();
const email = `test-v7nudge-${stamp}@example.invalid`;
const tasteProfile = {
  energy_levels_total: 4,
  approved_genres: [
    { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Jazz (Standards)', energy_level: 1 },
    { genre: 'Neo Soul', energy_level: 2 }, { genre: 'Acid Jazz', energy_level: 2 },
    { genre: 'Afro Funk', energy_level: 3 }, { genre: 'Funk', energy_level: 4 }, { genre: 'Disco', energy_level: 4 },
  ],
  conditional_genres: [], excluded_genres: [],
  instrumentalness_preference: 'none', popularity_preference: 'none', reasoning_en: 'fixture (energy-nudge walkthrough)',
};
const recipes = [
  { energy_tier: 'high', title_en: 'Funk & Disco', genres: ['Funk', 'Disco'] },
  { energy_tier: 'high', title_en: 'Afro Funk', genres: ['Afro Funk', 'Funk'] },
  { energy_tier: 'low', title_en: 'Bossa & Standards', genres: ['Bossa Nova', 'Jazz (Standards)'] },
  { energy_tier: 'low', title_en: 'Neo Soul & Acid Jazz', genres: ['Neo Soul', 'Acid Jazz'] },
];

let businessId = null, userId = null;
try {
  console.log(`\n=== v7 energy-nudge walkthrough (dev ${DEV_BASE}) — today ${fmtHM(openM)}–${fmtHM(closeM)} IL ===`);
  const su = await (await api('/api/v7/account/signup', { internal: true, body: {
    email, name: 'Energy nudge walkthrough', description: 'fixture', musicalEmphases: '', atmospheres: [], place: null,
    hours, longestMinutes: closeM - openM, superLikedTracks: [], onboardingSessionId: `nudgewalk-${stamp}`, tasteProfile, genreTally: [], skipEmail: true,
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

  const sm = await json(await api('/api/v7/account/set-delivery-mode', { token, body: { business_id: businessId, delivery_mode: 'option1' } }));
  if (sm.delivery_mode !== 'option1') throw new Error(`set-delivery-mode failed: ${JSON.stringify(sm).slice(0, 200)}`);
  const ed = await json(await api('/api/v7/account/save-energy-directions', { token, body: { business_id: businessId, directions: recipes } }));
  if (!ed.ok) throw new Error(`save-energy-directions failed: ${JSON.stringify(ed).slice(0, 200)}`);

  // 1. today's build
  console.log('\n[1] generate-daily (Option 1)');
  const r = await api('/api/v7/account/generate-daily', { token, body: { businessId, bizName: 'Energy nudge walkthrough' } });
  const lines = (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const built = lines.filter((l) => l.type === 'built').map((l) => l.row);
  ok(r.status === 200 && built.length === 4, `built 4 playlists (status ${r.status}, ${built.length})`);
  const byName = new Map(built.map((b) => [undatedLabel(b.label), b]));
  const win = (b) => [b?.expansion?.direction?.energy_range?.min, b?.expansion?.direction?.energy_range?.max].join('–');
  ok(win(byName.get('אנרגיה גבוהה #1')) === '50–80' && win(byName.get('אנרגיה גבוהה #2')) === '50–80', `energetic playlists 50–80 (${win(byName.get('אנרגיה גבוהה #1'))})`);
  ok(win(byName.get('אנרגיה רגועה #1')) === '30–60' && win(byName.get('אנרגיה רגועה #2')) === '30–60', `calm playlists 30–60, the new default (${win(byName.get('אנרגיה רגועה #1'))})`);
  const target = byName.get('אנרגיה גבוהה #1');
  if (!target) throw new Error('no "אנרגיה גבוהה #1" to change');

  // 2. refusals
  console.log('\n[2] refusals');
  const same = await json(await api('/api/v7/account/energy-nudge', { token, body: { businessId, spotifyId: target.spotify_id, choice: 1 } }));
  ok(same.status === 409 && same.code === 'same', `the usual circle → 409 same (${same.status} ${same.code})`);
  const other = await json(await api('/api/v7/account/energy-nudge', { token, body: { businessId, spotifyId: '0000000000000000000000', choice: 2 } }));
  ok(other.status === 409 && other.code === 'not-adjustable', `not one of today's playlists → 409 not-adjustable (${other.status} ${other.code})`);

  // 3. the change: one step up
  console.log('\n[3] "אנרגיה גבוהה #1" one step up');
  const before = target.track_ids;
  const eBefore = await energies(before);
  const fits = (e) => e != null && e >= 60 && e <= 90;
  const expectKept = before.filter((id) => !eBefore.has(id) || fits(eBefore.get(id)));
  const t0 = Date.now();
  const n = await json(await api('/api/v7/account/energy-nudge', { token, body: { businessId, spotifyId: target.spotify_id, choice: 2 } }));
  ok(n.status === 200 && n.ok, `changed (${n.status}, ${((Date.now() - t0) / 1000).toFixed(1)}s, kept ${n.kept}, added ${n.added}, removed ${n.removed})`, n.error);
  const after = n.playlist?.track_ids || [];
  ok(n.playlist?.spotify_id === target.spotify_id, 'the same Spotify playlist');
  ok(after.length === before.length, `same length (${before.length} → ${after.length})`);
  const keptNow = after.filter((id) => before.includes(id));
  ok(keptNow.length === expectKept.length && expectKept.every((id) => keptNow.includes(id)), `kept exactly the old songs in 60–90 (${keptNow.length} of ${before.length})`);
  ok(keptNow.join() === expectKept.join(), 'kept songs stay in their order');
  const added = after.filter((id) => !before.includes(id));
  const eAdded = await energies(added);
  const inWin = added.filter((id) => fits(eAdded.get(id))).length;
  ok(added.length === before.length - expectKept.length, `the rest are new songs (${added.length})`);
  console.log(`        new songs inside 60–90: ${inWin} of ${added.length} (the rest from the window widened by 5s, when short)`);
  ok(inWin >= Math.ceil(added.length * 0.6), 'most new songs inside the new window');
  const row = (await pgr('GET', 'business_playlists', { query: { spotify_id: `eq.${target.spotify_id}`, select: 'track_ids,track_count,track_genres,expansion,label' } }))[0];
  const d = row?.expansion?.direction;
  ok(d?.energy_range?.min === 60 && d?.energy_range?.max === 90 && d?.energy_nudge?.usual?.min === 50 && d?.energy_nudge?.usual?.max === 80,
    `row: window 60–90, usual 50–80 (${win(row)}; usual ${d?.energy_nudge?.usual?.min}–${d?.energy_nudge?.usual?.max})`);
  ok(row?.track_count === after.length && row?.track_ids?.join() === after.join(), 'row: track list + count updated');
  ok(Object.keys(row?.track_genres || {}).length === after.length, 'row: per-track genres for the new list');
  if (RUBIN_OK) {
    const items = await spotifyItems(await rubinToken(), target.spotify_id);
    ok(items.join() === after.join(), `Spotify holds exactly the new list, in order (${items.length})`);
  }
  const audit = await pgr('GET', 'business_settings_changes', { query: { business_id: `eq.${businessId}`, field: 'eq.daily_energy_nudge', select: 'before,after' } });
  ok(audit.length === 1 && audit[0].after?.window?.join() === '60,90', `logged as today's change (${audit.length})`);

  // 4. one change a day
  console.log('\n[4] a second change the same day');
  const calm = byName.get('אנרגיה רגועה #1');
  const again = await json(await api('/api/v7/account/energy-nudge', { token, body: { businessId, spotifyId: calm.spotify_id, choice: 0 } }));
  ok(again.status === 409 && again.code === 'nudge-used', `→ 409 nudge-used (${again.status} ${again.code}: ${again.error})`);
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
