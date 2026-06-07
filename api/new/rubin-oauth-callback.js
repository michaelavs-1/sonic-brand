/* /api/new/rubin-oauth-callback.js
   One-time-use endpoint to seed the Rubin Spotify user's refresh_token.
   Flow:
     1. Roni registers this URI in the Rubin app's Spotify Developer Dashboard.
     2. Roni visits the Spotify authorize URL (with Rubin app's client_id) in a browser
        logged into the Rubin user.
     3. Spotify redirects here with ?code=...
     4. We exchange that code for access_token + refresh_token using Rubin app credentials.
     5. We render an HTML page showing both tokens for copy-paste.
*/

const REDIRECT_URI = 'http://127.0.0.1:3000/api/new/rubin-oauth-callback';

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shellHtml(title, content) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 22px; margin-bottom: 12px; }
  h2 { font-size: 14px; margin-top: 28px; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 6px; word-break: break-all; white-space: pre-wrap; user-select: all; font-size: 12px; line-height: 1.45; }
  code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; font-size: 12.5px; }
  .ok { color: #0a7d2c; }
  .err { color: #b00020; }
  p { line-height: 1.5; }
</style></head><body>${content}</body></html>`;
}

function renderSuccess(tokens) {
  return shellHtml('Rubin OAuth — tokens', `
  <h1 class="ok">✓ Rubin OAuth succeeded</h1>
  <p>Copy the tokens below. The <code>refresh_token</code> is the load-bearing one; save it.</p>

  <h2>refresh_token (long-lived, save this)</h2>
  <pre>${esc(tokens.refresh_token || '')}</pre>
  <p>Add to <code>.env.local</code>:</p>
  <pre>RUBIN_REFRESH_TOKEN=${esc(tokens.refresh_token || '')}</pre>
  <p>Then restart <code>vercel dev</code>.</p>

  <h2>access_token (valid ~1 hour — for immediate Stage-1 verification)</h2>
  <pre>${esc(tokens.access_token || '')}</pre>
  <p>Use immediately to verify Rubin's app can create + add tracks:</p>
  <pre>node tests/.test-playlist-builder.mjs ${esc(tokens.access_token || '')}</pre>

  <h2>scope</h2>
  <pre>${esc(tokens.scope || '')}</pre>
`);
}

function renderError(title, detail) {
  return shellHtml('Rubin OAuth — error', `
  <h1 class="err">✗ ${esc(title)}</h1>
  <pre>${esc(detail)}</pre>
`);
}

export default async function handler(req, res) {
  const send = (status, html) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(status).end(html);
  };

  try {
    const { code, error } = req.query || {};

    if (error) {
      return send(400, renderError('Spotify returned an error', `error=${error}`));
    }
    if (!code) {
      return send(400, renderError('Missing code parameter',
        'Open the Spotify authorize URL in a browser logged in as the Rubin user. You should land here with ?code=... in the URL.'));
    }

    const clientId = process.env.RUBIN_SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      const envKeys = Object.keys(process.env).filter(k => /^(RUBIN|SPOTIFY|OPENAI)/i.test(k)).sort();
      const detail = [
        'RUBIN_SPOTIFY_CLIENT_ID is set: '     + (clientId     ? 'yes (len ' + clientId.length     + ')' : 'NO'),
        'RUBIN_SPOTIFY_CLIENT_SECRET is set: ' + (clientSecret ? 'yes (len ' + clientSecret.length + ')' : 'NO'),
        '',
        'All RUBIN_/SPOTIFY_/OPENAI_ env vars vercel dev currently has loaded:',
        envKeys.length ? envKeys.join('\n') : '(none)',
        '',
        'If RUBIN_* names are absent above, vercel dev did not load them from .env.local.',
        'Make sure .env.local lives in the project root (alongside vercel.json) and that vercel dev was restarted AFTER adding the lines.',
      ].join('\n');
      return send(500, renderError('Missing Rubin app credentials', detail));
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI,
      }),
    });

    const body = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      const detail = `Status: ${tokenRes.status}\nError: ${body.error || ''}\nDescription: ${body.error_description || ''}`;
      return send(tokenRes.status, renderError('Token exchange failed', detail));
    }

    return send(200, renderSuccess(body));
  } catch (err) {
    return send(500, renderError('Unexpected error', err.message || String(err)));
  }
}
