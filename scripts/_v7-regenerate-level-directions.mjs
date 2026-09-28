#!/usr/bin/env node
/**
 * Option 2 level directions (business_v7_level_directions) for existing v7
 * businesses: report, test, or (re)generate them with the CURRENT prompt
 * (v7/generation/level-directions.js). Written 2026-09-28 when Option 2 moved
 * from "every genre of the level" to a library of directions per energy
 * level, rotated daily.
 *
 * Same inputs as the dashboard's ensureLevelDirections (taste profile,
 * business name / description / emphases, onboarding atmospheres from the
 * owner's user metadata, business_place), same Gemini label
 * ('v7-level-directions', spend attributed to the business), same row shape
 * as /api/v7/account/save-level-directions (shapeLevelRows, incl. the
 * profile_key the dashboard uses to decide whether a stored library can be
 * reused).
 *
 * Generation runs through `vercel dev`'s /api/v6/gemini (the generator does a
 * relative fetch) — keep `vercel dev` running on port 3000.
 *
 * Usage (from the repo root; reads .env.local if the vars aren't set):
 *   node scripts/_v7-regenerate-level-directions.mjs                        list the Option-2 businesses (no Gemini, no writes)
 *   node scripts/_v7-regenerate-level-directions.mjs --generate             generate + print per-level results, NO writes
 *   node scripts/_v7-regenerate-level-directions.mjs --generate --all       …for every v7 business, whatever its type
 *   node scripts/_v7-regenerate-level-directions.mjs --confirm              generate + replace, all Option-2 businesses
 *   node scripts/_v7-regenerate-level-directions.mjs --confirm <businessId> [...]   only these
 *
 * --confirm keeps a business's old set when generation fails or a level
 * that has approved genres comes back without a direction.
 * Needs migration v5/precompute/migrations/2026-09-28-v7-level-directions.sql
 * for --confirm (and to show stored libraries).
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
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (set them or keep them in .env.local).');
  process.exit(1);
}

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const generate = confirm || args.includes('--generate');
const all = args.includes('--all') && !confirm;
const onlyIds = args.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
const DEV = process.env.DEV_BASE || 'http://127.0.0.1:3000';
const CONCURRENCY = 3;

// The generator calls fetch('/api/v6/gemini') — route relative URLs to vercel
// dev, with a localhost Origin so the origin guard passes.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Origin')) headers.set('Origin', DEV);
    return realFetch(DEV + input, { ...init, headers });
  }
  return realFetch(input, init);
};

const imp = (p) => import(pathToFileURL(join(repoRoot, p)).href);
const { generateLevelDirections, approvedByLevel } = await imp('v7/generation/level-directions.js');
const { shapeLevelRows } = await imp('api/v7/account/save-level-directions.js');
const { levelProfileKey } = await imp('v7/generation/timeline-assembler.js');
const { normLevels } = await imp('v7/generation/energy-timeline.js');
const { pgrSelect, pgrDelete, pgrInsert } = await imp('api/v5/supabase-client.js');

const sel = (table, filters, select) => pgrSelect(table, filters, { select, useService: true });

async function ownerAtmospheres(ownerId) {
  try {
    const r = await realFetch(`${SUPABASE_URL}/auth/v1/admin/users/${ownerId}`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    const u = r.ok ? await r.json() : null;
    const atm = u?.user_metadata?.sonic?.onboarding?.atmospheres;
    return Array.isArray(atm) ? atm : [];
  } catch { return []; }
}

// Stored library (null when the table isn't there yet).
async function storedLibrary(businessId) {
  try {
    return await sel('business_v7_level_directions', { business_id: `eq.${businessId}` },
      'energy_level,rank,title_en,genres,profile_key,active');
  } catch { return null; }
}

// "L1 3g→2d · L2 5g→3d …" plus the direction list.
function levelReport(approved, N, directions) {
  const cells = [];
  const missing = [];
  for (let L = 1; L <= N; L++) {
    const g = approved.filter((a) => a.energy_level === L).length;
    const d = directions.filter((x) => x.energy_level === L).length;
    if (g && !d) missing.push(L);
    cells.push(`L${L} ${g}g→${d}d`);
  }
  return { line: cells.join(' · '), missing };
}

let targetIds;
if (all) {
  targetIds = (await sel('businesses', { version: 'eq.v7' }, 'id')).map((b) => b.id);
} else {
  targetIds = (await sel('business_v7_settings', { delivery_mode: 'eq.option2' }, 'business_id')).map((s) => s.business_id);
}
if (onlyIds.length) targetIds = targetIds.filter((id) => onlyIds.includes(id));
if (!targetIds.length) { console.log(`No ${all ? 'v7' : 'Option-2'} businesses to process.`); process.exit(0); }

const businesses = await sel('businesses', { id: `in.(${targetIds.join(',')})`, version: 'eq.v7' },
  'id,owner_id,name,business_description,musical_emphases');
const mode = confirm ? 'GENERATE + REPLACE' : generate ? 'GENERATE ONLY — no writes' : 'LIST ONLY (add --generate or --confirm)';
console.log(`${businesses.length} ${all ? 'v7' : 'Option-2'} business(es) — ${mode}\n`);

async function processOne(b) {
  const out = [];
  const [tp] = await sel('business_taste_profiles', { business_id: `eq.${b.id}` }, 'approved_genres,energy_levels_total');
  const N = normLevels(tp?.energy_levels_total);
  const approved = approvedByLevel(tp?.approved_genres, N);
  const old = await storedLibrary(b.id);
  const key = tp ? levelProfileKey(tp) : null;
  const oldNote = old == null ? 'table missing'
    : !old.length ? 'no stored library'
      : `stored ${old.length} (${old.every((o) => o.profile_key === key) ? 'fits the profile' : 'OLDER profile'})`;
  out.push(`— ${b.id.slice(0, 8)} "${b.name}": N=${N}, ${approved.length} approved (${levelReport(approved, N, []).line.replace(/→0d/g, '')}), ${oldNote}`);
  if (!generate) return { out, status: 'listed' };
  if (!approved.length) { out.push('  skipped: no taste profile / approved genres'); return { out, status: 'kept' }; }

  const [place] = await sel('business_place', { business_id: `eq.${b.id}` }, '*');
  const t0 = Date.now();
  const result = await generateLevelDirections({
    tasteProfile: tp,
    bizName: b.name || '',
    bizDesc: b.business_description || '',
    atmospheres: await ownerAtmospheres(b.owner_id),
    musicalEmphases: b.musical_emphases || '',
    place: place || null,
    businessId: b.id,
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (result?.error || !result?.directions?.length) {
    out.push(`  ${confirm ? 'KEPT old set — ' : ''}generation failed after ${secs}s: ${result?.error || 'no directions'} ${result?.reasoning_en || ''}`);
    return { out, status: 'kept' };
  }
  const { rows } = shapeLevelRows(b.id, result.directions, tp);
  const rep = levelReport(approved, N, rows);
  out.push(`  ${rows.length} directions in ${secs}s: ${rep.line}`);
  for (const r of rows) out.push(`    L${r.energy_level} #${r.rank} ${r.title_en}: ${r.genres.join(', ')}`);
  if (!confirm) return { out, status: 'generated' };

  if (rep.missing.length) {
    out.push(`  KEPT old set — level(s) ${rep.missing.join(', ')} have genres but got no direction`);
    return { out, status: 'kept' };
  }
  // Replace, same as save-level-directions. If the insert fails after the
  // delete, put the old rows back so the business isn't left without any.
  await pgrDelete('business_v7_level_directions', { business_id: `eq.${b.id}` });
  try {
    await pgrInsert('business_v7_level_directions', rows);
  } catch (e) {
    out.push(`  insert failed (${e.message}) — restoring the old set`);
    if (old?.length) await pgrInsert('business_v7_level_directions', old.map((o) => ({ ...o, business_id: b.id })));
    return { out, status: 'kept' };
  }
  out.push('  REPLACED');
  return { out, status: 'replaced' };
}

const queue = [...businesses];
const counts = {};
await Promise.all(Array.from({ length: generate ? CONCURRENCY : 1 }, async () => {
  while (queue.length) {
    const b = queue.shift();
    let r;
    try { r = await processOne(b); }
    catch (e) { r = { out: [`— ${b.id.slice(0, 8)} "${b.name}": ERROR ${e.message}`], status: 'kept' }; }
    console.log(r.out.join('\n'));
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
}));

if (generate) console.log(`\nDone — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
