/* /api/v7/account/_build-lock.js
   One daily-playlist build at a time per business (on-demand builds and
   "replace now" share it). Upstash Redis SET NX EX; fail-OPEN when Redis is
   unavailable — same philosophy as api/v6/ratelimit.js (a lock outage must
   not block owners from getting playlists).

   Not an HTTP endpoint. Bare imports only. */

import { randomUUID } from 'node:crypto';

async function redis(commands) {
  const url   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
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

// → { acquired: boolean, release: () => Promise<void> }
export async function acquireBuildLock(businessId, ttlSec = 240) {
  const key = `v7:build:${businessId}`;
  const token = randomUUID();
  const res = await redis([['SET', key, token, 'NX', 'EX', String(ttlSec)]]);
  if (!Array.isArray(res)) return { acquired: true, release: async () => {} };      // fail-open
  if (res[0]?.result !== 'OK') return { acquired: false, release: async () => {} };
  return {
    acquired: true,
    // Only delete the lock if it's still ours (it may have expired and been
    // taken by a later build).
    release: async () => {
      const cur = await redis([['GET', key]]);
      if (Array.isArray(cur) && cur[0]?.result === token) await redis([['DEL', key]]);
    },
  };
}
