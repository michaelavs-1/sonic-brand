/* Shared request-origin guard for the SonicBrands pilot.
   Blocks cost/write API endpoints from being abused off-site while keeping
   the anonymous onboarding flow (which runs before signup) working. */

const ALLOWED_HOST_RE = /(^|\.)robin-music\.com$/i;

function hostOf(raw) {
  try { return new URL(raw).host.toLowerCase(); } catch { return ''; }
}

// True when the request came from our own site (or a Vercel preview build,
// or a local `vercel dev` session). Origin can be spoofed trivially with
// curl, so this guard is casual-abuse mitigation — not a real security
// boundary — and the localhost exemption keeps browser testing on
// http://127.0.0.1:3000 working without weakening prod protection.
export function fromSite(req) {
  const raw = req.headers.origin || req.headers.referer || '';
  if (!raw) return false;
  const h = hostOf(raw);
  if (ALLOWED_HOST_RE.test(h) || h.endsWith('.vercel.app')) return true;
  // Strip the ":port" suffix so 127.0.0.1:3000 / localhost:3000 both match.
  const hostOnly = h.split(':')[0];
  return hostOnly === 'localhost' || hostOnly === '127.0.0.1';
}

// Browser-only endpoints (explain / transcribe / openai): must come from the site.
// Returns true when allowed; otherwise writes a 403 and returns false.
export function requireSite(req, res) {
  if (fromSite(req)) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
}

// Endpoints also called server-to-server (e.g. daily playlist building):
// allow the site OR an internal call carrying the shared secret. Fail-open on
// the internal path until INTERNAL_API_KEY is configured, so deploying this
// never breaks internal calls before the env var is set.
export function requireSiteOrInternal(req, res) {
  if (fromSite(req)) return true;
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return true; // not configured yet — keep internal calls working
  if (req.headers['x-sonic-internal'] === key) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
}
