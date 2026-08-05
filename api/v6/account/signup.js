/* /api/v6/account/signup.js
   Onboarding → personal-area bridge (passwordless).

   Called by v6's onboarding after playlists finish building. Creates (or
   finds) a Supabase auth user for the given email, ensures a `businesses`
   row exists for them, stores the just-built playlists inside
   user_metadata.sonic.b[bizId].playlists, and emails a one-time magic
   link so the user can enter the account area by clicking through from
   their inbox.

   No passwords anywhere: `admin.createUser` is called without a password
   and with `email_confirm: false`; the click on the magic-link email is
   the verification step. Existing users get the same treatment — a fresh
   magic link is emailed and their business row / user_metadata is updated
   in place so their new onboarding session is attached to the account
   when they follow the link.

   Request body: {
     email,
     business_name?, business_type?, atmospheres?, place?,
     hours?, longestMinutes?,   // from the onboarding hours picker
     playlists?: [ { ico, label, url, id, trackCount, genres, createdAt, expansion? } ]
                  // `expansion` = { direction, popularityWindow } — carried
                  //  through verbatim so the dashboard's expand-playlist
                  //  endpoint can grow the playlist without re-running the
                  //  atmosphere/directions flow.
   }
   Response: { ok: true, existing_user, business_id, emailed: true, email }
*/

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// v6 has no subscription tiers — everyone gets the same starter credit pool.
const DEFAULT_CREDITS = 30;

// Derive the magic-link redirect target from the incoming request so this
// endpoint works unchanged from `vercel dev` (localhost), preview URLs, and
// production. Whatever host lands here has to also be on Supabase's
// Redirect URLs allow-list (Auth → URL Configuration) — otherwise Supabase
// silently substitutes its Site URL and the link goes to the wrong place.
function accountRedirectUrl(req) {
  if (process.env.V6_ACCOUNT_REDIRECT_URL) return process.env.V6_ACCOUNT_REDIRECT_URL;
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}/v6/account`;
}

function adminHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Look up an existing auth user by email via the admin generate_link endpoint
// (returns the user object without emailing anyone). Returns { id, ... } or
// null if the address isn't registered.
async function findUserByEmail(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  return data?.user || (data?.id ? data : null);
}

// Create the auth user (unconfirmed — clicking the magic link confirms). If
// they already exist, resolve them via generate_link so we can attach the new
// business under their account.
async function findOrCreateUser(email) {
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ email, email_confirm: false }),
  });
  const created = await createRes.json().catch(() => ({}));
  if (createRes.ok && created?.id) return { user: created, existing: false };

  const existing = await findUserByEmail(email);
  if (existing?.id) return { user: existing, existing: true };
  throw new Error(created?.msg || created?.message || 'could not create or find user');
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
  return (j?.user_metadata?.sonic) || {};
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

// Attach owner_id + business_id to created_playlists rows written by
// /api/v5/record-playlist during onboarding. Uses PostgREST's `in.(...)`
// filter for a single round-trip, plus `owner_id=is.null` so we only
// touch rows that were left unattributed.
async function backfillLedgerOwnership(spotifyIds, userId, businessId) {
  const list = spotifyIds.map(encodeURIComponent).join(',');
  const url  = `${SUPABASE_URL}/rest/v1/created_playlists?spotify_id=in.(${list})&owner_id=is.null`;
  const r = await fetch(url, {
    method:  'PATCH',
    headers: { ...adminHeaders(), Prefer: 'return=minimal' },
    body:    JSON.stringify({ owner_id: userId, business_id: businessId }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`ledger backfill failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

// Send the magic-link email via the PUBLIC anon endpoint. This is what
// actually triggers Supabase SMTP to email the user — admin/generate_link
// only returns a URL, it doesn't send mail. `create_user: false` because
// findOrCreateUser has already ensured the account exists.
async function sendMagicLink(email, redirectTo) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, create_user: false, redirect_to: redirectTo }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`magic-link send failed: ${t.slice(0, 200)}`);
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
      business_name,
      business_type,
      atmospheres,
      place,
      hours,
      longestMinutes,
      playlists,
    } = req.body || {};

    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'valid email required' });
    }

    const name = String(business_name || '').trim().slice(0, 80);
    const { user, existing } = await findOrCreateUser(cleanEmail);
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
      };
    }
    nextSonic.currentBizId = businessId;

    const bMap = { ...(nextSonic.b || {}) };
    const bRow = { ...(bMap[businessId] || {}) };
    if (Array.isArray(playlists) && playlists.length) {
      const prior = Array.isArray(bRow.playlists) ? bRow.playlists : [];
      bRow.playlists = [...playlists, ...prior].slice(0, 20);
    }
    // Opening hours from the onboarding hours picker. Overwrite whatever
    // the user had before — this is the freshest signal about how their
    // week actually runs.
    if (hours && typeof hours === 'object') {
      bRow.hours = hours;
      if (Number.isFinite(longestMinutes) && longestMinutes > 0) {
        bRow.longestMinutes = Math.round(longestMinutes);
      }
    }
    // Google Places metadata (structured biz-type, editorial summary,
    // price level, vibe booleans, website_uri). Stored per-business so it
    // survives to the dashboard and can be extended later. Only written
    // when the user confirmed the match in step 1.
    if (place && typeof place === 'object') {
      bRow.place = place;
    }
    bMap[businessId] = bRow;
    nextSonic.b = bMap;

    try { await writeUserSonicMeta(user.id, nextSonic); }
    catch (e) { console.warn('[signup] user_metadata write failed:', e.message); }

    // Back-fill owner_id + business_id on the ledger rows that /api/v5/
    // record-playlist wrote during onboarding (before the account existed).
    // Filter on `owner_id=is.null` so we never overwrite a legitimate owner
    // in the edge case that this endpoint is hit with someone else's spotify
    // ids in the body.
    if (Array.isArray(playlists) && playlists.length) {
      const ids = playlists.map((p) => p?.id).filter(Boolean);
      if (ids.length) {
        try { await backfillLedgerOwnership(ids, user.id, businessId); }
        catch (e) { console.warn('[signup] ledger backfill failed:', e.message); }
      }
    }

    // Send the magic-link email. Business + playlists are already persisted
    // above, so by the time the user clicks the link their dashboard is
    // ready to render everything. Redirect target follows the request
    // origin so localhost/preview/prod all Just Work — as long as the host
    // is on Supabase's Redirect URLs allow-list.
    const redirectTo = accountRedirectUrl(req);
    try { await sendMagicLink(cleanEmail, redirectTo); }
    catch (e) {
      console.error('[signup] magic-link send failed:', e.message);
      return res.status(502).json({ error: 'לא הצלחנו לשלוח את קישור הכניסה. נסו שוב עוד רגע.' });
    }

    console.log(`[signup:v6] ${existing ? 'existing' : 'new'} ${cleanEmail} → biz ${businessId} (${Array.isArray(playlists) ? playlists.length : 0} playlists) — magic link sent`);
    return res.status(200).json({
      ok: true,
      existing_user: existing,
      business_id:   businessId,
      emailed:       true,
      email:         cleanEmail,
    });
  } catch (err) {
    console.error('[signup:v6] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
