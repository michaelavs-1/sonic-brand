/* /api/v7/payment/status.js
   The payment step's source of truth while Hyp's iframe is open (polled, and
   checked when the return page posts its message).

     GET ?id=<checkoutId>  →  { status: 'pending' | 'paid' | 'failed', claimed }

   `claimed` = a signup already linked this checkout to a business, so the
   client must not reuse it for a new onboarding. The checkout id is a random
   uuid handed only to the browser that started the checkout.
*/

import { pgrSelect } from '../../v5/supabase-client.js';
import { requireSite, setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'v7-payment-status', 120, 60)) return;

  const id = String(req.query?.id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id required' });

  try {
    const rows = await pgrSelect('payment_checkouts', { id: `eq.${id}` },
      { select: 'status,business_id', limit: 1, useService: true });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ error: 'not found' });
    return res.status(200).json({ status: row.status, claimed: !!row.business_id });
  } catch (err) {
    console.error('[v7 payment status] failed:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
