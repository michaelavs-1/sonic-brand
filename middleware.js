/* Vercel Routing Middleware (2026-10-24).

   Ami's prompt dashboard (/v5/ami-prompt-dashboard) is served only to someone
   with the admin key (INTERNAL_ADMIN_API_KEY): the page and every file under
   it. The browser shows its own login box; any username, the key as the
   password. The browser keeps it for the session and sends it with the
   dashboard's other files.

   Runs before static files are served, and only on the matcher's paths, so
   the rest of the site never invokes it. Fail-closed: without the env var,
   nobody gets in. Returning nothing lets the request continue.

   The old version pages (/v2–/v6, /v7/test-timeline) are closed by the
   redirects in vercel.json, not here. */

export const config = {
  // '/(.*)' rather than '/:path*': the latter misses the bare trailing slash,
  // which would serve the dashboard's index.html without the key.
  matcher: ['/v5/ami-prompt-dashboard', '/v5/ami-prompt-dashboard/(.*)'],
};

const encoder = new TextEncoder();
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)));

// Compares the digests in full, so the time taken doesn't depend on where
// the two keys first differ.
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function passwordOf(request) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return '';
  try {
    const decoded = atob(header.slice(6).trim());
    return decoded.slice(decoded.indexOf(':') + 1);
  } catch { return ''; }
}

export default async function middleware(request) {
  const key = process.env.INTERNAL_ADMIN_API_KEY;
  const password = passwordOf(request);
  if (key && password && await sameSecret(password, key)) return;

  return new Response('Admin key required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Rubin admin", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
