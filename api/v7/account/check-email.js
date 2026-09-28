/* /api/v7/account/check-email.js
   Registration-screen check: is this email already registered? Lets the v7
   onboarding stop an existing owner BEFORE the payment step, with a link to
   log in instead.

   Registered = an auth user that owns a business (see _auth-users.js). A
   login with no business behind it is not registered — signup replaces it.
   signup.js enforces the same rule server-side (409).

   This tells anyone who types an email whether it has an account (as most
   sign-up forms do), so it is rate-limited per IP.

   POST { email } → { registered: boolean }
*/

import { requireSite, setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { findUserByEmail, businessIdsOf } from './_auth-users.js';

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'v7-check-email', 20, 600)) return;

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }

  try {
    const user = await findUserByEmail(email);
    const registered = !!user && (await businessIdsOf(user.id)).length > 0;
    return res.status(200).json({ registered });
  } catch (err) {
    console.error('[check-email:v7] failed:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
