/* /api/v6/account/_require-business-owner.js
   Ownership check shared by the protected v6 account endpoints
   (expand-playlist, event-playlist, generate-daily).

   These endpoints receive a `businessId` in their JSON body and a JWT in
   the Authorization header. verifyUser() validates the JWT identity; this
   helper confirms that the businesses row identified by that id actually
   belongs to the authenticated user, closing an authorization hole where
   any logged-in user with a valid JWT could otherwise write to any
   business's user_metadata (writes bypass RLS via service role).
*/

import { pgrSelect } from '../../v5/supabase-client.js';

// Throws an Error with { status } attached that the caller can forward
// straight to the JSON response. Returns silently on success.
export async function requireBusinessOwner(businessId, userId) {
  if (!businessId) {
    const e = new Error('businessId required');
    e.status = 400;
    throw e;
  }
  if (!userId) {
    const e = new Error('unauthorized');
    e.status = 401;
    throw e;
  }
  const rows = await pgrSelect('businesses', {
    id: `eq.${businessId}`,
    owner_id: `eq.${userId}`,
  }, { select: 'id', limit: 1, useService: true });
  if (!Array.isArray(rows) || rows.length === 0) {
    const e = new Error('not your business');
    e.status = 403;
    throw e;
  }
}
