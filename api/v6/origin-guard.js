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
// (`sonic-brand-<9-char hash>-<team>.vercel.app`, branch previews
// `sonic-brand-git-<branch>-<team>.vercel.app`) match. Pinned to the team
// suffix since 2026-10-24: any `sonic-brand-*.vercel.app` used to pass, and
// anyone can create a Vercel project named `sonic-brand-something`.
const VERCEL_TEAM_SUFFIX = '-michaelavs-1s-projects.vercel.app';
const PREVIEW_RE = /^sonic-brand-(?:[a-z0-9]{9}|git-[a-z0-9-]+)$/;
function isSonicBrandVercelHost(h) {
  if (h === 'sonic-brand.vercel.app') return true;
  if (!h.endsWith(VERCEL_TEAM_SUFFIX)) return false;
  return PREVIEW_RE.test(h.slice(0, -VERCEL_TEAM_SUFFIX.length));
}

// localhost / 127.0.0.1 count as ours only outside production (vercel dev,
// local browser testing). In production they would let any page served from
// a visitor's own machine pass the Origin check.
const LOCAL_ALLOWED = process.env.VERCEL_ENV !== 'production';

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
  return LOCAL_ALLOWED && (hostOnly === 'localhost' || hostOnly === '127.0.0.1');
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

// True when the request carries the server-to-server key
// (`x-sonic-internal: INTERNAL_API_KEY`). False when the key isn't configured.
export function isInternal(req) {
  const key = process.env.INTERNAL_API_KEY;
  return !!key && req.headers['x-sonic-internal'] === key;
}

// Server-only endpoints (Spotify writes, the RapidAPI proxies):
// only our own functions may call them. Fail-CLOSED like requireSiteOrInternal.
export function requireInternal(req, res) {
  if (!process.env.INTERNAL_API_KEY) {
    res.status(500).json({ error: 'server misconfigured' });
    return false;
  }
  if (isInternal(req)) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
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
    res.status(500).json({ error: 'server misconfigured' });
    return false;
  }
  if (req.headers['x-sonic-internal'] === key) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
}
