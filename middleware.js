/* Vercel Routing Middleware (2026-10-24).

   Ami's prompt dashboard (/v5/ami-prompt-dashboard) is served only to someone
   with the admin key (INTERNAL_ADMIN_API_KEY): the page and every file under
   it.

   Since 2026-11-02 a page of our own asks for the key (one field; until then it
   was the browser's Basic-auth box, which also asks for a username nobody
   checked). The page posts the key to LOGIN_PATH (header x-ami-key); a right key gets an HttpOnly
   cookie holding a hash of it, sent with the dashboard's other files. The page
   also saves the key in localStorage 'ami-admin-key', the entry the taste-chat
   tab and the test playlists read, so they don't ask for it again. A new key
   (rotation) invalidates every cookie.

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

const BASE = '/v5/ami-prompt-dashboard';
const LOGIN_PATH = `${BASE}/__login`;
const COOKIE = 'ami_dash';
const COOKIE_DAYS = 30;

const encoder = new TextEncoder();
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Compares the digests in full, so the time taken doesn't depend on where
// the two values first differ.
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// The cookie holds a hash of the key, never the key itself.
const cookieValueFor = async (key) => hex(await sha256(`ami-dashboard:${key}`));

function cookieOf(request) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return '';
}

async function handleLogin(request, key) {
  // In a header, not the body: vercel dev hands middleware an empty body.
  const given = (request.headers.get('x-ami-key') || '').trim();
  if (!key || !given || !await sameSecret(given, key)) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${COOKIE}=${await cookieValueFor(key)}; Path=${BASE}; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; SameSite=Strict${secure}`,
    },
  });
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>כניסה</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0f0f14; color: #eee; font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
  form { background: #1a1a22; padding: 28px; border-radius: 14px; width: min(340px, 90vw); box-sizing: border-box; }
  h1 { margin: 0 0 16px; font-size: 18px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 8px; border: 1px solid #333;
          background: #0f0f14; color: #eee; font-size: 15px; direction: ltr; }
  button { margin-top: 14px; width: 100%; padding: 11px; border: 0; border-radius: 8px; background: #6c5ce7;
           color: #fff; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #err { color: #ff7675; font-size: 14px; min-height: 20px; margin-top: 10px; }
</style>
</head>
<body>
<form id="f">
  <h1>מפתח גישה</h1>
  <input id="k" type="password" autocomplete="current-password" autofocus required>
  <button id="b" type="submit">כניסה</button>
  <div id="err"></div>
</form>
<script>
  const f = document.getElementById('f'), k = document.getElementById('k'),
        b = document.getElementById('b'), err = document.getElementById('err');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = k.value.trim();
    if (!key) return;
    b.disabled = true; err.textContent = '';
    try {
      const r = await fetch('${LOGIN_PATH}', {
        method: 'POST', headers: { 'x-ami-key': key }, credentials: 'same-origin',
      });
      if (r.ok) {
        try { localStorage.setItem('ami-admin-key', key); } catch (_) {}
        location.reload();
        return;
      }
      err.textContent = r.status === 401 ? 'המפתח שגוי' : 'שגיאה, נסו שוב';
    } catch (_) {
      err.textContent = 'שגיאה, נסו שוב';
    }
    b.disabled = false;
  });
</script>
</body>
</html>`;

export default async function middleware(request) {
  const key = process.env.INTERNAL_ADMIN_API_KEY;
  const { pathname } = new URL(request.url);

  if (pathname === LOGIN_PATH && request.method === 'POST') return handleLogin(request, key);

  const cookie = cookieOf(request);
  if (key && cookie && await sameSecret(cookie, await cookieValueFor(key))) return;

  // The page itself gets the key form; its files (JS, CSS) just a 401.
  const isPage = pathname === BASE || pathname === `${BASE}/` || pathname === `${BASE}/index.html`;
  return new Response(isPage ? LOGIN_PAGE : 'Admin key required.', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': isPage ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    },
  });
}
