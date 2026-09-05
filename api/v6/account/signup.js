/* /api/v6/account/signup.js
   Onboarding → personal-area bridge (passwordless).

   Called by v6's onboarding after playlists finish building. Creates (or
   finds) a Supabase auth user for the given email, ensures a `businesses`
   row exists for them, writes the just-built playlists + hours + Google
   Places metadata to the per-business tables (business_playlists,
   business_hours, business_place), and emails a one-time magic link so
   the user can enter the account area by clicking through from their
   inbox.

   user_metadata.sonic stays tiny: only { currentBizId, onboarding: {
   bizType, atmospheres } }. All the growing operational data lives in
   Postgres — see v5/precompute/migrations/2026-08-05-per-business-
   tables.sql. Keeping the JWT small is a hard requirement (previous 431
   header-overflow errors were the reason we moved).

   No passwords anywhere: `admin.createUser` is called without a password
   and with `email_confirm: false`; the click on the magic-link email is
   the verification step. Existing users get the same treatment — a fresh
   magic link is emailed and their business row / tables are updated in
   place so their new onboarding session is attached to the account when
   they follow the link.

   Request body: {
     email,
     business_name?, business_type?, atmospheres?, place?,
     hours?, longestMinutes?,   // from the onboarding hours picker
     playlists?: [ { ico, label, url, id, trackCount, genres, createdAt, expansion? } ]
                  // `expansion` = { direction } — carried through verbatim
                  //  so the dashboard's expand-playlist endpoint can grow
                  //  the playlist without re-running the directions flow.
                  //  Pre-2026-09-02 `popularityWindow` may be present in
                  //  legacy payloads; it's read (below) but not persisted.
   }
   Response: { ok: true, existing_user, business_id, emailed: true, email }
*/

import { pgrSelect, pgrUpsert, pgrInsert, pgrPatch } from '../../v5/supabase-client.js';
import { requireSite, isAllowedHost, setCors } from '../origin-guard.js';
import { guard } from '../ratelimit.js';

// Fingerprint helper — a direction is uniquely identified by (title +
// normalized-sorted genre set). Same key logic used by _daily-builder.js
// and the migration script; keep them consistent.
function directionFingerprint(d) {
  if (!d) return '';
  const genres = Array.isArray(d.genres) && d.genres.length
    ? d.genres
    : [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])].filter(Boolean);
  const gk = genres.map((g) => String(g).toLowerCase()).sort().join('|');
  return (d.title_en || '').toLowerCase() + '|' + gk;
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// v6 has no subscription tiers — everyone gets the same starter credit pool.
const DEFAULT_CREDITS = 30;

