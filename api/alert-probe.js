/* /api/alert-probe.js
   Diagnostic endpoint used by scripts/test-cluster-failure-alert.mjs to
   verify the running function environment can actually see SUPABASE_AUTH
   (i.e. it's in Vercel cloud env, not just `.env.local`).

   Not underscore-prefixed because Vercel treats api/_*.js as non-routable
   helper modules (that's why api/_alert.js can be a shared library without
   accidentally becoming an endpoint).

   Also exercises api/_alert.js end-to-end so we know the pipe works
   BEFORE relying on cron alerts (which are fire-and-forget with no
   return channel — the entire point of this probe).

   Auth: same bearer as the cron secret. This endpoint reveals whether
   an env var is present + can send a real email, so it must not be
   world-callable.

   Usage:
     GET  /api/alert-probe          → { env_present, from, to }
     POST /api/alert-probe          → sends a real test email, returns
                                      { env_present, sent, reason? }
*/

import { timingSafeEqual } from 'node:crypto';
import { sendAlert } from './_alert.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'server misconfigured: CRON_SECRET not set' });
  }
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const provided = Buffer.from(req.headers.authorization || '');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const env_present = !!process.env.SUPABASE_AUTH;
  const from        = process.env.ALERT_EMAIL_FROM || 'noreply@robin-music.com';
  const to          = process.env.ALERT_EMAIL_TO   || 'roni.mark@gmail.com';

  if (req.method === 'GET') {
    return res.status(200).json({ env_present, from, to });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Live send — goes through the actual sendAlert helper the cron uses,
  // so a PASS here really does mean the cron's alert path will work.
  const result = await sendAlert({
    subject: '[sonic-brand] alert probe',
    text: [
      'This is the alert probe endpoint verifying end-to-end delivery.',
      'If you see this email, api/_alert.js works inside vercel dev / prod.',
      `Sent at: ${new Date().toISOString()}`,
    ].join('\n'),
  });

  return res.status(200).json({
    env_present,
    sent:   result.ok,
    reason: result.reason || null,
  });
}
