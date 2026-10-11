#!/usr/bin/env node
/**
 * Check for the 2026-10-11 Israeli hit floor
 * (v5/precompute/migrations/2026-10-11-israeli-hit-floor.sql).
 *
 * An owner who asks for hits gets popularity 60-100 in most genres, but 45-100
 * in the Israeli ones. Calls every track function v7 uses with an Israeli
 * genre and with Rock, and checks the popularity of what comes back:
 *   - hit_popularity_floor: 45 for רוק ישראלי, 60 for Rock;
 *   - pop_pref 'hard': nothing under the genre's floor, and the Israeli genre
 *     does return tracks scored 45-59 (proof the floor moved);
 *   - pop_pref 'soft': hits (at or above the floor) come first, then the rest.
 *
 * Read-only: only RPC calls and track_analyses reads against prod Supabase.
 * Run: node scripts/test-israeli-hit-floor.mjs   (reads .env.local itself)
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

const ISR  = 'רוק ישראלי';
const ROCK = 'Rock';
const NO_BIZ = '00000000-0000-0000-0000-000000000000';

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}

async function rpc(fn, args) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: HDR, body: JSON.stringify(args) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${fn} → ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

async function popularityOf(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const inList = ids.slice(i, i + 200).map((x) => `"${x}"`).join(',');
    const r = await fetch(`${SB}/rest/v1/track_analyses?spotify_id=in.(${inList})&select=spotify_id,popularity`, { headers: HDR });
    for (const row of await r.json()) out.set(row.spotify_id, row.popularity);
  }
  return ids.map((id) => out.get(id) ?? 0);
}

// hard: every score >= floor; for the Israeli genre also some in 45-59.
function checkHard(label, pops, floor, expectBelow60) {
  const under = pops.filter((p) => p < floor).length;
  ok(pops.length > 0, `${label}: returned tracks`, 'none returned');
  ok(under === 0, `${label}: none under ${floor}`, `${under} of ${pops.length} under ${floor}`);
  if (expectBelow60) {
    const mid = pops.filter((p) => p >= 45 && p < 60).length;
    ok(mid > 0, `${label}: includes tracks scored 45-59 (${mid} of ${pops.length})`, 'none — the floor is still 60');
  }
}

// soft: once a non-hit appears, no hit may follow.
function checkSoft(label, pops, floor) {
  const firstMiss = pops.findIndex((p) => p < floor);
  const hitAfter = firstMiss < 0 ? 0 : pops.slice(firstMiss).filter((p) => p >= floor).length;
  ok(pops.length > 0 && hitAfter === 0,
    `${label}: hits (${floor}+) first, then the rest (${firstMiss < 0 ? pops.length : firstMiss} hits)`,
    `${hitAfter} hits after the first non-hit`);
}

// The floor function doubles as the "was the migration run?" check.
let migrated = true;
try {
  const fIsr  = await rpc('hit_popularity_floor', { p_genre: ISR });
  const fRock = await rpc('hit_popularity_floor', { p_genre: ROCK });
  ok(fIsr === 45 && fRock === 60, `hit_popularity_floor: ${ISR}=${fIsr}, ${ROCK}=${fRock}`, 'expected 45 / 60');
} catch (e) {
  console.error(`hit_popularity_floor is missing — run v5/precompute/migrations/2026-10-11-israeli-hit-floor.sql first.\n${e.message}`);
  migrated = false;
}
// process.exitCode, not process.exit(): exiting with fetch's sockets still
// open crashes Node on Windows (UV_HANDLE_CLOSING assertion).
if (!migrated) process.exitCode = 1;
else await runChecks();

async function runChecks() {

  const recent = (genres, pop, limit) => rpc('v6_direction_tracks_recent', {
    p_genres: genres, p_bpm_lo: 0, p_bpm_hi: 300, p_pop_lo: 0, p_pop_hi: 100, p_limit: limit,
    p_biz_id: NO_BIZ, p_direction_key: 'israeli-hit-floor-check', p_exclude_days: 0,
    p_inst_pref: 'none', p_pop_pref: pop,
  });
  const direction = (genres, pop, limit) => rpc('v5_direction_tracks', {
    p_genres: genres, p_bpm_lo: 0, p_bpm_hi: 300, p_pop_lo: 0, p_pop_hi: 100, p_limit: limit,
    p_inst_pref: 'none', p_pop_pref: pop,
  });
  const pool = (genre, pop) => rpc('v7_timeline_pool', {
    p_biz_id: NO_BIZ, p_specs: [{ genre, n: 600, playlists: 200 }],
    p_inst_pref: 'none', p_pop_pref: pop, p_exclude_days: 0,
  });
  const energy = (genres, pop, limit) => rpc('v7_energy_tracks', {
    p_genres: genres, p_energy_lo: 0, p_energy_hi: 100, p_inst_pref: 'none', p_pop_pref: pop, p_limit: limit,
  });
  const ids = (rows) => (rows || []).map((r) => r.spotify_id);

  console.log('\nv6_direction_tracks_recent (Option 1)');
  checkHard(`hard ${ISR}`,  await popularityOf(ids(await recent([ISR], 'hard', 1000))), 45, true);
  checkHard(`hard ${ROCK}`, await popularityOf(ids(await recent([ROCK], 'hard', 300))), 60, false);
  checkSoft(`soft ${ISR}`,  await popularityOf(ids(await recent([ISR], 'soft', 1000))), 45);
  checkSoft(`soft ${ROCK}`, await popularityOf(ids(await recent([ROCK], 'soft', 500))), 60);

  console.log('\nv5_direction_tracks (special playlists)');
  checkHard(`hard ${ISR}`,  await popularityOf(ids(await direction([ISR], 'hard', 1000))), 45, true);
  checkHard(`hard ${ROCK}`, await popularityOf(ids(await direction([ROCK], 'hard', 300))), 60, false);
  checkSoft(`soft ${ISR}`,  await popularityOf(ids(await direction([ISR], 'soft', 1000))), 45);

  console.log('\nv7_timeline_pool (Option 2)');
  checkHard(`hard ${ISR}`,  await popularityOf(ids(await pool(ISR, 'hard'))), 45, true);
  checkHard(`hard ${ROCK}`, await popularityOf(ids(await pool(ROCK, 'hard'))), 60, false);
  checkSoft(`soft ${ISR}`,  await popularityOf(ids(await pool(ISR, 'soft'))), 45);

  console.log('\nv7_energy_tracks (Ami\'s test playlists)');
  checkHard(`hard ${ISR}`,  await popularityOf(ids(await energy([ISR], 'hard', 1000))), 45, true);
  checkHard(`hard ${ROCK}`, await popularityOf(ids(await energy([ROCK], 'hard', 300))), 60, false);

  console.log('\nv7_anchor_tracks (swipe deck) — 15 calls of 4 cards');
  const anchorPops = { isr: [], rock: [] };
  for (let i = 0; i < 15; i++) {
    const rows = await rpc('v7_anchor_tracks', { p_specs: [
      { rank: 1, genre: ISR,  pop_pref: 'hard' }, { rank: 2, genre: ISR,  pop_pref: 'hard' },
      { rank: 3, genre: ROCK, pop_pref: 'hard' }, { rank: 4, genre: ROCK, pop_pref: 'hard' },
    ] });
    const pops = await popularityOf(ids(rows));
    rows.forEach((r, j) => (r.rank <= 2 ? anchorPops.isr : anchorPops.rock).push(pops[j]));
  }
  checkHard(`hard ${ISR}`,  anchorPops.isr, 45, true);
  checkHard(`hard ${ROCK}`, anchorPops.rock, 60, false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
