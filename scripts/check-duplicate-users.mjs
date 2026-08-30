#!/usr/bin/env node
/**
 * Reports duplicate users in auth.users, at two levels:
 *   1. Exact-email duplicates — same string, count > 1. Should be
 *      impossible if the Supabase auth.users unique constraint is intact.
 *   2. Gmail alias collisions — `foo+bar@gmail.com`, `f.o.o@gmail.com`
 *      and `foo@gmail.com` all deliver to the same Gmail inbox in
 *      practice but Supabase treats them as distinct accounts. Not a
 *      bug, but worth surfacing so the operator knows they're the same
 *      real person.
 *
 * Read-only. Uses the Supabase admin API (SUPABASE_SERVICE_ROLE_KEY).
 *
 * Usage (PowerShell):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/check-duplicate-users.mjs
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Normalize a Gmail-family email address for collision detection:
//   1. lowercase everything
//   2. strip the +suffix (foo+bar → foo)
//   3. remove dots from the local part (f.o.o → foo)  ← Gmail-specific
// Non-Gmail addresses only get lowercased.
function gmailNormalize(email) {
  const lower = String(email || '').toLowerCase().trim();
  const [local, domain] = lower.split('@');
  if (!local || !domain) return lower;
  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  const stripped = local.split('+')[0];
  const dotsOut  = isGmail ? stripped.replace(/\./g, '') : stripped;
  return `${dotsOut}@${isGmail ? 'gmail.com' : domain}`;
}

// Paginate through auth.users via the admin API. Supabase returns 50 per
// page by default; increase to 1000 to keep round-trips low.
async function listAllUsers() {
  const users = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const url = `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
    const r = await fetch(url, {
      headers: {
        apikey:        SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });
    if (!r.ok) throw new Error(`admin/users page ${page} → ${r.status}: ${await r.text().catch(() => '')}`);
    const data = await r.json().catch(() => ({}));
    const chunk = Array.isArray(data?.users) ? data.users : [];
    users.push(...chunk);
    if (chunk.length < perPage) break;
    page += 1;
  }
  return users;
}

(async () => {
  console.log('Fetching all auth.users...');
  const users = await listAllUsers();
  console.log(`Loaded ${users.length} user(s).\n`);

  // 1. Exact-email duplicates
  const byEmail = new Map();
  for (const u of users) {
    const key = String(u.email || '').toLowerCase().trim();
    if (!key) continue;
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(u);
  }
  const exactDupes = [...byEmail.entries()].filter(([, arr]) => arr.length > 1);
  console.log('=== 1. Exact-email duplicates ===');
  if (!exactDupes.length) {
    console.log('  none — Supabase\'s unique constraint on auth.users.email is intact.\n');
  } else {
    for (const [email, arr] of exactDupes) {
      console.log(`  ${email}  (${arr.length} rows):`);
      for (const u of arr) console.log(`    ${u.id}  created=${u.created_at}`);
    }
    console.log('');
  }

  // 2. Gmail alias / dot collisions
  const byGmailNorm = new Map();
  for (const u of users) {
    const norm = gmailNormalize(u.email);
    if (!byGmailNorm.has(norm)) byGmailNorm.set(norm, []);
    byGmailNorm.get(norm).push(u);
  }
  // Filter to genuine collisions where the raw strings differ (otherwise
  // it's just the exact-dupe case above).
  const aliasCollisions = [...byGmailNorm.entries()]
    .filter(([, arr]) => arr.length > 1)
    .filter(([, arr]) => new Set(arr.map((u) => (u.email || '').toLowerCase())).size > 1);
  console.log('=== 2. Gmail alias collisions (same real inbox, different Supabase account) ===');
  if (!aliasCollisions.length) {
    console.log('  none — every Gmail-normalized address maps to a single account.');
    console.log('  (This is INFORMATIONAL: Gmail aliases are NOT rejected at signup by design;');
    console.log('   they were the source of my earlier "15 duplicates" false alarm in this session.)');
  } else {
    for (const [norm, arr] of aliasCollisions) {
      console.log(`  ${norm}  (${arr.length} distinct Supabase accounts):`);
      for (const u of arr) {
        console.log(`    ${u.email}  id=${u.id}  created=${u.created_at}`);
      }
    }
  }
  console.log('');

  console.log('=== Summary ===');
  console.log(`  Total users:              ${users.length}`);
  console.log(`  Exact-email duplicates:   ${exactDupes.length}`);
  console.log(`  Gmail alias collisions:   ${aliasCollisions.length}`);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
