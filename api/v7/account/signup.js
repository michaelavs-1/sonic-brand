/* /api/v7/account/signup.js
   v7 onboarding → account bridge, fired AFTER the payment step.

   Email verification is REQUIRED (same as v6, decided 2026-09-24): this
   endpoint never logs anyone in. It creates/updates the account and emails a
   one-time magic link; clicking it is the verification step and lands the
   owner on /v7/account, logged in. The client shows "בדקו את המייל ✉️".

   Passwords (2026-09-28): the owner picks one at registration and it is set
   here. A password only ever lands on an UNVERIFIED account, so it can't be
   used until the inbox owner clicks the link:
     - no account              → create it (unverified) with the password
     - unverified, no business → set its password (an earlier attempt that
                                 failed before creating the business)
     - unverified + business   → only a RESEND of this signup: the request must
                                 carry `resendFor` = the business id the first
                                 call returned. Anything else → 409.
     - verified + business     → 409 'already_registered'. A verified account's
                                 password is never touched.
     - verified, no business   → a leftover login with nothing behind it: delete
                                 it and create a fresh unverified one
   The registration screen (check-email.js) stops a registered email before
   payment; the 409s are the server-side backstop.

   v7 differs from v6 signup in three ways:
     1. It is called only after the Hyp payment step, once the taste profile
        has resolved — "no non-paying clients", so no account exists for
        anyone who abandons before paying. It REQUIRES a paid
        payment_checkouts row (checkoutId) and links it to the business.
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
   paid_at = the checkout's paid_at.

   Request body: {
     email,
     password,                           // REQUIRED (internal test callers may omit it)
     resendFor?,                         // business_id from the first call — set by
                                         // the "שלחו שוב" / retry paths
     checkoutId,                         // paid payment_checkouts id — REQUIRED while
                                         // PAYMENTS_ENABLED (internal test callers
                                         // may omit it); ignored-if-absent while off
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
             | { error, code?, business_id? }
               (429 with a friendly message when Supabase's per-user email
                interval hasn't passed yet; 409 code 'already_registered';
                400 code 'bad_password' when it breaks shared/password-rules.js,
                'weak_password' when Supabase refuses it (leaked);
                400 code 'bad_hours' when the hours break shared/opening-hours.js.
                business_id is included once the business exists, so the
                client's retry can pass it as resendFor.)

   Idempotent: the "resend" button on the check-email screen re-posts the same
   payload + resendFor (upserts + a fresh email).
*/

