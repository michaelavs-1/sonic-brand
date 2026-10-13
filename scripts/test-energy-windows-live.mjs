#!/usr/bin/env node
/**
 * Check for the 2026-10-13 energy windows
 * (v5/precompute/migrations/2026-10-13-v7-energy-windows.sql).
 *
 * The daily playlists take songs inside an energy range first and widen it by
 * 5 on each side only as far as the pool needs. Calls both daily-playlist
 * track functions and checks the energy of what comes back:
 *   - v6_direction_tracks_recent (Option 1): with a range, songs come in ring
 *     order (inside the range first, then at most 5 outside, then 10...); a
 *     range that is short of songs widens; without the new parameters the old
 *     call still works;
 *   - v7_timeline_pool (Option 2): every row carries the right `ring` for its
 *     energy, rings in order per genre; a spec without a range is all ring 0.
 *
 * Read-only: only RPC calls and track_analyses reads against prod Supabase.
 * Run: node scripts/test-energy-windows-live.mjs   (reads .env.local itself)
 */

import fs from 'node:fs';

const envText = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HDR = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const NO_BIZ = '00000000-0000-0000-0000-000000000000';

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}

async function rpc(fn, args) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: HDR, body: JSON.stringify(args) });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(`${fn} → ${r.status}: ${txt}`); e.status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

async function energyOf(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const inList = ids.slice(i, i + 200).map((x) => `"${x}"`).join(',');
    const r = await fetch(`${SB}/rest/v1/track_analyses?spotify_id=in.(${inList})&select=spotify_id,energy`, { headers: HDR });
    for (const row of await r.json()) out.set(row.spotify_id, row.energy);
  }
  return ids.map((id) => out.get(id) ?? null);
}

// Same rule as the SQL: 5-point steps outside [lo, hi]; no energy = last.
const ringOf = (e, lo, hi) => (e == null ? 999 : Math.ceil(Math.max(lo - e, e - hi, 0) / 5));
const ascending = (xs) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);
const tally = (rings) => [...rings.reduce((m, r) => m.set(r, (m.get(r) || 0) + 1), new Map())]
  .sort((a, b) => a[0] - b[0]).map(([r, n]) => `ring ${r}: ${n}`).join(', ');

const recent = (genres, limit, range) => rpc('v6_direction_tracks_recent', {
  p_genres: genres, p_bpm_lo: 0, p_bpm_hi: 300, p_pop_lo: 0, p_pop_hi: 100, p_limit: limit,
  p_biz_id: NO_BIZ, p_direction_key: 'energy-windows-check', p_exclude_days: 0,
  p_inst_pref: 'none', p_pop_pref: 'none',
  ...(range ? { p_energy_lo: range[0], p_energy_hi: range[1] } : {}),
});

// The new parameters double as the "was the migration run?" check.
let migrated = true;
try {
  await recent(['Bossa Nova'], 1, [20, 50]);
} catch (e) {
  if (e.status !== 404) throw e;
  console.error('v6_direction_tracks_recent takes no energy range — run v5/precompute/migrations/2026-10-13-v7-energy-windows.sql first.');
  migrated = false;
}
// process.exitCode, not process.exit(): exiting with fetch's sockets still
// open crashes Node on Windows (UV_HANDLE_CLOSING assertion).
if (!migrated) process.exitCode = 1;
else await runChecks();

async function runChecks() {
  const ids = (rows) => (rows || []).map((r) => r.spotify_id);

  console.log('\nv6_direction_tracks_recent (Option 1)');
  for (const [label, genres, range, limit] of [
    ['calm 20–50, Bossa Nova + Jazz (Standards)', ['Bossa Nova', 'Jazz (Standards)'], [20, 50], 130],
    ['high 50–80, Disco + Funk', ['Disco', 'Funk'], [50, 80], 130],
    ['narrow 60–62, Bossa Nova (has to widen)', ['Bossa Nova'], [60, 62], 300],
  ]) {
    const energies = await energyOf(ids(await recent(genres, limit, range)));
    const rings = energies.map((e) => ringOf(e, range[0], range[1]));
    ok(energies.length > 0, `${label}: ${energies.length} songs (${tally(rings)})`, 'none returned');
    ok(ascending(rings), `${label}: inside the range first, then widening step by step`);
    if (label.startsWith('narrow')) ok(rings.some((r) => r > 0), `${label}: widened past the range`);
  }
  const plain = await rpc('v6_direction_tracks_recent', {
    p_genres: ['Bossa Nova'], p_bpm_lo: 0, p_bpm_hi: 300, p_pop_lo: 0, p_pop_hi: 100, p_limit: 20,
    p_biz_id: NO_BIZ, p_direction_key: 'energy-windows-check', p_exclude_days: 0,
  });
  ok((plain || []).length === 20, 'the old call without a range still works');

  console.log('\nv7_timeline_pool (Option 2)');
  const specs = [
    { genre: 'Bossa Nova', n: 120, playlists: 40, lo: 20, hi: 50 },
    { genre: 'Disco',      n: 120, playlists: 40, lo: 50, hi: 80 },
    { genre: 'Neo Soul',   n: 120, playlists: 40, lo: 40, hi: 70 },
  ];
  const rows = await rpc('v7_timeline_pool', {
    p_biz_id: NO_BIZ, p_specs: [...specs, { genre: 'Funk', n: 30, playlists: 10 }],
    p_inst_pref: 'none', p_pop_pref: 'none', p_exclude_days: 0,
  }) || [];
  ok(rows.length > 0 && 'ring' in rows[0] && 'energy' in rows[0], 'rows carry energy and ring');
  for (const s of specs) {
    const mine = rows.filter((r) => r.genre === s.genre.toLowerCase());
    const right = mine.every((r) => r.ring === ringOf(r.energy, s.lo, s.hi));
    ok(mine.length > 0 && right, `${s.genre} ${s.lo}–${s.hi}: ${mine.length} songs, ring matches energy (${tally(mine.map((r) => r.ring))})`);
    ok(ascending(mine.map((r) => r.ring)), `${s.genre}: rows in ring order`);
  }
  const noRange = rows.filter((r) => r.genre === 'funk');
  ok(noRange.length > 0 && noRange.every((r) => r.ring === 0), `a spec without a range is all ring 0 (${noRange.length} songs)`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
