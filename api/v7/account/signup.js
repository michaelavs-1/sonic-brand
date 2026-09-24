/* /api/v7/account/signup.js
   v7 onboarding → account bridge (passwordless), fired AFTER the payment step.

   Email verification is REQUIRED (same as v6, decided 2026-09-24): this
   endpoint never logs anyone in. It creates/updates the account and emails a
   one-time magic link; clicking it is the verification step and lands the
   owner on /v7/account. The client shows "בדקו את המייל ✉️".

   v7 differs from v6 signup in three ways:
     1. It is called only after the (placeholder) payment step, once the
        taste profile has resolved — "no non-paying clients", so no account
        exists for anyone who abandons before paying.
     2. It writes NO business_directions. v7 dissolves the swiped directions
        into a flat taste profile, which is sent IN this request and saved
        here (business_taste_profiles) BEFORE the email goes out — so an owner
        who clicks the link immediately lands on a complete account.
     3. Returning owners are found via the admin user list's email filter, NOT
        admin generate_link. generate_link counts as a login-link send, and
        Supabase allows one per user per ~60s — calling it first made the
        real email fail (that's why v7's email never arrived before
        2026-09-24).

   The businesses row is stamped version='v7' (the v7 cron targets it) and
   paid_at=now() (placeholder payment-completion marker — no real payment
   integration yet).

   Request body: {
     email,
     tasteProfile,                       // generateTasteProfile() result — REQUIRED
     genreTally?: [{ genre, like, dislike }],
     name?, description?, musicalEmphases?,
     atmospheres?, place?,
     hours?, longestMinutes?,
     superLikedTracks?: [spotify_id],
     onboardingSessionId?,
     skipEmail?,                         // test scripts only — honored ONLY with
                                         // a valid x-sonic-internal header
   }
   Response: { ok: true, existing_user, business_id, emailed, email }
             | { error }   (429 with a friendly message when Supabase's
                             per-user email interval hasn't passed yet)

   Idempotent: the "resend" button on the check-email screen re-posts the same
   payload (upserts + a fresh email).
*/