import { timingSafeEqual } from 'node:crypto';
import { pgrSelect, pgrUpsert, pgrPatch } from '../../v5/supabase-client.js';
import { requireSite, isAllowedHost, setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { tasteProfileRow, isUsableTasteProfile } from './_taste-profile.js';
import { PAYMENTS_ENABLED } from '../payment/_hyp.js';
import {
  adminHeaders, findUserByEmail, businessIdsOf, isVerified,
  createUser, setPassword, deleteUser,
} from './_auth-users.js';
import { passwordProblem } from '../../../shared/password-rules.js';
import { hoursProblem } from '../../../shared/opening-hours.js';

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

// Find or create the owner's auth user and apply the password (rules in the
// header). Returns { user, existing } or { conflict: true } for an email that
// is already registered.
async function prepareUser(email, password, resendFor) {
  // Two passes: the second covers a concurrent signup for the same email
  // creating the user between our lookup and our create.
  for (let pass = 0; pass < 2; pass++) {
    const found = await findUserByEmail(email);
    if (found) {
      const bizIds = await businessIdsOf(found.id);
      if (isVerified(found)) {
        if (bizIds.length) return { conflict: true };
        // Verified but empty (e.g. left over from the old login page, which
        // created an account for any email typed into it). Recreate it
        // unverified so the new password only works once the inbox owner
        // clicks the link.
        await deleteUser(found.id);
      } else {
        if (bizIds.length && !bizIds.includes(resendFor)) return { conflict: true };
        if (password) await setPassword(found.id, password);
        return { user: found, existing: true };
      }
    }
    const created = await createUser(email, password);
    if (created) return { user: created, existing: false };
  }
  throw new Error('could not create or find user');
}

// Ensure a businesses row exists for the owner, stamped version='v7' +
// paid_at. Returns the business id. Reuses the owner's first existing
// business if any (updating name/desc/emphases + flipping it to v7); creates
// a fresh one otherwise. paid_at is only set on the v7 write path — never
// cleared — so re-onboarding never un-marks a paid business.
async function ensureBusinessV7(ownerId, name, credits, promptInputs = {}, paidAtIso) {
  const paidAt = paidAtIso || new Date().toISOString();
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
    if (!match.paid_at) patch.paid_at = paidAt;   // don't overwrite an earlier payment
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
      paid_at:              paidAt,
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
// URL). create_user:false because prepareUser already ensured the account.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Hyp payment that entitles this signup (see api/v7/payment/). It must be
// paid; the first signup claims it (business_id), and after that only the
// same email may reuse it — the check-email screen's resend re-posts it.
async function loadPaidCheckout(checkoutId, email) {
  const noPayment = { status: 402, error: 'לא מצאנו תשלום עבור ההרשמה הזו.' };
  if (!UUID_RE.test(String(checkoutId || ''))) return noPayment;
  const rows = await pgrSelect('payment_checkouts', { id: `eq.${checkoutId}` },
    { select: 'id,status,email,business_id,paid_at', limit: 1, useService: true });
  const checkout = Array.isArray(rows) ? rows[0] : null;
  if (!checkout || checkout.status !== 'paid') return noPayment;
  if (checkout.business_id && checkout.email !== email) {
    return { status: 409, error: 'התשלום הזה כבר שימש להרשמה אחרת.' };
  }
  return { checkout };
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'signup', 20, 3600)) return;

  let businessId = null;   // echoed on errors once known — the client's retry sends it back as resendFor
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
      checkoutId,
      password,
      resendFor,
    } = req.body || {};

    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    // Opening hours — the hours step already refuses invalid ones
    // (shared/opening-hours.js); this catches stale pages / crafted requests
    // before anything is created, so a paid checkout stays unclaimed.
    const hoursErr = hours && typeof hours === 'object' ? hoursProblem(hours) : null;
    if (hoursErr) return res.status(400).json({ error: hoursErr, code: 'bad_hours' });
    // Password — chosen on the registration screen. Internal test callers
    // (walkthrough scripts) may omit it; they mint their own session.
    if (password != null || !isInternalCaller(req)) {
      const pwErr = passwordProblem(password);
      if (pwErr) return res.status(400).json({ error: pwErr, code: 'bad_password' });
    }
    // The taste profile is what every v7 daily build reads — an account
    // without one can't get playlists, so refuse rather than create it.
    if (!isUsableTasteProfile(tasteProfile)) {
      return res.status(400).json({ error: 'tasteProfile required' });
    }

    // No payment, no account — while real payments are on (PAYMENTS_ENABLED
    // in api/v7/payment/_hyp.js). The walkthrough test scripts (internal key)
    // may sign up without one. While payments are off (placeholder screen),
    // nothing is required and paid_at is the signup time; a paid checkout
    // that's passed anyway is still claimed.
    let checkout = null;
    if (checkoutId || (PAYMENTS_ENABLED && !isInternalCaller(req))) {
      const paid = await loadPaidCheckout(checkoutId, cleanEmail);
      if (paid.checkout) checkout = paid.checkout;
      else if (PAYMENTS_ENABLED) return res.status(paid.status).json({ error: paid.error });
    }

    const bizName = String(name || '').trim().slice(0, 80);
    const desc     = String(description     || '').trim().slice(0, 4000);
    const emphases = String(musicalEmphases || '').trim().slice(0, 2000);

    const prepared = await prepareUser(cleanEmail, typeof password === 'string' ? password : null,
      String(resendFor || ''));
    if (prepared.conflict) {
      return res.status(409).json({
        error: 'לאימייל הזה כבר יש חשבון — היכנסו עם הסיסמה שלכם.',
        code:  'already_registered',
      });
    }
    const { user, existing } = prepared;
    businessId = await ensureBusinessV7(user.id, bizName, DEFAULT_CREDITS, {
      description:     desc || null,
      musicalEmphases: emphases || null,
    }, checkout?.paid_at);

    // Claim the payment for this business. Fatal: an unclaimed paid checkout
    // could be reused (the retry is idempotent).
    if (checkout && checkout.business_id !== businessId) {
      await pgrPatch('payment_checkouts', { id: `eq.${checkout.id}` },
        { business_id: businessId, email: cleanEmail, updated_at: new Date().toISOString() });
    }

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
          return res.status(429).json({ error: 'שלחנו קישור לפני רגע — אפשר לבקש שוב בעוד דקה.', business_id: businessId });
        }
        return res.status(502).json({ error: 'לא הצלחנו לשלוח את קישור הכניסה. נסו שוב עוד רגע.', business_id: businessId });
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
    return res.status(err.status || 500).json({
      error:       err.message || 'Server error',
      code:        err.code,
      business_id: businessId,
    });
  }
}
