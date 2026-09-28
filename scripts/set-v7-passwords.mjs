#!/usr/bin/env node
/**
 * One-off (2026-09-28): give every existing v7 account a password.
 *
 * v7 accounts created before passwords existed have none, so they can't use
 * the new email + password login. This sets one shared password on each of
 * them; tell the owners, and they change it in Profile → סיסמה (or use
 * "שכחתי סיסמה").
 *
 * Target = every auth user who owns a businesses.version = 'v7' row AND was
 * created before --before. The date guard means a later re-run can't
 * overwrite passwords owners chose themselves — pass the day passwords went
 * live.
 *
 * Accounts that were never verified still need to click an email link before
 * the password works (the login page offers to resend it).
 *
 * DEFAULT IS A DRY RUN — prints the targets, changes nothing.
 *
 * Usage (repo root; reads .env.local):
 *   node scripts/set-v7-passwords.mjs <password> --before=2026-09-29            dry run
 *   node scripts/set-v7-passwords.mjs <password> --before=2026-09-29 --confirm  do it
 */

import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passwordProblem, PASSWORD_RULES_TEXT } from '../shared/password-rules.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* rely on real env */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const beforeArg = args.find((a) => a.startsWith('--before='))?.slice('--before='.length);
const password = args.find((a) => !a.startsWith('--'));
const before = beforeArg ? new Date(beforeArg) : null;

if (!password) {
  console.error(`Give the password as the first argument (${PASSWORD_RULES_TEXT}).`);
  process.exit(1);
}
const problem = passwordProblem(password);
if (problem) {
  console.error(`Password rejected: ${problem}`);
  process.exit(1);
}
if (!before || Number.isNaN(before.getTime())) {
  console.error('Missing or invalid --before=YYYY-MM-DD (only accounts created before it are touched).');
  process.exit(1);
}

const HDR = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function req(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}${path}`, { method, headers: HDR, body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${path.slice(0, 100)} → ${r.status}: ${typeof d === 'string' ? d : JSON.stringify(d)}`.slice(0, 300));
  return d;
}

const businesses = await req('GET', '/rest/v1/businesses?version=eq.v7&select=name,owner_id');
const namesByOwner = new Map();
for (const b of businesses) {
  if (!b.owner_id) continue;
  namesByOwner.set(b.owner_id, [...(namesByOwner.get(b.owner_id) || []), b.name || '(no name)']);
}

const targets = [];
for (const ownerId of namesByOwner.keys()) {
  const u = await req('GET', `/auth/v1/admin/users/${ownerId}`);
  if (new Date(u.created_at) >= before) continue;
  targets.push({ id: ownerId, email: u.email, created: u.created_at, verified: !!u.email_confirmed_at });
}

console.log(`${targets.length} v7 account(s) created before ${beforeArg}:`);
for (const t of targets) {
  console.log(`  ${t.email}  created ${t.created.slice(0, 10)}  ${t.verified ? 'verified' : 'NOT verified'}  — ${namesByOwner.get(t.id).join(', ')}`);
}

if (!CONFIRM) {
  console.log('\nDry run — nothing changed. Add --confirm to set the password.');
  process.exit(0);
}

let ok = 0;
for (const t of targets) {
  try {
    await req('PUT', `/auth/v1/admin/users/${t.id}`, { password });
    ok++;
    console.log(`  ✓ ${t.email}`);
  } catch (e) {
    console.log(`  ✗ ${t.email}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`\nDone: ${ok}/${targets.length} updated.`);
