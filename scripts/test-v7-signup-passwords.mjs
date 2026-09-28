#!/usr/bin/env node
/**
 * Integration test for v7 passwords (2026-09-28): check-email + the signup
 * password rules in api/v7/account/signup.js.
 *
 * Runs against `vercel dev` (:3000) → prod Supabase with throwaway
 * @example.invalid users (no email is ever sent — skipEmail + the internal
 * key). Cleans up after itself. Safe to run against prod.
 *
 *   node scripts/test-v7-signup-passwords.mjs
 */

import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* rely on real env */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const DEV_BASE     = `http://127.0.0.1:${process.env.DEV_PORT || '3000'}`;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !INTERNAL_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / INTERNAL_API_KEY.');
  process.exit(1);
}

const ADMIN = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
const stamp = Date.now();
const EMAIL  = `v7pw-${stamp}@example.invalid`;
const ORPHAN = `v7pw-orphan-${stamp}@example.invalid`;
const PROFILE = { energy_levels_total: 2, approved_genres: [{ genre: 'Bossa Nova', energy_level: 1 }] };

let failures = 0;
function check(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${cond ? '' : `  ${extra}`}`);
  if (!cond) failures++;
}

async function api(path, body, { internal = true } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: DEV_BASE };
  if (internal) headers['x-sonic-internal'] = INTERNAL_KEY;
  const r = await fetch(`${DEV_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const signup = (extra) => api('/api/v7/account/signup', {
  email: EMAIL, name: 'password test', tasteProfile: PROFILE, skipEmail: true, ...extra,
});

async function passwordLogin(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function findUser(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`, { headers: ADMIN });
  const d = await r.json();
  return (d.users || []).find((u) => u.email === email) || null;
}

// Stand-in for the owner clicking the emailed link.
async function verifyEmail(email) {
  const gen = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'magiclink', email }),
  })).json();
  const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gen.hashed_token || gen.properties?.hashed_token }),
  });
  return r.ok;
}

async function cleanup() {
  for (const email of [EMAIL, ORPHAN]) {
    const u = await findUser(email).catch(() => null);
    if (!u) continue;
    await fetch(`${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${u.id}`, { method: 'DELETE', headers: ADMIN });
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: ADMIN });
  }
}

try {
  console.log(`\n[1] new email ${EMAIL}`);
  let r = await api('/api/v7/account/check-email', { email: EMAIL });
  check('check-email: not registered', r.status === 200 && r.json.registered === false, JSON.stringify(r));

  r = await api('/api/v7/account/signup', { email: EMAIL, tasteProfile: PROFILE, password: 'short' }, { internal: false });
  check('signup: short password → 400 bad_password', r.status === 400 && r.json.code === 'bad_password', JSON.stringify(r));
  r = await api('/api/v7/account/signup', { email: EMAIL, tasteProfile: PROFILE, password: 'lowercase123' }, { internal: false });
  check('signup: no uppercase letter → 400 bad_password', r.status === 400 && r.json.code === 'bad_password', JSON.stringify(r));

  r = await signup({ password: 'FirstPass111' });
  const businessId = r.json.business_id;
  check('signup: account created', r.status === 200 && r.json.existing_user === false && !!businessId, JSON.stringify(r));

  r = await api('/api/v7/account/check-email', { email: EMAIL });
  check('check-email: now registered', r.json.registered === true, JSON.stringify(r));

  r = await passwordLogin(EMAIL, 'FirstPass111');
  check('password login before verifying → email_not_confirmed', r.status === 400 && r.json.error_code === 'email_not_confirmed', JSON.stringify(r.json));

  console.log('\n[2] re-signup of an unverified account');
  r = await signup({ password: 'AttackerPass1' });
  check('without resendFor → 409 already_registered', r.status === 409 && r.json.code === 'already_registered', JSON.stringify(r));

  r = await signup({ password: 'SecondPass222', resendFor: businessId });
  check('resend (resendFor) → ok, same business', r.status === 200 && r.json.business_id === businessId, JSON.stringify(r));

  console.log('\n[3] after the email link is clicked');
  check('email verified', await verifyEmail(EMAIL));

  r = await passwordLogin(EMAIL, 'SecondPass222');
  check('password login with the latest password works', r.status === 200 && !!r.json.access_token, JSON.stringify(r.json));
  r = await passwordLogin(EMAIL, 'FirstPass111');
  check('old password refused (invalid_credentials)', r.status === 400 && r.json.error_code === 'invalid_credentials', JSON.stringify(r.json));
  r = await passwordLogin(EMAIL, 'AttackerPass1');
  check('refused signup\'s password never applied', r.status === 400, JSON.stringify(r.json));
  r = await passwordLogin(`nobody-${stamp}@example.invalid`, 'SecondPass222');
  check('unknown email → same invalid_credentials error', r.status === 400 && r.json.error_code === 'invalid_credentials', JSON.stringify(r.json));

  r = await signup({ password: 'ThirdPass333', resendFor: businessId });
  check('re-signup of a verified account → 409', r.status === 409 && r.json.code === 'already_registered', JSON.stringify(r));
  r = await passwordLogin(EMAIL, 'SecondPass222');
  check('verified account keeps its password', r.status === 200, JSON.stringify(r.json));

  console.log(`\n[4] verified login with no business (${ORPHAN})`);
  const orphanRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: ADMIN, body: JSON.stringify({ email: ORPHAN, email_confirm: true }),
  });
  const orphan = await orphanRes.json();
  r = await api('/api/v7/account/check-email', { email: ORPHAN });
  check('check-email: not registered', r.json.registered === false, JSON.stringify(r));
  r = await api('/api/v7/account/signup', { email: ORPHAN, tasteProfile: PROFILE, skipEmail: true, password: 'OrphanPass1' });
  check('signup ok', r.status === 200, JSON.stringify(r));
  const recreated = await findUser(ORPHAN);
  check('replaced by a new, unverified user', recreated && recreated.id !== orphan.id && !recreated.email_confirmed_at);
  r = await passwordLogin(ORPHAN, 'OrphanPass1');
  check('its password waits for the email link', r.json.error_code === 'email_not_confirmed', JSON.stringify(r.json));
} catch (e) {
  failures++;
  console.error('  ✗ threw:', e.message);
} finally {
  await cleanup();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}
