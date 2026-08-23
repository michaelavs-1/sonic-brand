/* Auth guard for /api/internal/* endpoints.

   Michael's forthcoming admin dashboard (host TBD, not part of this repo)
   is the only intended caller. Auth model: a single shared bearer token
   in the `INTERNAL_ADMIN_API_KEY` env var, presented as either
     Authorization: Bearer <key>
   or the direct `x-internal-admin-key` header for scripts/curl that don't
   want to synthesize an Authorization header.

   No cookies, no user session — the bearer token IS the security
   boundary, so CORS is deliberately permissive (`*`) to let the dashboard
   run from any origin without pre-registration. This is safe *because*
   the token isn't in a cookie: a browser on evil.com can't force a user's
   browser to attach it to a cross-site fetch.

   Fail-CLOSED on missing config (INTERNAL_ADMIN_API_KEY unset) — same
   philosophy as requireSiteOrInternal in api/v6/origin-guard.js. A
   silently-open admin API is much worse than a loud 500.
*/

// crypto.timingSafeEqual works on equal-length Buffers only; padding both
// to a fixed length via SHA-256 avoids leaking key length through the
// early-exit path. Overkill for a static shared secret, but the pattern
// is cheap and standard so future readers don't have to think about it.
import { createHash, timingSafeEqual } from 'node:crypto';

function digest(s) {
  return createHash('sha256').update(String(s || '')).digest();
}

function extractToken(req) {
  const h = req.headers['authorization'] || req.headers['x-internal-admin-key'] || '';
  if (!h) return '';
  const s = String(h);
  return s.toLowerCase().startsWith('bearer ') ? s.slice(7).trim() : s.trim();
}

export function setAdminCors(_req, res) {
  // Bearer-token auth means we can safely allow any origin here — a
  // malicious page in the user's browser can't attach the token unless
  // the user pasted it there. See file header comment.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-internal-admin-key, Content-Type');
  res.setHeader('Vary', 'Origin');
}

export function requireAdmin(req, res) {
  const configured = process.env.INTERNAL_ADMIN_API_KEY;
  if (!configured) {
    res.status(500).json({ error: 'server misconfigured: INTERNAL_ADMIN_API_KEY not set' });
    return false;
  }
  const presented = extractToken(req);
  if (!presented) {
    res.status(401).json({ error: 'missing Authorization: Bearer <key>' });
    return false;
  }
  if (!timingSafeEqual(digest(presented), digest(configured))) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}
