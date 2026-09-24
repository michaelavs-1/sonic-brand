#!/usr/bin/env node
/**
 * v7 Option 2 — READ-ONLY dry run of the energy-timeline builder.
 *
 * Plans today's two "Daily Mix" playlists exactly like the cron / dashboard
 * would (window, curve, pool RPC, duration-based assembly) and PRINTS the
 * schedule — clock time, energy level, genre, duration for every track —
 * without creating anything: no Spotify calls, no inserts. The only DB
 * access is SELECTs + the v7_timeline_pool RPC.
 *
 * Needs migration v5/precompute/migrations/2026-09-24-v7-timeline-pool.sql
 * (otherwise it reports the naive fallback).
 *
 * Usage (from the repo root; reads .env.local if the vars aren't set):
 *   node scripts/_v7-option2-dryrun.mjs                    fixture profile, 09:00–23:00, planned as of 08:00
 *   node scripts/_v7-option2-dryrun.mjs --at=15:30         fixture, planned as of 15:30 (starts at 15:30)
 *   node scripts/_v7-option2-dryrun.mjs <businessId>       a real business (its hours, timeline, profile), as of now
 *   node scripts/_v7-option2-dryrun.mjs <businessId> --at=09:00
 *   add --quiet to print only the summary.
 */

import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    for (const line of fs.readFileSync(join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* fall through to the check below */ }
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (set them or keep them in .env.local).');
  process.exit(1);
}

const args = process.argv.slice(2);
const at = args.find((a) => a.startsWith('--at='))?.slice(5) || null;
const quiet = args.includes('--quiet');
const businessId = args.find((a) => /^[0-9a-f-]{36}$/i.test(a)) || null;

const imp = (p) => import(pathToFileURL(join(repoRoot, p)).href);
const { planOption2Timeline, planFromInputs } = await imp('api/v7/account/_option2-builder.js');
const { pgrSelect } = await imp('api/v5/supabase-client.js');
const { ilPartsFromDate } = await imp('v7/generation/playlist-length.js');
const { ilIsoAt, fmtHM, parseHM } = await imp('v7/generation/energy-timeline.js');

// "now" as an IL wall-clock time today (so a plan can be previewed at any hour).
function nowAt(hhmm) {
  const il = ilPartsFromDate(new Date());
  return new Date(ilIsoAt({ year: il.year, month: il.month, day: il.day }, parseHM(hhmm)));
}

const FIXTURE_PROFILE = {
  N: 4,
  approved: [
    { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Jazz (Standards)', energy_level: 1 },
    { genre: 'Neo Soul', energy_level: 2 }, { genre: 'Acid Jazz', energy_level: 2 },
    { genre: 'Funk', energy_level: 3 }, { genre: 'Disco', energy_level: 3 },
    { genre: 'Nu Disco', energy_level: 4 }, { genre: 'Deep House', energy_level: 4 },
  ],
};

const t0 = Date.now();
let plan, label, now;
if (businessId) {
  now = at ? nowAt(at) : new Date();
  const [h] = await pgrSelect('business_hours', { business_id: `eq.${businessId}` }, { select: 'hours', limit: 1, useService: true });
  if (!h?.hours) { console.error('That business has no hours row.'); process.exit(1); }
  plan = await planOption2Timeline({ businessId, hours: h.hours, now, onDemand: true });
  label = `business ${businessId}`;
} else {
  now = nowAt(at || '08:00');
  const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { closed: false, open: '09:00', close: '23:00' }]));
  plan = await planFromInputs({
    businessId: '00000000-0000-0000-0000-000000000000', hours, timeline: null,
    approved: FIXTURE_PROFILE.approved, N: FIXTURE_PROFILE.N, now, onDemand: true,
  });
  label = 'fixture profile (8 genres, 4 levels), 09:00–23:00, default timeline';
}
const ms = Date.now() - t0;

const ilNow = ilPartsFromDate(now);
console.log(`\n=== v7 Option 2 dry run — ${label} — as of ${fmtHM(ilNow.hour * 60 + ilNow.minute)} IL ===`);
if (plan.fallback) { console.log('\nThe v7_timeline_pool RPC is missing → the builder would use the NAIVE fallback. Run migration 2026-09-24-v7-timeline-pool.sql.'); process.exit(2); }
if (!plan.slots.length) { console.log(`\nNothing to build: ${plan.reason}`); process.exit(0); }

const m = plan.meta;
console.log(`window ${fmtHM(m.window[0])}–${fmtHM(m.window[1])} (${m.kind}) · group ${m.open}–${m.close} · levels ${m.levels_total} · expires ${plan.expiryIso} · planned in ${ms} ms`);
console.log(`curve dots: ${m.points.map((p) => `${fmtHM(p.m)}=${p.e}`).join('  ')}`);
console.log(`stats: ${JSON.stringify(plan.stats)}`);
const dur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
for (const slot of plan.slots) {
  const total = slot.tracks.reduce((n, t) => n + t.sec, 0);
  const genres = new Map();
  for (const t of slot.tracks) genres.set(t.genre, (genres.get(t.genre) || 0) + 1);
  console.log(`\n--- ${slot.title}: ${slot.tracks.length} tracks, ${dur(total)} (${(total / 60).toFixed(0)} min) — ${[...genres].map(([g, n]) => `${g}×${n}`).join(', ')}`);
  if (quiet) continue;
  for (const t of slot.tracks) {
    console.log(`  ${fmtHM(t.startMin)}  L${t.level}  ${dur(t.sec).padStart(5)}  ${t.genre.padEnd(20)} ${t.id}`);
  }
}
const ids = plan.slots.flatMap((s) => s.tracks.map((t) => t.id));
console.log(`\ndisjoint: ${new Set(ids).size === ids.length ? 'yes' : 'NO — duplicate tracks!'} · ${ids.length} tracks total`);
