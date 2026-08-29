/* /api/_alert.js
   Fire-and-forget email alerts via Resend REST. Used by:
     - api/new/spotify.js       (Spotify pause switch engaged, QUOTA_EXCEEDED)
     - api/cron/expire-playlists.js
                                (cluster failure alert, chronic per-row alert)
     - api/v6/account/_daily-builder.js
                                (any handler that wants to escalate)

   Design constraints:
     - Fail-open on missing RESEND_API_KEY or Resend outage — a broken alert
       path must never take down the caller.
     - Alerts are best-effort. Callers should `await sendAlert(...).catch(() => {})`
       or just fire-and-forget. This function itself catches all internal
       errors and returns { ok: false, reason } instead of throwing.
     - Rendered as plain text. Resend accepts either text or html; text keeps
       the payload small and avoids escaping headaches with backticks / Hebrew.

   Env:
     SUPABASE_AUTH       required. The project's Resend API key. Named
                         SUPABASE_AUTH because it was originally added
                         for Supabase's SMTP magic-link config (see
                         CLAUDE.md → Auth email). Set in Vercel + .env.local.
     ALERT_EMAIL_FROM    optional. Defaults to 'noreply@robin-music.com'
                         (the sender already verified with Resend for
                         Supabase Auth magic-links — see CLAUDE.md Auth email).
     ALERT_EMAIL_TO      optional. Defaults to 'roni.mark@gmail.com'.
*/

const RESEND_URL       = 'https://api.resend.com/emails';
const DEFAULT_FROM     = 'noreply@robin-music.com';
const DEFAULT_TO       = 'roni.mark@gmail.com';

let warnedMissing = false;

/**
 * Send an alert email. Never throws.
 *
 * @param {object} args
 * @param {string} args.subject   Short subject line (< 78 chars ideally).
 * @param {string} args.text      Plain-text body. Include everything an oncall
 *                                dev would need to triage without opening the
 *                                console (playlist ids, error messages, ISO
 *                                timestamps, links).
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function sendAlert({ subject, text }) {
  const key = process.env.SUPABASE_AUTH;
  if (!key) {
    if (!warnedMissing) {
      console.warn('[alert] SUPABASE_AUTH not set — email alerts DISABLED');
      warnedMissing = true;
    }
    return { ok: false, reason: 'no_key' };
  }
  const from = process.env.ALERT_EMAIL_FROM || DEFAULT_FROM;
  const to   = process.env.ALERT_EMAIL_TO   || DEFAULT_TO;

  try {
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.warn(`[alert] Resend send failed ${r.status}:`, body.slice(0, 200));
      return { ok: false, reason: `resend_${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[alert] Resend fetch threw:', err?.message);
    return { ok: false, reason: 'network' };
  }
}
