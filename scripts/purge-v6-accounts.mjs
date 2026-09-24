#!/usr/bin/env node
/**
 * Delete every v6 account (2026-09-24, Roni: "all users created on v6").
 *
 * Target = every auth user whose businesses are ALL businesses.version = 'v6'
 * (users with any v7 business are left alone). For each target:
 *   1. Their still-live Spotify playlists (created_playlists rows for their
 *      businesses / user with deleted_at IS NULL, plus business_playlists rows
 *      that never got a ledger row) are marked expires_at = now, and the
 *      expire cron is triggered on `vercel dev` — the normal cleanup path
 *      (rename "(expired) …" + empty + unfollow through /api/new/spotify, with
 *      its pause switch / write counter / 404 tolerance). Removed NOW, not at
 *      their usual close + 2h.
 *   2. Their businesses rows are deleted (every business_* table CASCADEs;
 *      created_playlists + gemini_call_log keep their rows with business_id
 *      set to NULL).
 *   3. Their auth users are deleted.
 *
 * DEFAULT IS A DRY RUN — prints the targets and counts, changes nothing.
 * Take a backup first: node scripts/backup-db.mjs
 *
 * Usage (repo root; reads .env.local; needs `vercel dev` on :3000 for step 1):
 *   node scripts/purge-v6-accounts.mjs            dry run
 *   node scripts/purge-v6-accounts.mjs --confirm  do it
 */

import fs from 'node:fs';
import http from 'node:http';
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
const CRON_SECRET  = process.env.CRON_SECRET;
const DEV_BASE     = `http://127.0.0.1:${process.env.DEV_PORT || '3000'}`;
const CONFIRM      = process.argv.includes('--confirm');
if (!SUPABASE_URL || !SERVICE_KEY || !CRON_SECRET) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET.');
  process.exit(1);
}

