/* GET /api/internal/users
   The admin console's business list (v7 since 2026-10-13): one row per
   business with its owner and a summary of each area the detail view
   (business.js) covers.

   Auth: bearer token in `Authorization: Bearer <INTERNAL_ADMIN_API_KEY>` (see
   ./_guard.js). CORS: `*` — the bearer token IS the boundary.

   Response:
     { count, businesses: [{
         business_id, name, version, owner_id, owner_email, email_verified,
         last_sign_in_at, created_at,
         has_prompt,                 // description or emphases saved
         delivery_mode,              // 'option1' | 'option2' | null (type not picked yet)
         approved_genre_count,
         payment_status,             // 'paid' | 'no-payment' (signed up while payments were off)
         paid_at,                    // the first real payment, else null
         subscription_status,        // 'active' | 'cancelled' | 'ended' | null (no payment)
         last_daily_built_at,        // newest daily playlist
         opens_7d, opens_total,      // "▶ פתח" clicks
         last_opened_at,
         special_requests_total,
         taste_chat_messages,        // the owner's own messages
       }] }   newest business first
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { hasServiceKey, listAllAuthUsers, selectAll } from './_admin.js';
import { subscriptionStatus } from '../v7/account/_subscription.js';

const countBy = (rows, key = 'business_id') => {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + 1);
  return m;
};
const maxBy = (rows, field, key = 'business_id') => {
  const m = new Map();
  for (const r of rows) if (r[field] && (!m.has(r[key]) || r[field] > m.get(r[key]))) m.set(r[key], r[field]);
  return m;
};
const safe = (p) => p.catch((e) => { console.warn('[internal:users] read failed:', e.message.slice(0, 160)); return []; });

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
    const [businesses, users, settings, profiles, checkouts, dailyRows, opens, events, chats] = await Promise.all([
      pgrSelect('businesses', {}, { select: '*', order: 'created_at.desc', useService: true }),
      listAllAuthUsers(),
      safe(selectAll('business_v7_settings', {}, { select: 'business_id,delivery_mode', order: 'business_id.asc' })),
      safe(selectAll('business_taste_profiles', {}, { select: 'business_id,approved_genres', order: 'business_id.asc' })),
      safe(selectAll('payment_checkouts', { status: 'eq.paid', business_id: 'not.is.null' }, { select: 'id,business_id,paid_at', order: 'id.asc' })),
      safe(selectAll('business_playlists', { event_id: 'is.null' }, { select: 'spotify_id,business_id,created_at', order: 'spotify_id.asc' })),
      safe(selectAll('business_playlist_opens', {}, { select: 'id,business_id,opened_at', order: 'id.asc' })),
      safe(selectAll('business_events', {}, { select: 'id,business_id', order: 'id.asc' })),
      safe(selectAll('business_direction_chats', { role: 'eq.user' }, { select: 'id,business_id', order: 'id.asc' })),
    ]);

    const userById = new Map(users.filter((u) => u?.id).map((u) => [u.id, u]));
    const modeBy = new Map(settings.map((s) => [s.business_id, s.delivery_mode || null]));
    const approvedBy = new Map(profiles.map((p) => [p.business_id, Array.isArray(p.approved_genres) ? p.approved_genres.length : 0]));
    const firstPaidBy = new Map();
    for (const c of checkouts) if (c.paid_at && (!firstPaidBy.has(c.business_id) || c.paid_at < firstPaidBy.get(c.business_id))) firstPaidBy.set(c.business_id, c.paid_at);
    const lastBuiltBy = maxBy(dailyRows, 'created_at');
    const opensTotal = countBy(opens);
    const opens7 = countBy(opens.filter((o) => o.opened_at >= weekAgo));
    const lastOpenBy = maxBy(opens, 'opened_at');
    const eventsBy = countBy(events);
    const chatsBy = countBy(chats);

    const rows = (businesses || []).map((b) => {
      const u = userById.get(b.owner_id);
      const paidAt = firstPaidBy.get(b.id) || null;
      return {
        business_id:            b.id,
        name:                   b.name || null,
        version:                b.version || null,
        owner_id:               b.owner_id,
        owner_email:            u?.email || null,
        email_verified:         !!u?.email_confirmed_at,
        last_sign_in_at:        u?.last_sign_in_at || null,
        created_at:             b.created_at,
        has_prompt:             Boolean(b.business_description || b.musical_emphases),
        delivery_mode:          modeBy.get(b.id) ?? null,
        approved_genre_count:   approvedBy.get(b.id) ?? 0,
        payment_status:         paidAt ? 'paid' : 'no-payment',
        paid_at:                paidAt,
        subscription_status:    paidAt ? subscriptionStatus(b) : null,
        last_daily_built_at:    lastBuiltBy.get(b.id) || null,
        opens_7d:               opens7.get(b.id) || 0,
        opens_total:            opensTotal.get(b.id) || 0,
        last_opened_at:         lastOpenBy.get(b.id) || null,
        special_requests_total: eventsBy.get(b.id) || 0,
        taste_chat_messages:    chatsBy.get(b.id) || 0,
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: rows.length, businesses: rows });
  } catch (err) {
    console.error('[internal:users] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
