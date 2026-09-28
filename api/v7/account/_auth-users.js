/* Shared Supabase Auth helpers for v7 signup + check-email (service key,
   server-only).

   "Registered" = an auth user that owns a business. check-email uses it to
   stop an already-registered email at the registration screen (before
   payment); signup enforces the same rule server-side. */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function adminHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Look up an auth user by email via the admin user list's `filter` (a
// substring match — so exact-match the result). Deliberately NOT admin
// generate_link: that counts as a login-link send and would trip Supabase's
// per-user email interval, making signup's real magic-link email fail.
// Returns the user or null. Throws on a failed lookup — callers must never
// mistake an error for "no such user".
export async function findUserByEmail(email) {
  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`,
    { headers: adminHeaders() },
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`auth user lookup failed: ${r.status}`);
  const list = Array.isArray(data?.users) ? data.users : [];
  return list.find((u) => String(u.email || '').toLowerCase() === email) || null;
}

// Ids of every business the user owns (any version).
export async function businessIdsOf(userId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${userId}&select=id`,
    { headers: adminHeaders() },
  );
  if (!r.ok) throw new Error('businesses lookup failed');
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows.map((b) => b.id) : [];
}

// Verified = the owner clicked an emailed link at least once.
export function isVerified(user) {
  return !!user?.email_confirmed_at;
}

// Supabase refuses a password that breaks its rules with error_code
// 'weak_password'. The length / character rules are already checked by
// shared/password-rules.js before we get here, so in practice this is the
// leaked-password check (reason 'pwned'). Surfaced to the owner as a 400 with
// code 'weak_password' so the client can ask for a different one.
function weakPasswordError(reasons) {
  const err = new Error(reasons.includes('pwned')
    ? 'הסיסמה הזו הופיעה בדליפת מידע ולכן לא בטוחה — בחרו סיסמה אחרת'
    : 'הסיסמה לא עומדת בדרישות — בחרו סיסמה אחרת');
  err.status = 400;
  err.code = 'weak_password';
  return err;
}

async function readAuthError(r) {
  const j = await r.json().catch(() => ({}));
  if (j?.error_code === 'weak_password') {
    throw weakPasswordError(Array.isArray(j.weak_password?.reasons) ? j.weak_password.reasons : []);
  }
  return j;
}

// Create an unverified user (the emailed link verifies it). Returns the user,
// or null when Supabase refused — most likely because the email already exists
// (a concurrent signup won the race).
export async function createUser(email, password) {
  const body = { email, email_confirm: false };
  if (password) body.password = password;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  if (r.ok) {
    const created = await r.json().catch(() => ({}));
    return created?.id ? created : null;
  }
  await readAuthError(r);
  return null;
}

export async function setPassword(userId, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ password }),
  });
  if (r.ok) return;
  const j = await readAuthError(r);
  throw new Error(`password update failed: ${r.status} ${String(j?.msg || j?.message || '').slice(0, 150)}`);
}

export async function deleteUser(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
  if (!r.ok) throw new Error(`auth user delete failed: ${r.status}`);
}
