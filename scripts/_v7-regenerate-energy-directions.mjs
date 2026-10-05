#!/usr/bin/env node
/**
 * Regenerate the Option-1 energy directions of existing v7 businesses with
 * the CURRENT prompt (v7/generation/energy-directions.js) and replace their
 * business_v7_directions set — what re-picking Option 1 in the Profile tab
 * does, for every Option-1 business at once. Written for the 2026-09-28
 * switch from 4–7 tight clusters to a library of up to 30 v6-style blends.
 * Also for the 2026-10-05 requested-genres rule (each requested genre in every
 * direction of its tier): run scripts/_v7-backfill-requested-genres.mjs first.
 *
 * Same inputs as the dashboard's buildEnergyDirections (taste profile,
 * business name / description / emphases, onboarding atmospheres from the
 * owner's user metadata, business_place), same Gemini label
 * ('v7-energy-directions', spend attributed to the business), same row shape
 * as /api/v7/account/save-energy-directions (shapeRows). A business whose
 * generation fails, or comes back without a direction for a tier it has
 * genres in, keeps its old set.
 *
 * Generation runs through `vercel dev`'s /api/v6/gemini (the generator does a
 * relative fetch) — keep `vercel dev` running on port 3000.
 *
 * Usage (from the repo root; reads .env.local if the vars aren't set):
 *   node scripts/_v7-regenerate-energy-directions.mjs                  dry run: list the businesses, no Gemini, no writes
 *   node scripts/_v7-regenerate-energy-directions.mjs --confirm        regenerate + replace, all Option-1 businesses
 *   node scripts/_v7-regenerate-energy-directions.mjs --confirm <businessId> [...]   only these
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
const onlyIds = args.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
const DEV = process.env.DEV_BASE || 'http://127.0.0.1:3000';

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
const { generateEnergyDirections } = await imp('v7/generation/energy-directions.js');
const { shapeRows } = await imp('api/v7/account/save-energy-directions.js');
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

const tierCounts = (dirs) => `high ${dirs.filter((d) => d.energy_tier === 'high').length} / low ${dirs.filter((d) => d.energy_tier === 'low').length}`;

const settings = await sel('business_v7_settings', { delivery_mode: 'eq.option1' }, 'business_id');
let targetIds = settings.map((s) => s.business_id);
if (onlyIds.length) targetIds = targetIds.filter((id) => onlyIds.includes(id));
if (!targetIds.length) { console.log('No Option-1 businesses to regenerate.'); process.exit(0); }

const businesses = await sel('businesses', { id: `in.(${targetIds.join(',')})`, version: 'eq.v7' },
  'id,owner_id,name,business_description,musical_emphases');
console.log(`${businesses.length} v7 Option-1 business(es)${confirm ? '' : ' — DRY RUN (add --confirm to regenerate)'}\n`);

let replaced = 0, kept = 0;
for (const b of businesses) {
  // '*' so requested_genres comes along once its migration (2026-10-05) has run.
  const [tp] = await sel('business_taste_profiles', { business_id: `eq.${b.id}` }, '*');
  const old = await sel('business_v7_directions', { business_id: `eq.${b.id}` }, 'energy_tier,rank,title_en,genres,active');
  const approved = tp?.approved_genres || [];
  const requested = Array.isArray(tp?.requested_genres) ? tp.requested_genres.join(', ') || 'none' : 'not recorded';
  console.log(`— ${b.id.slice(0, 8)} "${b.name}": ${approved.length} approved genres (N=${tp?.energy_levels_total ?? '?'}), requested: ${requested}, current directions ${old.length} (${tierCounts(old)})`);
  if (!confirm) continue;
  if (!approved.length) { console.log('  skipped: no taste profile / approved genres'); kept++; continue; }

  const [place] = await sel('business_place', { business_id: `eq.${b.id}` }, '*');
  const t0 = Date.now();
  const result = await generateEnergyDirections({
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
    console.log(`  KEPT old set — generation failed after ${secs}s: ${result?.error || 'no directions'} ${result?.reasoning_en || ''}`);
    kept++; continue;
  }
  const rows = shapeRows(b.id, result.directions);
  const n = tp.energy_levels_total;
  const needHigh = approved.some((g) => g.energy_level > n / 2);
  const needLow = approved.some((g) => g.energy_level <= n / 2);
  if ((needHigh && !rows.some((r) => r.energy_tier === 'high')) || (needLow && !rows.some((r) => r.energy_tier === 'low'))) {
    console.log(`  KEPT old set — new set is missing a tier (${tierCounts(rows)})`);
    kept++; continue;
  }

  // Replace, same as save-energy-directions. If the insert fails after the
  // delete, put the old rows back so the business isn't left without any.
  await pgrDelete('business_v7_directions', { business_id: `eq.${b.id}` });
  try {
    await pgrInsert('business_v7_directions', rows);
  } catch (e) {
    console.log(`  insert failed (${e.message}) — restoring the old set`);
    if (old.length) await pgrInsert('business_v7_directions', old.map((o) => ({ ...o, business_id: b.id })));
    kept++; continue;
  }
  replaced++;
  console.log(`  replaced with ${rows.length} directions (${tierCounts(rows)}) in ${secs}s`);
  for (const r of rows) console.log(`    [${r.energy_tier}] ${r.title_en}: ${r.genres.join(', ')}`);
}

if (confirm) console.log(`\nDone — ${replaced} replaced, ${kept} kept their old set.`);
