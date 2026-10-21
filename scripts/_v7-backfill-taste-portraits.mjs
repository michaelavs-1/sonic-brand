#!/usr/bin/env node
/**
 * The first musical portrait for v7 businesses from before portraits existed
 * (2026-10-21; see v7/generation/taste-portrait-prompt.js). Each one is
 * written from the onboarding answers plus every taste-chat message so far,
 * with the production prompt and Gemini call (api/v7/account/_taste-portrait.js,
 * label 'v7-taste-portrait'), and saved with source 'backfill'.
 *
 * Gemini runs through `vercel dev`'s /api/v6/gemini — keep it running on
 * port 3000. Needs migration v5/precompute/migrations/2026-10-21-v7-taste-portraits.sql.
 *
 * Usage (from the repo root; reads .env.local):
 *   node scripts/_v7-backfill-taste-portraits.mjs                       list (no Gemini, no writes)
 *   node scripts/_v7-backfill-taste-portraits.mjs --confirm             write one for every business without a portrait
 *   node scripts/_v7-backfill-taste-portraits.mjs --confirm <businessId> [...]   only these
 */

import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const onlyIds = args.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
const DEV = process.env.DEV_BASE || 'http://127.0.0.1:3000';

// Imported after the env is loaded (the Supabase client reads it at load).
const { pgrSelect } = await import(pathToFileURL(join(repoRoot, 'api/v5/supabase-client.js')).href);
const { latestPortrait, writePortrait } = await import(pathToFileURL(join(repoRoot, 'api/v7/account/_taste-portrait.js')).href);

const businesses = await pgrSelect('businesses', { version: 'eq.v7' }, { select: 'id,name', useService: true });
const profiles = await pgrSelect('business_taste_profiles', {}, { select: 'business_id', useService: true });
const withProfile = new Set((profiles || []).map((p) => p.business_id));
let targets = (businesses || []).filter((b) => withProfile.has(b.id));
if (onlyIds.length) targets = targets.filter((b) => onlyIds.includes(b.id));

console.log(`${targets.length} v7 business(es) with a taste profile — ${confirm ? 'WRITING' : 'LIST ONLY (add --confirm)'}\n`);
let written = 0;
for (const b of targets) {
  const current = await latestPortrait(b.id);
  const chat = await pgrSelect('business_direction_chats', { business_id: `eq.${b.id}` },
    { select: 'id,role,content,created_at', order: 'created_at.asc', limit: 200, useService: true });
  const line = `— ${b.id.slice(0, 8)} "${b.name}": ${chat?.length || 0} chat messages, ${current ? 'HAS a portrait' : 'no portrait'}`;
  if (current || !confirm) { console.log(line); continue; }
  const t0 = Date.now();
  const out = await writePortrait({
    businessId: b.id, origin: DEV, source: 'backfill', withOnboarding: true,
    transcriptRows: (chat || []).slice(-60),
    transcriptTitle: 'Every conversation in the chat so far (oldest first)',
  });
  if (out.error) { console.log(`${line}\n  FAILED: ${out.error}`); continue; }
  written++;
  console.log(`${line}\n  written in ${((Date.now() - t0) / 1000).toFixed(0)}s:\n${out.portrait_he.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
}
if (confirm) console.log(`\nDone — ${written} written.`);