import { timingSafeEqual } from 'node:crypto';
import { pgrUpsert, pgrPatch } from '../../v5/supabase-client.js';
import { requireSite, isAllowedHost, setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { tasteProfileRow, isUsableTasteProfile } from './_taste-profile.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DEFAULT_CREDITS = 30;

function accountRedirectUrl(req) {
  if (process.env.V7_ACCOUNT_REDIRECT_URL) return process.env.V7_ACCOUNT_REDIRECT_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (!isAllowedHost(host)) {
    throw new Error(`signup redirect blocked: host "${host}" not in allowlist`);
  }
  const hostOnly = host.split(':')[0];
  const proto = (hostOnly === 'localhost' || hostOnly === '127.0.0.1') ? 'http' : 'https';
  return `${proto}://${host}/v7/account`;
}

function adminHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Look up an existing auth user by email via the admin user list's `filter`
// (a substring match — so exact-match the result). Deliberately NOT admin
// generate_link: that counts as a login-link send and would trip Supabase's
// per-user email interval, making the real magic-link email below fail.
// Returns { id, ... } or null.
async function findUserByEmail(email) {
  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`,
    { headers: adminHeaders() },
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  const list = Array.isArray(data?.users) ? data.users : [];
  return list.find((u) => String(u.email || '').toLowerCase() === email) || null;
}

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

// Ensure a businesses row exists for the owner, stamped version='v7' +
// paid_at. Returns the business id. Reuses the owner's first existing
// business if any (updating name/desc/emphases + flipping it to v7); creates
// a fresh one otherwise. paid_at is only set on the v7 write path — never
// cleared — so re-onboarding never un-marks a paid business.
async function ensureBusinessV7(ownerId, name, credits, promptInputs = {}) {
  const nowIso = new Date().toISOString();
  const q = `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${ownerId}&select=id,name,paid_at`;
  const existingRes = await fetch(q, { headers: adminHeaders() });
  const rows = await existingRes.json().catch(() => []);
  if (!existingRes.ok) throw new Error('businesses lookup failed');

  if (Array.isArray(rows) && rows.length) {
    const match = rows[0];
    const patch = {
      monthly_credits:  credits,
      credits_remaining: credits,
      version:           'v7',
    };
    if (name) patch.name = name;
    if (promptInputs.description)     patch.business_description = promptInputs.description;
    if (promptInputs.musicalEmphases) patch.musical_emphases     = promptInputs.musicalEmphases;
    if (!match.paid_at) patch.paid_at = nowIso;   // don't overwrite an earlier payment
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
      owner_id:             ownerId,
      name:                 name || '',
      monthly_credits:      credits,
      credits_remaining:    credits,
      version:              'v7',
      paid_at:              nowIso,
      business_description: promptInputs.description     || null,
      musical_emphases:     promptInputs.musicalEmphases || null,
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

async function readUserSonicMeta(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: adminHeaders() });
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

// Send the magic-link email via the PUBLIC anon endpoint — this is what makes
// Supabase SMTP actually email the owner (admin generate_link only returns a
// URL). create_user:false because findOrCreateUser already ensured the account.
// FATAL (like v6): without this email the owner has no way into the account.
// Supabase allows one login email per user per ~60s; a too-soon repeat comes
// back 429 and is surfaced as err.rateLimited.
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
    const err = new Error(`magic-link send failed: ${r.status} ${t.slice(0, 200)}`);
    err.rateLimited = r.status === 429 || /over_email_send_rate_limit|security purposes/i.test(t);
    throw err;
  }
}

// Test scripts (scripts/_v7-walkthrough.mjs, _v7-phaseb-walkthrough.mjs) sign
// up with @example.invalid addresses — real sends would bounce and hurt the
// sender reputation. They may skip the email, but ONLY when they present the
// server's INTERNAL_API_KEY; the public can't turn verification off.
function isInternalCaller(req) {
  const expected = process.env.INTERNAL_API_KEY || '';
  const got = String(req.headers['x-sonic-internal'] || '');
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'signup', 20, 3600)) return;

  try {
    if (!SERVICE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    }

    const {
      email,
      name,
      description,
      musicalEmphases,
      atmospheres,
      place,
      hours,
      longestMinutes,
      superLikedTracks,
      onboardingSessionId,
      tasteProfile,
      genreTally,
      skipEmail,
    } = req.body || {};

    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    // The taste profile is what every v7 daily build reads — an account
    // without one can't get playlists, so refuse rather than create it.
    if (!isUsableTasteProfile(tasteProfile)) {
      return res.status(400).json({ error: 'tasteProfile required' });
    }

    const bizName = String(name || '').trim().slice(0, 80);
    const desc     = String(description     || '').trim().slice(0, 4000);
    const emphases = String(musicalEmphases || '').trim().slice(0, 2000);

    const { user, existing } = await findOrCreateUser(cleanEmail);
    const businessId = await ensureBusinessV7(user.id, bizName, DEFAULT_CREDITS, {
      description:     desc || null,
      musicalEmphases: emphases || null,
    });

    // user_metadata: only small identity flags (dashboard reads currentBizId
    // on load; onboarding.* is a one-time first-flow snapshot). Everything
    // operational lives in Postgres.
    const currentSonic = await readUserSonicMeta(user.id);
    const nextSonic = { ...currentSonic, currentBizId: businessId };
    if (!existing) {
      nextSonic.onboarding = { bizType: null, atmospheres: atmospheres || [] };
    }
    if (nextSonic.b) delete nextSonic.b;
    try { await writeUserSonicMeta(user.id, nextSonic); }
    catch (e) { console.warn('[signup:v7] user_metadata write failed:', e.message); }

    // Taste profile — saved BEFORE the email goes out, so the owner's first
    // click on the magic link lands on an account that can already build.
    // Fatal: without it the account is useless (and a retry is idempotent).
    await pgrUpsert('business_taste_profiles',
      tasteProfileRow(businessId, tasteProfile, genreTally),
      { onConflict: 'business_id' });

    // Gemini spend back-fill — the onboarding Gemini calls (v7-onboarding,
    // v7-onboarding-refined, v7-taste-profile) were logged with
    // onboarding_session_id set and business_id null. Signup now runs after
    // the taste-profile call has resolved, so one backfill attaches them all.
    if (typeof onboardingSessionId === 'string' && onboardingSessionId.length) {
      try {
        await pgrPatch('gemini_call_log',
          { onboarding_session_id: `eq.${onboardingSessionId}` },
          { business_id: businessId, onboarding_session_id: null },
        );
      } catch (e) {
        console.warn('[signup:v7] gemini spend backfill failed:', e.message);
      }
    }

    // business_hours + business_place — same as v6 (Phase B playlist lengths
    // derive from opening hours, so hours are required).
    try {
      if (hours && typeof hours === 'object') {
        await pgrUpsert('business_hours', {
          business_id:     businessId,
          hours,
          longest_minutes: Number.isFinite(longestMinutes) && longestMinutes > 0
            ? Math.round(longestMinutes) : null,
          updated_at:      new Date().toISOString(),
        }, { onConflict: 'business_id' });
      }
      if (place && typeof place === 'object') {
        await pgrUpsert('business_place', {
          business_id:       businessId,
          place_id:          place.place_id       || null,
          name:              place.name           || null,
          address:           place.address        || null,
          primary_type:      place.primary_type   || null,
          types:             Array.isArray(place.types) ? place.types : null,
          editorial_summary: place.editorial_summary || null,
          price_level:       place.price_level    || null,
          website_uri:       place.website_uri    || null,
          vibe:              place.vibe           || null,
          updated_at:        new Date().toISOString(),
        }, { onConflict: 'business_id' });
      }
    } catch (e) {
      console.warn('[signup:v7] hours/place upsert failed:', e.message);
    }

    // super_liked_tracks — Spotify IDs the owner super-liked during the swipe
    // deck. Same upsert-on-composite-key + resurrect-soft-deleted pattern as
    // v6. Best-effort; nothing blocks signup on this.
    if (Array.isArray(superLikedTracks) && superLikedTracks.length) {
      const uniqueIds = [...new Set(superLikedTracks.filter((s) => typeof s === 'string' && s.length))];
      if (uniqueIds.length) {
        try {
          await pgrUpsert('super_liked_tracks',
            uniqueIds.map((spotify_id) => ({ business_id: businessId, spotify_id, deleted_at: null })),
            { onConflict: 'business_id,spotify_id' },
          );
        } catch (e) {
          console.warn('[signup:v7] super_liked_tracks upsert failed:', e.message);
        }
      }
    }

    // The verification email — the ONLY way into the account (no session is
    // ever returned). Last step, after everything above is saved.
    let emailed = false;
    if (skipEmail === true && isInternalCaller(req)) {
      console.log(`[signup:v7] email skipped for internal test caller (${cleanEmail})`);
    } else {
      try {
        await sendMagicLink(cleanEmail, accountRedirectUrl(req));
        emailed = true;
      } catch (e) {
        console.error('[signup:v7] magic-link send failed:', e.message);
        if (e.rateLimited) {
          return res.status(429).json({ error: 'שלחנו קישור לפני רגע — אפשר לבקש שוב בעוד דקה.' });
        }
        return res.status(502).json({ error: 'לא הצלחנו לשלוח את קישור הכניסה. נסו שוב עוד רגע.' });
      }
    }

    console.log(`[signup:v7] ${existing ? 'existing' : 'new'} ${cleanEmail} → biz ${businessId} (profile saved, emailed=${emailed})`);
    return res.status(200).json({
      ok:            true,
      existing_user: existing,
      business_id:   businessId,
      emailed,
      email:         cleanEmail,
    });
  } catch (err) {
    console.error('[signup:v7] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