const HDR = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function req(method, path, { body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, { method, headers: prefer ? { ...HDR, Prefer: prefer } : HDR, body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${path.slice(0, 120)} → ${r.status}: ${typeof d === 'string' ? d : JSON.stringify(d)}`.slice(0, 400));
  return d;
}
const inList = (ids) => `in.(${ids.join(',')})`;

// The expire sweep runs ~8 s per playlist, serially — easily past fetch()'s
// 5-minute headers timeout, and vercel dev stops the function when the client
// disconnects. node:http has no such client timeout.
function postCron(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${DEV_BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(body); } catch { } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    r.end();
  });
}
async function chunked(ids, size, fn) { const out = []; for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size)) || [])); return out; }

// ---- targets ----
let users = [];
for (let page = 1; page < 50; page++) {
  const d = await req('GET', `/auth/v1/admin/users?per_page=1000&page=${page}`);
  users = users.concat(d.users || []);
  if ((d.users || []).length < 1000) break;
}
const biz = await req('GET', '/rest/v1/businesses?select=id,owner_id,name,version&limit=10000');
const bizByOwner = new Map();
for (const b of biz) { if (!bizByOwner.has(b.owner_id)) bizByOwner.set(b.owner_id, []); bizByOwner.get(b.owner_id).push(b); }
const targets = users.filter((u) => {
  const bs = bizByOwner.get(u.id) || [];
  return bs.length > 0 && bs.every((b) => (b.version || 'v6') === 'v6');
});
const targetUserIds = targets.map((u) => u.id);
const targetBizIds = targets.flatMap((u) => bizByOwner.get(u.id).map((b) => b.id));

// ---- live playlists ----
const ledgerByBiz = targetBizIds.length ? await chunked(targetBizIds, 40, (ids) =>
  req('GET', `/rest/v1/created_playlists?select=spotify_id,name,expires_at&deleted_at=is.null&business_id=${inList(ids)}`)) : [];
const ledgerByOwner = targetUserIds.length ? await chunked(targetUserIds, 40, (ids) =>
  req('GET', `/rest/v1/created_playlists?select=spotify_id,name,expires_at&deleted_at=is.null&owner_id=${inList(ids)}`)) : [];
const live = new Map([...ledgerByBiz, ...ledgerByOwner].map((r) => [r.spotify_id, r]));
// business_playlists rows with NO ledger row at all (pre-ledger era) and not yet expired.
const bpRows = targetBizIds.length ? await chunked(targetBizIds, 40, (ids) =>
  req('GET', `/rest/v1/business_playlists?select=spotify_id,label,expires_at&business_id=${inList(ids)}&or=(expires_at.is.null,expires_at.gt.${new Date().toISOString()})`)) : [];
const bpIds = [...new Set(bpRows.map((r) => r.spotify_id))];
const ledgerAny = bpIds.length ? await chunked(bpIds, 60, (ids) => req('GET', `/rest/v1/created_playlists?select=spotify_id&spotify_id=${inList(ids)}`)) : [];
const hasLedger = new Set(ledgerAny.map((r) => r.spotify_id));
const noLedger = bpRows.filter((r) => !hasLedger.has(r.spotify_id));

console.log(`\n${CONFIRM ? 'PURGE' : 'DRY RUN'} — v6 accounts`);
console.log(`targets: ${targets.length} users, ${targetBizIds.length} businesses`);
for (const u of targets) console.log(`  ${u.email}  →  ${bizByOwner.get(u.id).map((b) => b.name || '(no name)').join(', ')}`);
console.log(`kept (have a v7 business): ${users.filter((u) => !targets.includes(u)).map((u) => u.email).join(', ') || '—'}`);
console.log(`live playlists to remove now: ${live.size} with a ledger row + ${noLedger.length} without one`);
if (!CONFIRM) { console.log('\nNothing changed. Re-run with --confirm.'); process.exit(0); }

// ---- 1. playlists → expire now, sweep via the cron on vercel dev ----
const nowIso = new Date().toISOString();
if (noLedger.length) {
  await req('POST', '/rest/v1/created_playlists?on_conflict=spotify_id', {
    body: noLedger.map((r) => ({ spotify_id: r.spotify_id, name: r.label || 'playlist', expires_at: nowIso, deleted_at: null, error: null })),
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}
const allIds = [...new Set([...live.keys(), ...noLedger.map((r) => r.spotify_id)])];
if (allIds.length) {
  await chunked(allIds, 60, (ids) => req('PATCH', `/rest/v1/created_playlists?spotify_id=${inList(ids)}`, {
    body: { expires_at: nowIso, next_attempt_at: null }, prefer: 'return=minimal' }));
  for (let pass = 1; pass <= 3; pass++) {
    const { status, json: out } = await postCron('/api/cron/expire-playlists');
    const r = { status };
    const left = await chunked(allIds, 60, (ids) => req('GET', `/rest/v1/created_playlists?select=spotify_id,last_error&deleted_at=is.null&spotify_id=${inList(ids)}`));
    console.log(`  expire sweep ${pass}: HTTP ${r.status} ${JSON.stringify(out).slice(0, 160)} — ${allIds.length - left.length}/${allIds.length} removed`);
    if (!left.length) break;
    if (pass === 3) console.warn(`  ${left.length} not removed yet (they stay in the ledger; the hourly cleanup retries): ${left.map((x) => `${x.spotify_id}${x.last_error ? ' — ' + String(x.last_error).slice(0, 80) : ''}`).join('; ')}`);
    else await new Promise((res) => setTimeout(res, 3000));
  }
}

// ---- 2. businesses (CASCADE) ----
for (const id of targetBizIds) await req('DELETE', `/rest/v1/businesses?id=eq.${id}`, { prefer: 'return=minimal' });
console.log(`  deleted ${targetBizIds.length} businesses`);

// ---- 3. auth users ----
for (const u of targets) await req('DELETE', `/auth/v1/admin/users/${u.id}`);
console.log(`  deleted ${targets.length} users`);

// ---- verify ----
const leftBiz = targetBizIds.length ? await chunked(targetBizIds, 40, (ids) => req('GET', `/rest/v1/businesses?select=id&id=${inList(ids)}`)) : [];
let usersAfter = [];
for (let page = 1; page < 50; page++) {
  const d = await req('GET', `/auth/v1/admin/users?per_page=1000&page=${page}`);
  usersAfter = usersAfter.concat(d.users || []);
  if ((d.users || []).length < 1000) break;
}
const leftUsers = usersAfter.filter((u) => targetUserIds.includes(u.id));
console.log(`\nverify: businesses left ${leftBiz.length}, target users left ${leftUsers.length}, users now ${usersAfter.length} (${usersAfter.map((u) => u.email).join(', ')})`);
