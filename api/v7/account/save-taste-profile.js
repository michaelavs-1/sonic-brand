/* /api/v7/account/save-taste-profile.js
   Persist the flat v7 taste profile produced by generateTasteProfile().

   NOT used by onboarding since 2026-09-24: v7 signup now requires email
   verification (no instant in-tab session), so signup.js persists the profile
   itself before the magic link goes out. This endpoint stays as the
   owner-authenticated way to (re)write a profile later. Writes ONE row to
   business_taste_profiles (owner-scoped, upsert on business_id) — the flat
   116-genre bucketing + per-user energy scale + carry-through prefs + the
   per-genre like/dislike audit tally (analytics only).

   Also re-runs the gemini_call_log backfill for the given onboarding session:
   the v7-taste-profile call is often still in-flight when signup runs its
   backfill, so its log row can land with onboarding_session_id set +
   business_id null. Re-running the same UPDATE here (idempotent) attributes
   that row to the business.

   Auth: owner JWT (Authorization: Bearer <access_token>) + requireBusinessOwner.

   Request body: { business_id, profile, genreTally?, onboardingSessionId? }
     profile = { energy_levels_total, approved_genres, conditional_genres,
                 excluded_genres, instrumentalness_preference,
                 popularity_preference, reasoning_en }
     genreTally = [{ genre, like, dislike }]
   Response: { ok: true } | { error }
*/

import { pgrUpsert, pgrPatch } from '../../v5/supabase-client.js';
import { tasteProfileRow } from './_taste-profile.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

async function verifyUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'save-taste-profile', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { business_id, profile, genreTally, onboardingSessionId } = req.body || {};
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: 'profile required' });
    }
    try { await requireBusinessOwner(business_id, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const row = tasteProfileRow(business_id, profile, genreTally);

    await pgrUpsert('business_taste_profiles', row, { onConflict: 'business_id' });

    // Re-run the onboarding gemini backfill to catch the v7-taste-profile
    // log row, which may have landed after signup's backfill. Idempotent:
    // once attributed, no rows match the WHERE clause. Best-effort.
    if (typeof onboardingSessionId === 'string' && onboardingSessionId.length) {
      try {
        await pgrPatch('gemini_call_log',
          { onboarding_session_id: `eq.${onboardingSessionId}` },
          { business_id, onboarding_session_id: null },
        );
      } catch (e) {
        console.warn('[save-taste-profile] gemini backfill failed:', e.message);
      }
    }

    console.log(`[save-taste-profile] biz ${business_id} — profile persisted (N=${row.energy_levels_total})`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[save-taste-profile] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
