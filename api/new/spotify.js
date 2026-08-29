import { requireSiteOrInternal, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';
import { sendAlert } from '../_alert.js';

// Emergency kill switch for Spotify WRITE operations. Flip to `true` to
// freeze all writes (create_playlist / add_tracks / update_playlist /
// replace_tracks / unfollow_playlist). Reads keep working — they use
// Michael's Client Credentials token which is independent of Rubin's user
// token and doesn't affect any cooldown Rubin might be in.
// Added 2026-08-26 after Rubin's token was pushed into a 403 block by a
// cron pileup. Kept in place because the check has zero runtime cost when
// the flag is `false`.
// Re-enabled 2026-08-29 after the resilience layer (pause switch + backoff
// + alerts + pacing) landed. Superseded in practice by the Redis pause
// switch — this flag stays as a break-glass local override.
const SPOTIFY_WRITES_DISABLED = false;
/* /api/new/spotify.js
   Lean Spotify proxy for the new pipeline. Actions:
     - get_playlist_tracks: read tracks from public playlists (Client Credentials via Michael's app)
     - create_playlist:     create a playlist on the Rubin user's account (user token via Rubin app)
     - add_tracks:          add tracks to a playlist (user token via Rubin app)
     - update_playlist:     rename/edit description of an existing playlist (user token)
     - replace_tracks:      replace playlist contents (empty via uris:[]) (user token)
     - unfollow_playlist:   remove playlist from Rubin's library (playlist itself remains reachable by URL) (user token)
     - search_track:        title/artist search via CC token
   Token sources:
     - Client Credentials: SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET (Michael's app — grandfathered)
     - User token:         RUBIN_REFRESH_TOKEN + RUBIN_SPOTIFY_CLIENT_ID + RUBIN_SPOTIFY_CLIENT_SECRET
                           (seed RUBIN_REFRESH_TOKEN once via /api/new/rubin-oauth-callback)

   Resilience layer (added 2026-08-29 post-Aug-22-incident):
     1. Every upstream Spotify fetch has an AbortController 15s timeout —
        prevents a single hung call (Aug 7 style) from eating the 30s
        function budget.
     2. Every 4xx/5xx from Spotify is logged with the response body + parsed
        `error.reason` field. This was the missing visibility that let the
        Aug 22 QUOTA_EXCEEDED escalate silently.
     3. Redis-backed global pause switch. On any 429 with Retry-After ≥ 30s,
        OR any 403 with reason=QUOTA_EXCEEDED, the key `spotify:pause_until`
        is set to the pause deadline (epoch ms). Every subsequent user-token
        call short-circuits with a synthetic 503 until the key expires. Fires
        one alert email per pause event.
     4. Daily write counter. Every successful user-token write increments
        `spotify:writes:YYYY-MM-DD` (Asia/Jerusalem). Alerts once at 500
        (soft warning) and once at 800 (hard warning).
*/

let ccToken  = null;
let ccExpiry = 0;

let userToken   = null;
let userExpiry  = 0;
let userRefresh = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UPSTREAM_TIMEOUT_MS = 15000;
const PAUSE_KEY           = 'spotify:pause_until';
const PAUSE_TRIGGER_SEC   = 30;   // Retry-After ≥ this triggers the global pause
const QUOTA_EXCEEDED_TTL  = 6 * 60 * 60; // 6h pause for 403 QUOTA_EXCEEDED (Retry-After is often huge/absent)
const WRITE_SOFT_ALERT    = 500;
const WRITE_HARD_ALERT    = 800;

// -------- Redis helpers (Upstash REST pipeline) --------

function redisEnv() {
  return {
    url:   process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
  };
}

async function redisPipeline(commands) {
  const { url, token } = redisEnv();
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

// -------- Pause switch --------

// Returns { until } if currently paused, or null.
async function checkPause() {
  const res = await redisPipeline([['GET', PAUSE_KEY]]);
  const raw = Array.isArray(res) ? res[0]?.result : null;
  if (!raw) return null;
  const until = parseInt(raw, 10);
  if (!until || until <= Date.now()) return null;
  return { until };
}

// Set the pause deadline, but only if it extends any existing pause.
// Fires an alert email on first-set (or extension).
async function setPause(untilMs, reason) {
  const remainingSec = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
  // Small race here (read → compare → write) but at our scale a rare few-second
  // overlap is fine. The point is not to accidentally shorten a long QUOTA
  // pause with a subsequent short-Retry-After 429 arriving milliseconds later.
  const current = await checkPause();
  if (current && current.until >= untilMs) {
    console.warn(`[spotify] pause already set until ${new Date(current.until).toISOString()} (>= new ${new Date(untilMs).toISOString()}), not overwriting`);
    return { extended: false, until: current.until };
  }
  // TTL includes a small buffer so the key doesn't expire microseconds
  // before the deadline check thinks it should.
  const res = await redisPipeline([['SET', PAUSE_KEY, String(untilMs), 'EX', String(remainingSec + 60)]]);
  const ok = Array.isArray(res) && res[0]?.result === 'OK';
  if (!ok) {
    console.warn(`[spotify] pause SET failed (redis unavailable?) — proceeding without global pause`);
    return { extended: false, until: 0 };
  }
  console.warn(`[spotify] pause ENGAGED until ${new Date(untilMs).toISOString()} (${remainingSec}s) — reason: ${reason}`);
  // Await the alert send. Vercel freezes the function process after res.end(),
  // and fire-and-forget promises get cut off mid-fetch — confirmed empirically
  // on 2026-08-29 when cron cluster alerts never delivered despite the code
  // running. Cost here is ~300ms added to the FIRST 429/403 response that
  // trips the pause; every subsequent paused call short-circuits fast on the
  // Redis check without touching Spotify or Resend.
  await sendAlert({
    subject: '[sonic-brand] Spotify pause switch engaged',
    text: [
      `Rubin's Spotify writes are now paused globally.`,
      ``,
      `Reason:  ${reason}`,
      `Until:   ${new Date(untilMs).toISOString()} (${remainingSec}s from now)`,
      ``,
      `While paused, every write action returns HTTP 503 with error='spotify_paused'.`,
      `Reads via Michael's CC token are unaffected.`,
      ``,
      `The key auto-expires. No manual action required unless the cause looks structural.`,
    ].join('\n'),
  }).catch((e) => {
    console.warn('[spotify] pause alert send threw:', e?.message);
  });
  return { extended: true, until: untilMs };
}

// -------- Daily write counter --------

// yyyy-mm-dd in Asia/Jerusalem — matches the way daily-gen thinks about "today"
// so the counter turnover lines up with meaningful business day boundaries.
function todayIL() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function incrDailyWrites() {
  const key = `spotify:writes:${todayIL()}`;
  // INCR + EXPIRE-NX-with-2-day-TTL so today's key auto-cleans tomorrow.
  const res = await redisPipeline([
    ['INCR', key],
    ['EXPIRE', key, String(60 * 60 * 48), 'NX'],
  ]);
  const count = Array.isArray(res) ? res[0]?.result : null;
  if (typeof count !== 'number') return;
  // Alert only on the exact transition — prevents storming if the counter
  // races past the threshold under concurrent load.
  // Await these too: same Vercel-freezes-fire-and-forget reason as setPause.
  // Only the write call that crosses the threshold pays the alert latency;
  // every other successful write only pays the INCR + EXPIRE cost.
  if (count === WRITE_SOFT_ALERT) {
    await sendAlert({
      subject: `[sonic-brand] Spotify writes: ${count} today (soft threshold)`,
      text: `Today's Spotify write count crossed ${WRITE_SOFT_ALERT}.\nKey: ${key}\nHard alert at ${WRITE_HARD_ALERT}.`,
    }).catch((e) => {
      console.warn('[spotify] soft-threshold alert send threw:', e?.message);
    });
  } else if (count === WRITE_HARD_ALERT) {
    await sendAlert({
      subject: `[sonic-brand] Spotify writes: ${count} today (HARD threshold)`,
      text: `Today's Spotify write count crossed ${WRITE_HARD_ALERT}. Getting close to the observed rate-limit ceiling. Consider pausing background jobs.\nKey: ${key}`,
    }).catch((e) => {
      console.warn('[spotify] hard-threshold alert send threw:', e?.message);
    });
  }
}

// -------- Token acquisition --------

async function getCCToken() {
  if (ccToken && Date.now() < ccExpiry) return ccToken;
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Client Credentials token fetch failed: ${r.status}`);
  const data = await r.json();
  ccToken  = data.access_token;
  ccExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  return ccToken;
}

async function refreshUserToken() {
  if (!userRefresh) {
    const envToken = process.env.RUBIN_REFRESH_TOKEN;
    if (!envToken) {
      throw new Error('RUBIN_REFRESH_TOKEN not set — seed it via /api/new/rubin-oauth-callback once, then add it to env.');
    }
    userRefresh = envToken;
  }

  const clientId     = process.env.RUBIN_SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('RUBIN_SPOTIFY_CLIENT_ID / RUBIN_SPOTIFY_CLIENT_SECRET not set');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: userRefresh,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Rubin user token refresh failed: ${r.status} ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  userToken  = data.access_token;
  userExpiry = Date.now() + (data.expires_in * 1000) - 60000;

  // Spotify may rotate the refresh_token. Use the new one in-process; if it persists,
  // update RUBIN_REFRESH_TOKEN env so the next cold start picks up the latest.
  if (data.refresh_token && data.refresh_token !== userRefresh) {
    console.warn('[rubin] Spotify rotated the refresh_token. Update RUBIN_REFRESH_TOKEN env var to:', data.refresh_token);
    userRefresh = data.refresh_token;
  }

  return userToken;
}

async function getUserToken() {
  if (userToken && Date.now() < userExpiry) return userToken;
  return refreshUserToken();
}

// -------- Synthetic response objects --------
// spotifyCall's callers use { status, json(), headers.get() }. When we can't
// reach Spotify (paused / timeout), we return an object that satisfies that
// interface so no downstream branching is needed.

function synthResp(status, bodyObj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj),
  };
}

// -------- The upstream call --------

async function spotifyCall(url, init, tokenKind) {
  // Global pause applies to user-token calls only. CC calls hit Michael's
  // app which is on a different quota bucket and hasn't been the source
  // of any block we've seen.
  if (tokenKind === 'user') {
    const pause = await checkPause();
    if (pause) {
      const remainingMs = Math.max(0, pause.until - Date.now());
      return synthResp(503, {
        error:          'spotify_paused',
        pausedUntil:    pause.until,
        remainingMs,
        hint:           'a prior 429/403 tripped the global pause switch — retry after remainingMs',
      });
    }
  }

  const getToken = async () => (tokenKind === 'user' ? getUserToken() : getCCToken());

  const doFetch = async (t) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, {
        ...(init || {}),
        headers: { ...((init && init.headers) || {}), 'Authorization': `Bearer ${t}` },
        signal: ctl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        console.warn(`[spotify] ${tokenKind} ${init?.method || 'GET'} ${url} — TIMEOUT after ${UPSTREAM_TIMEOUT_MS}ms`);
        return synthResp(504, { error: 'spotify_upstream_timeout', hint: `no response from Spotify within ${UPSTREAM_TIMEOUT_MS}ms` });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    // Log body + reason on ANY 4xx/5xx from Spotify. This is the visibility
    // we didn't have on Aug 22 — every failed call now leaves a breadcrumb.
    // Body is consumed once and cached on the returned object so the handler
    // (which does its own r.json()) doesn't stall on an empty stream.
    let bodyText = '';
    let bodyJson = null;
    try {
      bodyText = await r.text();
      try { bodyJson = JSON.parse(bodyText); } catch {}
    } catch { /* body already consumed — extremely rare */ }

    if (r.status >= 400) {
      const reason = bodyJson?.error?.reason || null;
      console.warn(`[spotify] ${tokenKind} ${init?.method || 'GET'} ${url} → ${r.status}${reason ? ` reason=${reason}` : ''}: ${bodyText.slice(0, 500)}`);
    }

    // Wrap into the same synthetic shape as the paused/timeout paths so callers
    // see a consistent interface. Preserve Spotify's real headers for
    // Retry-After access below.
    return {
      status: r.status,
      ok:     r.ok,
      headers: r.headers,
      json:   async () => bodyJson ?? {},
      text:   async () => bodyText,
      _bodyJson: bodyJson,
    };
  };

  let token = await getToken();
  let r = await doFetch(token);

  // 401 = token expired mid-flight. Refresh + retry once. Never counts against
  // the pause switch (this is a benign token-lifecycle case).
  if (r.status === 401) {
    if (tokenKind === 'user') { userToken = null; userExpiry = 0; }
    else                      { ccToken   = null; ccExpiry   = 0; }
    token = await getToken();
    r = await doFetch(token);
  }

  // 429 → maybe set the global pause. Only Retry-After ≥ 30s trips the switch
  // — shorter windows are normal Spotify per-second smoothing and callers can
  // handle those with their own retry logic. Note we no longer do an internal
  // retry-on-429 here (that's what fired the escalation storm on Aug 22 —
  // ~500 additional failed calls after the first block). The response goes
  // straight back to the caller.
  if (tokenKind === 'user' && r.status === 429) {
    const retryAfter = parseInt(r.headers?.get?.('retry-after') || '0', 10);
    if (retryAfter >= PAUSE_TRIGGER_SEC) {
      const untilMs = Date.now() + retryAfter * 1000;
      await setPause(untilMs, `429 Retry-After=${retryAfter}s on ${init?.method || 'GET'} ${url}`);
    }
  }

  // 403 with reason=QUOTA_EXCEEDED → set a long pause. Spotify introduced this
  // reason field in July 2026's rate-limit rework; its Retry-After header is
  // often unhelpfully large (hours) or missing entirely. Use a fixed 6h pause
  // as an educated guess; the alert email tells us to check whether Spotify's
  // dashboard has anything more specific.
  if (tokenKind === 'user' && r.status === 403) {
    const reason = r._bodyJson?.error?.reason || null;
    if (reason === 'QUOTA_EXCEEDED') {
      const untilMs = Date.now() + QUOTA_EXCEEDED_TTL * 1000;
      await setPause(untilMs, `403 QUOTA_EXCEEDED on ${init?.method || 'GET'} ${url}`);
    }
  }

  // Successful writes on Rubin's account bump the daily counter. Reads and
  // failures don't count — we care about quota consumption, not attempts.
  // Awaited so that when the counter crosses a threshold, the alert email
  // inside incrDailyWrites actually leaves the box before res.end() lets
  // Vercel freeze the function. Cost on non-threshold writes is ~50ms
  // (one Redis pipeline roundtrip).
  if (tokenKind === 'user' && r.ok) {
    await incrDailyWrites().catch((e) => {
      console.warn('[spotify] daily write counter update threw:', e?.message);
    });
  }

  return r;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sonic-internal');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSiteOrInternal(req, res)) return;
  if (!await guard(req, res, 'spotify', 60, 60)) return;

  try {
    const { action } = req.body || {};

    const WRITE_ACTIONS = new Set([
      'create_playlist', 'add_tracks', 'update_playlist',
      'replace_tracks', 'unfollow_playlist',
    ]);
    if (SPOTIFY_WRITES_DISABLED && WRITE_ACTIONS.has(action)) {
      console.warn(`[spotify] WRITE BLOCKED (SPOTIFY_WRITES_DISABLED constant): ${action}`);
      return res.status(503).json({
        error: 'spotify_writes_disabled',
        action,
        hint: 'flip SPOTIFY_WRITES_DISABLED to false in api/new/spotify.js to re-enable',
      });
    }

    if (action === 'get_playlist_tracks') {
      const { playlist_id, offset = 0, limit = 50, fields } = req.body;
      if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });
      const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      if (fields) qs.set('fields', fields);
      const url = `https://api.spotify.com/v1/playlists/${playlist_id}/tracks?${qs}`;
      const r = await spotifyCall(url, { method: 'GET' }, 'cc');
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    if (action === 'create_playlist') {
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const r = await spotifyCall(`https://api.spotify.com/v1/me/playlists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || '', public: false, collaborative: true }),
      }, 'user');
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    if (action === 'add_tracks') {
      const { playlist_id, uris } = req.body;
      if (!playlist_id || !Array.isArray(uris) || !uris.length) {
        return res.status(400).json({ error: 'playlist_id and non-empty uris required' });
      }
      const results = [];
      for (let i = 0; i < uris.length; i += 100) {
        const batch = uris.slice(i, i + 100);
        const r = await spotifyCall(`https://api.spotify.com/v1/playlists/${playlist_id}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: batch }),
        }, 'user');
        const data = await r.json().catch(() => ({}));
        results.push({ status: r.status, body: data });
      }
      return res.status(200).json({ results });
    }

    if (action === 'update_playlist') {
      const { playlist_id, name, description } = req.body;
      if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });
      const body = {};
      if (typeof name        === 'string') body.name        = name;
      if (typeof description === 'string') body.description = description;
      if (!Object.keys(body).length) return res.status(400).json({ error: 'name or description required' });
      const r = await spotifyCall(`https://api.spotify.com/v1/playlists/${playlist_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 'user');
      return res.status(r.status).json(r.status === 200 ? { ok: true } : await r.json().catch(() => ({})));
    }

    if (action === 'replace_tracks') {
      // Replaces the entire playlist's items with the given uris. Passing an
      // empty uris array is the supported way to empty a playlist in one call.
      const { playlist_id, uris = [] } = req.body;
      if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });
      if (!Array.isArray(uris))       return res.status(400).json({ error: 'uris must be an array' });
      if (uris.length > 100)          return res.status(400).json({ error: 'replace_tracks supports up to 100 uris in one call' });
      const r = await spotifyCall(`https://api.spotify.com/v1/playlists/${playlist_id}/items`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris }),
      }, 'user');
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    if (action === 'unfollow_playlist') {
      const { playlist_id } = req.body;
      if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });
      const r = await spotifyCall(`https://api.spotify.com/v1/playlists/${playlist_id}/followers`, {
        method: 'DELETE',
      }, 'user');
      return res.status(r.status).json(r.status === 200 ? { ok: true } : await r.json().catch(() => ({})));
    }

    if (action === 'search_track') {
      const { title, artist } = req.body;
      if (!title || !artist) return res.status(400).json({ error: 'title and artist required' });

      const doSearch = async (q) => {
        const qs = new URLSearchParams({ q, type: 'track', limit: '1' });
        return spotifyCall(`https://api.spotify.com/v1/search?${qs}`, { method: 'GET' }, 'cc');
      };

      let r = await doSearch(`track:"${title}" artist:"${artist}"`);
      let data = await r.json().catch(() => ({}));
      let item = data?.tracks?.items?.[0];

      if (!item) {
        r = await doSearch(`${title} ${artist}`);
        data = await r.json().catch(() => ({}));
        item = data?.tracks?.items?.[0];
      }

      if (!item) return res.status(200).json({ found: false });
      return res.status(200).json({
        found: true,
        id: item.id,
        name: item.name,
        artists: (item.artists || []).map(a => a.name),
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