// Derive the magic-link redirect target from the incoming request so this
// endpoint works unchanged from `vercel dev` (localhost), preview URLs,
// custom-domain prod (robin-music.com), and Vercel-alias prod
// (sonic-brand.vercel.app) — each redirects back to where the user came from.
// SECURITY: the derived host is validated against isAllowedHost(), so a
// spoofed `x-forwarded-host: attacker.com` cannot coerce the magic link
// to embed an attacker-controlled URL. V6_ACCOUNT_REDIRECT_URL env var
// overrides derivation entirely when you need to pin one target.
// (Whatever URL results still has to be on Supabase's Redirect URLs
// allow-list — Auth → URL Configuration — or Supabase silently
// substitutes its Site URL.)
function accountRedirectUrl(req) {
  if (process.env.V6_ACCOUNT_REDIRECT_URL) return process.env.V6_ACCOUNT_REDIRECT_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (!isAllowedHost(host)) {
    throw new Error(`signup redirect blocked: host "${host}" not in allowlist`);
  }
  const hostOnly = host.split(':')[0];
  const proto = (hostOnly === 'localhost' || hostOnly === '127.0.0.1') ? 'http' : 'https';
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
//
// `promptInputs = { description, musicalEmphases }` capture the free-text
// onboarding prompt so the internal dashboard can reconstruct what each
// owner typed. null values are skipped on the PATCH path (repeat-onboarding
// with a blank field should NOT wipe a previously-recorded prompt); the
// INSERT path writes them verbatim (nulls included).
async function ensureBusiness(ownerId, name, credits, promptInputs = {}) {
  const q = `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${ownerId}&select=id,name`;
  const existingRes = await fetch(q, { headers: adminHeaders() });
  const rows = await existingRes.json().catch(() => []);
  if (!existingRes.ok) throw new Error('businesses lookup failed');

  if (Array.isArray(rows) && rows.length) {
    const match = rows[0];
    const patch = { monthly_credits: credits, credits_remaining: credits };
    if (name) patch.name = name;
    if (promptInputs.description)     patch.business_description = promptInputs.description;
    if (promptInputs.musicalEmphases) patch.musical_emphases     = promptInputs.musicalEmphases;
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
      business_name,
      business_type,
      business_description,
      musical_emphases,
      atmospheres,
      place,
      hours,
      longestMinutes,
      playlists,
      superLikedTracks,
      onboarding_session_id,
    } = req.body || {};

    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'valid email required' });
    }

    const name = String(business_name || '').trim().slice(0, 80);
    // Trim + upper-bound the two free-text prompt inputs so a malicious /
    // pasted-in payload can't stuff arbitrary blobs into a text column.
    // Emphases has an implicit 500-char client cap (see v6/emphases.js);
    // description has no client cap, but 4000 covers a normal owner's
    // dictation with plenty of headroom.
    const desc     = String(business_description || '').trim().slice(0, 4000);
    const emphases = String(musical_emphases     || '').trim().slice(0, 2000);
    const { user, existing } = await findOrCreateUser(cleanEmail);
    const businessId = await ensureBusiness(user.id, name, DEFAULT_CREDITS, {
      description:     desc || null,
      musicalEmphases: emphases || null,
    });

    // 1) user_metadata gets ONLY the small identity flags. currentBizId
    //    is needed by the account dashboard on load; onboarding.* is a
    //    one-time snapshot of what the user typed for their first flow.
    //    Everything else lives in per-business tables — see the
    //    2026-08-05 migration.
    const currentSonic = await readUserSonicMeta(user.id);
    const nextSonic = { ...currentSonic, currentBizId: businessId };
    if (!existing) {
      nextSonic.onboarding = {
        bizType:     business_type || null,
        atmospheres: atmospheres   || [],
      };
    }
    // Strip any legacy b[businessId].* metadata this user may still be
    // carrying from before the tables migration — leaves the JWT small
    // even for accounts that haven't been through the migration script yet.
    if (nextSonic.b) delete nextSonic.b;
    try { await writeUserSonicMeta(user.id, nextSonic); }
    catch (e) { console.warn('[signup] user_metadata write failed:', e.message); }

    // 2) Ledger back-fill FIRST — the created_playlists rows were written
    //    by /api/v5/record-playlist during onboarding without owner/biz
    //    linkage. We attach them here so the expiry cron can find them by
    //    biz + we can look up their canonical expires_at for step 3 in
    //    the same round-trip.
    const spotifyIds = Array.isArray(playlists)
      ? playlists.map((p) => p?.id).filter(Boolean)
      : [];
    if (spotifyIds.length) {
      try { await backfillLedgerOwnership(spotifyIds, user.id, businessId); }
      catch (e) { console.warn('[signup] ledger backfill failed:', e.message); }
    }

    // 2b) Gemini spend back-fill — the onboarding Gemini calls (musical
    //     directions × 2) were logged with `onboarding_session_id` set
    //     and `business_id` null. Attach them to the newly-created
    //     business now so per-business rollups in the internal admin API
    //     include pre-signup spend. Clear the session id afterwards so
    //     the "abandoned onboarding" query stays clean.
    if (typeof onboarding_session_id === 'string' && onboarding_session_id.length) {
      try {
        await pgrPatch('gemini_call_log',
          { onboarding_session_id: `eq.${onboarding_session_id}` },
          { business_id: businessId, onboarding_session_id: null },
        );
      } catch (e) {
        console.warn('[signup] gemini spend backfill failed:', e.message);
      }
    }

    // 3) business_hours + business_place — one row each per business.
    //    Upsert so re-signup / repeat-onboarding overwrites in place
    //    without dup-key errors.
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
      console.warn('[signup] hours/place upsert failed:', e.message);
    }

    // 4) business_directions — insert one row per unique picked
    //    direction, capture the returned ids in a fingerprint → id map,
    //    then use it below to tag each business_playlists row with the
    //    right direction_id. Only picked directions are saved (matches
    //    the client's swipe-deck output); a future dashboard can add
    //    fresh directions from scratch.
    const directionIdByFp = {};
    if (Array.isArray(playlists) && playlists.length) {
      const uniqueByFp = new Map();
      for (const p of playlists) {
        const d = p?.expansion?.direction;
        if (!d) continue;
        const fp = directionFingerprint(d);
        if (uniqueByFp.has(fp)) continue;
        const genres = Array.isArray(d.genres) && d.genres.length
          ? d.genres
          : [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])].filter(Boolean);
        // instrumentalness_preference: normalize to the CHECK-constrained
        // enum on business_directions. Anything unrecognized falls back to
        // 'none' so the insert never fails on a bad value from the client.
        const rawInst = d.instrumentalness_preference;
        const instPref = (rawInst === 'hard' || rawInst === 'soft') ? rawInst : 'none';
        // popularity_preference (added 2026-09-02): same shape. DB column
        // has CHECK ('none','soft','hard') + default 'none'; 'none' is a
        // no-op so this stays valid even before the migration runs.
        const rawPop  = d.popularity_preference;
        const popPref  = (rawPop  === 'hard' || rawPop  === 'soft') ? rawPop  : 'none';
        uniqueByFp.set(fp, {
          business_id:                 businessId,
          rank:                        Number.isFinite(d.rank) ? d.rank : null,
          title_en:                    d.title_en || null,
          description_he:              d.description_he || null,
          genres,
          bpm_range:                   d.bpm_range || null,
          // popularity_window column left NULL for new rows since 2026-09-02
          // (atmosphere-derived window removed). Popularity is now controlled
          // per-direction via popularity_preference alone.
          instrumentalness_preference: instPref,
          popularity_preference:       popPref,
          active:                      true,
        });
      }
      if (uniqueByFp.size) {
        try {
          // Cap at the 8-active-per-business ceiling enforced by the
          // enforce_active_directions_cap trigger. Swipe-deck clients only
          // ever produce ≤8, so this is a no-op for legit signups; the cap
          // guards against a crafted payload that would otherwise abort
          // the entire signup transaction on the 9th INSERT.
          const capped = [...uniqueByFp.entries()].slice(0, 8);
          const fps    = capped.map(([fp]) => fp);
          const rows   = capped.map(([, row]) => row);
          const inserted = await pgrInsert('business_directions', rows, { returnRows: true });
          // PostgREST preserves insert order in the returned representation,
          // so a positional zip is safe.
          (inserted || []).forEach((row, i) => {
            if (row?.id && fps[i]) directionIdByFp[fps[i]] = row.id;
          });
        } catch (e) {
          console.warn('[signup] business_directions insert failed:', e.message);
        }
      }
    }

    // 5) business_playlists — one row per onboarding sample playlist.
    //    Each row tagged with the source direction_id (from step 4) and
    //    its actual track_ids (from the client — see playlist-builder.js
    //    buildOne's `trackIds`). expires_at comes from the ledger
    //    (created_playlists) so both tables agree; if the ledger row
    //    wasn't found we fall back to "24h from now" as a defensive
    //    placeholder (expand-playlist recomputes expires_at as soon as
    //    the user hits the dashboard).
    if (Array.isArray(playlists) && playlists.length) {
      let ledgerExpiries = {};
      try {
        const rows = await pgrSelect('created_playlists', {
          spotify_id: `in.(${spotifyIds.join(',')})`,
        }, { select: 'spotify_id,expires_at' });
        ledgerExpiries = Object.fromEntries((rows || []).map((r) => [r.spotify_id, r.expires_at]));
      } catch (e) {
        console.warn('[signup] ledger expiry lookup failed:', e.message);
      }
      const fallbackExpiry = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const rows = playlists.map((p) => {
        const fp = p?.expansion?.direction ? directionFingerprint(p.expansion.direction) : null;
        return {
          spotify_id:   p.id,
          business_id:  businessId,
          url:          p.url,
          label:        p.label   || null,
          ico:          p.ico     || '🎵',
          track_count:  Number.isFinite(p.trackCount) ? p.trackCount : null,
          genres:       Array.isArray(p.genres) ? p.genres : null,
          bpm_range:    null,                         // onboarding playlists inherit bpm from the direction
          expansion:    p.expansion || null,          // kept during transition; expand-playlist falls back to this when direction_id is null
          event_id:     null,
          direction_id: fp ? (directionIdByFp[fp] || null) : null,
          track_ids:    Array.isArray(p.trackIds) ? p.trackIds : null,
          expanded_at:  null,                         // expand-playlist sets this on first dashboard visit
          expires_at:   ledgerExpiries[p.id] || fallbackExpiry,
          created_at:   p.createdAt ? `${p.createdAt}T00:00:00Z` : new Date().toISOString(),
        };
      }).filter((r) => r.spotify_id);
      if (rows.length) {
        try { await pgrUpsert('business_playlists', rows, { onConflict: 'spotify_id' }); }
        catch (e) { console.warn('[signup] business_playlists upsert failed:', e.message); }
      }
    }

    // 6) super_liked_tracks — Spotify IDs the user tapped during the
    //    preview swipe deck. Upsert on the composite unique key so
    //    re-signup on the same business no-ops on duplicates instead of
    //    409-ing the whole batch (pgrInsert's ignoreDuplicates option
    //    targets the PK and doesn't trigger for the (business_id,
    //    spotify_id) unique constraint — verified by scripts/test-super-
    //    liked-tracks.mjs). Silent-fail on error: nothing consumes these
    //    rows yet, so a botched insert shouldn't block signup itself.
    if (Array.isArray(superLikedTracks) && superLikedTracks.length) {
      const uniqueIds = [...new Set(
        superLikedTracks.filter((s) => typeof s === 'string' && s.length),
      )];
      if (uniqueIds.length) {
        try {
          // deleted_at:null resurrects any previously soft-deleted row so a
          // repeat onboarding under the same business restores the owner's
          // full super-like set (soft-delete pattern added 2026-09-05 — see
          // toggle-super-like.js).
          await pgrUpsert('super_liked_tracks',
            uniqueIds.map((spotify_id) => ({ business_id: businessId, spotify_id, deleted_at: null })),
            { onConflict: 'business_id,spotify_id' },
          );
        } catch (e) {
          console.warn('[signup] super_liked_tracks upsert failed:', e.message);
        }
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
