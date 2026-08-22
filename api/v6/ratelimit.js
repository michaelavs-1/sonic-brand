/* Zero-dependency rate limiter backed by Upstash Redis (REST).

   Usage in a handler:
     import { guard } from './ratelimit.js';   // or '../v6/ratelimit.js'
     if (!await guard(req, res, 'anthropic', 10, 60)) return;

   Behavior:
     - Fixed-window counter (Redis INCR + PEXPIRE-NX). Simple + atomic via
       a single pipeline call; sliding-window would need a sorted-set trick
       and 2x the round trips.
     - Keyed by client IP. Server-to-server callers carrying a valid
       `x-sonic-internal` header BYPASS the limiter — otherwise every
       internal call from our own Vercel functions would share one IP
       (the serverless egress IP) and starve legitimate cross-user traffic.
     - Fail-open on any Upstash outage / misconfig. A rate limiter that
       500s the whole site during a Redis blip is worse than one that
       briefly stops enforcing. We log once so the missing env vars are
       loud, then move on.

   Env (as auto-injected by Vercel's Upstash integration with the
   `UPSTASH_REDIS_REST` custom prefix):
     UPSTASH_REDIS_REST_KV_REST_API_URL
     UPSTASH_REDIS_REST_KV_REST_API_TOKEN
   The awkward double-prefix comes from Vercel concatenating our chosen
   prefix onto Upstash's own default names — set both in Vercel + mirror
   into `.env.local` for `vercel dev`.
*/

let warnedMissing = false;

export function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip']
      || req.socket?.remoteAddress
      || 'unknown';
}

export async function guard(req, res, name, limit, windowSec) {
  // Server-to-server bypass — internal callers are already trusted and
  // sharing one egress IP, so rate-limiting them would misfire.
  const internal = process.env.INTERNAL_API_KEY;
  if (internal && req.headers['x-sonic-internal'] === internal) return true;

  const url   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) {
    if (!warnedMissing) {
      console.warn('[ratelimit] UPSTASH_REDIS_REST_KV_REST_API_URL/TOKEN not set — rate limiting DISABLED. Set them in Vercel env.');
      warnedMissing = true;
    }
    return true;
  }

  const ip     = ipOf(req);
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key    = `rl:${name}:${ip}:${bucket}`;

  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['PEXPIRE', key, String(windowSec * 1000), 'NX'],
      ]),
    });
    if (!r.ok) return true; // fail open on infra glitch
    const data = await r.json().catch(() => null);
    const count = Array.isArray(data) ? data[0]?.result : null;
    if (typeof count === 'number' && count > limit) {
      res.setHeader('Retry-After', String(windowSec));
      res.status(429).json({ error: 'rate_limited', name });
      return false;
    }
    return true;
  } catch {
    return true; // fail open on infra glitch
  }
}
