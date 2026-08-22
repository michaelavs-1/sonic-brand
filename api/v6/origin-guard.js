/* Shared request-origin guard for the SonicBrands pilot.
   Blocks cost/write API endpoints from being abused off-site while keeping
   the anonymous onboarding flow (which runs before signup) working. */

// Exact-domain allowlist for custom-domain deploys. robin-music.com is the
// primary customer-facing custom domain (DNS points at the sonic-brand
// Vercel project). sonic-brand.com is reserved for a potential future
// rename cutover but is not currently live.
const ALLOWED_HOST_RE = /(^|\.)(sonic-brand\.com|robin-music\.com)$/i;

// Vercel deploy allowlist. Restricted to *this* project so that a random
// attacker's `attackerapp.vercel.app` doesn't pass — only the prod alias
// `sonic-brand.vercel.app` and this project's preview URLs
// (`sonic-brand-<hash>-<team>.vercel.app`) match.
function isSonicBrandVercelHost(h) {
  if (h === 'sonic-brand.vercel.app') return true;
  return h.startsWith('sonic-brand-') && h.endsWith('.vercel.app');
}

function hostOf(raw) {
  try { return new URL(raw).host.toLowerCase(); } catch { return ''; }
}

// True when the given host is one we consider ours: custom domain, this
// project's Vercel deploys, or local dev. Exported so other endpoints
// (signup magic-link derivation, CORS allowlist) can reuse the same
// canonical answer. Host must arrive already lowercased.
export function isAllowedHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  const hostOnly = h.split(':')[0]; // strip ":port"
  if (ALLOWED_HOST_RE.test(hostOnly)) return true;
  if (isSonicBrandVercelHost(hostOnly)) return true;
  return hostOnly === 'localhost' || hostOnly === '127.0.0.1';
}

// True when the request came from our own site. Origin can be spoofed
// trivially with curl, so this guard is casual-abuse mitigation — not a
// real security boundary. Localhost exemption keeps browser testing on
// http://127.0.0.1:3000 working without weakening prod protection.
export function fromSite(req) {
  const raw = req.headers.origin || req.headers.referer || '';
  if (!raw) return false;
  return isAllowedHost(hostOf(raw));
}

// Defense-in-depth CORS: reflect the request Origin only if it's in our
// allowlist. Wildcard `*` used to be sprinkled across every endpoint,
// which meant any browser on any site could preflight+POST our APIs.
// requireSite is the primary check (it inspects Origin/Referer), but
// tightening the response header stops the browser from ever surfacing
// the reply to a malicious page. Server-to-server calls (from Node fetch)
// have no Origin header — this is a no-op for them, which is correct
// because CORS is a browser policy and doesn't apply to those requests.
export function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch {}
    if (originHost && isAllowedHost(originHost)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
}

// Browser-only endpoints (explain / transcribe / openai): must come from the site.
// Returns true when allowed; otherwise writes a 403 and returns false.
export function requireSite(req, res) {
  if (fromSite(req)) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
}

// Endpoints also called server-to-server (e.g. daily playlist building):
// allow the site OR an internal call carrying the shared secret. Fail-CLOSED
// on missing config — INTERNAL_API_KEY MUST be set in every environment
// (Vercel prod + preview + `.env.local`). A missing env var used to fail
// open, which turned every internal-only endpoint into a public one; now
// it 500s loudly so the misconfig is impossible to miss on first hit.
export function requireSiteOrInternal(req, res) {
  if (fromSite(req)) return true;
  const key = process.env.INTERNAL_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'server misconfigured: INTERNAL_API_KEY not set' });
    return false;
  }
  if (req.headers['x-sonic-internal'] === key) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
}
