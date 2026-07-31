/* /api/v6/account/signup.js
   Onboarding → personal-area bridge.

   Called by v6's onboarding after playlists finish building. Creates (or
   finds) a Supabase auth user for the given email, ensures a `businesses`
   row exists for them, stores the just-built playlists inside
   user_metadata.sonic.b[bizId].playlists, and returns an instant login
   link so the browser can jump straight into /v6/account.

   Request body: {
     email, password?,
     business_name?, business_type?, atmospheres?, place?,
     playlists?: [ { ico, label, url, id, trackCount, genres, createdAt, expansion? } ]
                  // `expansion` = { direction, popularityWindow } — carried
                  //  through verbatim so the dashboard's expand-playlist
                  //  endpoint can grow the playlist without re-running the
                  //  atmosphere/directions flow.
   }
   Response: { ok: true, existing_user, business_id, login_url, emailed }
*/

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const REDIRECT_TO = process.env.V6_ACCOUNT_REDIRECT_URL || 'https://robin-music.com/v6/account';

// v6 has no subscription tiers — everyone gets the same starter credit pool.
const DEFAULT_CREDITS = 30;

function adminHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Create the auth user; if they already exist, resolve them via a
// generate_link call (which returns the user object without sending mail).
async function findOrCreateUser(email, password) {
  const body = { email, email_confirm: true };
  if (password) body.password = password; // registration → password login
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  const created = await createRes.json().catch(() => ({}));
  if (createRes.ok && created?.id) return { user: created, existing: false };

  // Address already registered + password supplied: many existing accounts
  // were created passwordless (magic-link era), so "go log in" would dead-end
  // them. DEMO behavior: set the new password on the existing account and
  // continue. Before real payments this must become email verification.
  if (password) {
    const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ type: 'magiclink', email }),
    });
    const linkData = await linkRes.json().catch(() => ({}));
    const user = linkData?.user || (linkData?.id ? linkData : null);
    if (!user?.id) throw new Error('could not create or find user');
    const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT', headers: adminHeaders(),
      body: JSON.stringify({ password }),
    });
    if (!upd.ok) throw new Error('password update failed');
    return { user, existing: true };
  }

  // Probably "already registered" — resolve via generate_link (magiclink).
  const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const linkData = await linkRes.json().catch(() => ({}));
  const user = linkData?.user || (linkData?.id ? linkData : null);
  if (!user?.id) {
    throw new Error(created?.msg || created?.message || linkData?.msg || 'could not create or find user');
  }
  return { user, existing: true };
}

// Ensure a businesses row exists for the owner. Returns the business row's id.
// Reuses the first existing business (updating its name if provided); creates
// a new one if none exist.
async function ensureBusiness(ownerId, name, credits) {
  const q = `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${ownerId}&select=id,name`;
  const existingRes = await fetch(q, { headers: adminHeaders() });
  const rows = await existingRes.json().catch(() => []);
  if (!existingRes.ok) throw new Error('businesses lookup failed');

  if (Array.isArray(rows) && rows.length) {
    const match = rows[0];
    const patch = { monthly_credits: credits, credits_remaining: credits };
    if (name) patch.name = name;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/businesses?id=eq.${match.id}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error('businesses update failed');
    return match.id;
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/businesses`, {
    method: 'POST',
    headers: { ...adminHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({
      owner_id: ownerId,
      name: name || '',
      monthly_credits: credits,
      credits_remaining: credits,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`businesses insert failed: ${t.slice(0, 150)}`);
  }
  const created = await r.json().catch(() => null);
  const row = Array.isArray(created) ? created[0] : created;
  if (!row?.id) throw new Error('businesses insert returned no row');
  return row.id;
}

// Read the existing user_metadata.sonic blob (if any) so we don't clobber
// unrelated fields when we write playlists in.
async function readUserSonicMeta(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: adminHeaders(),
  });
  if (!r.ok) return {};
  const j = await r.json().catch(() => ({}));
  return (j?.user_metadata?.sonic) || (j?.user_metadata?.sonic === 0 ? {} : (j?.user_metadata?.sonic || {}));
}

async function writeUserSonicMeta(userId, sonic) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ user_metadata: { sonic } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`user_metadata write failed: ${t.slice(0, 150)}`);
  }
}

// Generate a one-time sign-in link (admin API) so the buyer lands in the
// personal area immediately, without waiting for an email round-trip.
async function generateLoginLink(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ type: 'magiclink', email, redirect_to: REDIRECT_TO }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.msg || data?.message || 'generate_link failed');
  return data?.action_link || data?.properties?.action_link || null;
}

// Fallback: send the magic-link email with the PUBLIC anon key (same as the
// client would). Used only when generating a direct link fails.
async function sendMagicLink(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(REDIRECT_TO)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, create_user: false, redirect_to: REDIRECT_TO }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`otp send failed: ${t.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!SERVICE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    }

    const {
      email,
      password,
      business_name,
      business_type,
      atmospheres,
      place,
      playlists,
    } = req.body || {};

    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'valid email required' });
    }

    const name = String(business_name || '').trim().slice(0, 80);
    const { user, existing } = await findOrCreateUser(cleanEmail, String(password || '') || null);
    const businessId = await ensureBusiness(user.id, name, DEFAULT_CREDITS);

    // Merge user_metadata.sonic non-destructively.
    // - New users get onboarding context written verbatim.
    // - For everyone, if playlists were supplied, append them to
    //   b[businessId].playlists (keep the most recent 20).
    const currentSonic = await readUserSonicMeta(user.id);
    const nextSonic = { ...currentSonic };

    if (!existing) {
      nextSonic.onboarding = {
        bizType:     business_type || null,
        atmospheres: atmospheres   || [],
        place:       place         || null,
      };
    }
    nextSonic.currentBizId = businessId;

    const bMap = { ...(nextSonic.b || {}) };
    const bRow = { ...(bMap[businessId] || {}) };
    if (Array.isArray(playlists) && playlists.length) {
      const prior = Array.isArray(bRow.playlists) ? bRow.playlists : [];
      bRow.playlists = [...playlists, ...prior].slice(0, 20);
    }
    bMap[businessId] = bRow;
    nextSonic.b = bMap;

    try { await writeUserSonicMeta(user.id, nextSonic); }
    catch (e) { console.warn('[signup] user_metadata write failed:', e.message); }

    // Instant login link; email fallback only when there's a real inbox.
    let loginUrl = null;
    let emailed  = false;
    try { loginUrl = await generateLoginLink(cleanEmail); }
    catch (e) { console.warn('[signup] generate_link failed:', e.message); }
    if (!loginUrl) {
      try { await sendMagicLink(cleanEmail); emailed = true; }
      catch (e) { console.warn('[signup] magic-link fallback failed:', e.message); }
    }

    console.log(`[signup:v6] ${existing ? 'existing' : 'new'} ${cleanEmail} → biz ${businessId} (${Array.isArray(playlists) ? playlists.length : 0} playlists)`);
    return res.status(200).json({
      ok: true,
      existing_user: existing,
      business_id:   businessId,
      login_url:     loginUrl,
      emailed,
    });
  } catch (err) {
    console.error('[signup:v6] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
