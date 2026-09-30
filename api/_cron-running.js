/* /api/_cron-running.js
   "A cron is running right now" flags in Upstash Redis, so optional Spotify
   work can step aside for the crons (which write to the same Rubin account).

   Each cron marks itself right after its auth check and clears the flag
   before responding. The flag carries a TTL a little past the crons' 300s
   maxDuration, so a crashed tick can't leave it stuck.

   Used by api/cron/v7-generate-daily.js ('v7-daily'), api/cron/expire-playlists.js
   ('expire'), and read by api/v7/ami/test-playlist.js (Ami's test playlists
   wait until no cron is running).

   Fail-open like api/v6/ratelimit.js: without Redis nothing is marked and
   nothing is reported as running.

   Not an HTTP endpoint. Bare imports only. */

import { randomUUID } from 'node:crypto';

export const CRON_FLAG_NAMES = ['v7-daily', 'expire'];
const FLAG_TTL_SEC = 330;
const keyOf = (name) => `cron:running:${name}`;

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

// → { release: () => Promise<void> }. release only clears the flag if it's
// still this tick's (an overlapping tick may have re-marked it).
export async function markCronRunning(name) {
  const token = randomUUID();
  await redis([['SET', keyOf(name), token, 'EX', String(FLAG_TTL_SEC)]]);
  return {
    release: async () => {
      const cur = await redis([['GET', keyOf(name)]]);
      if (Array.isArray(cur) && cur[0]?.result === token) await redis([['DEL', keyOf(name)]]);
    },
  };
}

// Names of the crons running right now ([] when none, or Redis is unavailable).
export async function runningCrons() {
  const res = await redis(CRON_FLAG_NAMES.map((n) => ['EXISTS', keyOf(n)]));
  if (!Array.isArray(res)) return [];
  return CRON_FLAG_NAMES.filter((_, i) => res[i]?.result === 1);
}
