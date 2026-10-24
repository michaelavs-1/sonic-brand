/* /api/v6/_gemini-ceiling.js
   Daily ceiling on Gemini spend from BROWSER calls (added 2026-10-24).

   /api/v6/gemini takes whole prompts from the browser (onboarding, the
   playlist-type step, Ami's dashboard), so anyone can use it as a free LLM.
   Until the prompts move to the server, this caps the damage: once browser
   calls have cost BROWSER_DAILY_USD in an Israel calendar day, the proxy
   refuses further browser calls until midnight Israel time. Server calls
   (x-sonic-internal: taste chat, special playlists, portraits) never count
   and are never refused.

   A normal day is about $0.30 (30-day average, 2026-10-24). Emails go out
   once when the day passes half the ceiling and once when it reaches it.

   To lift a tripped ceiling early: delete the Redis key
   gemini:browser-spend:<YYYY-MM-DD> in Upstash.

   Fail-open like api/v6/ratelimit.js: without Redis nothing is counted and
   nothing is refused.

   Not an HTTP endpoint. Bare imports only. */

import { sendAlert } from '../_alert.js';

export const BROWSER_DAILY_USD = 20;

const ilDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const spendKey = (day) => `gemini:browser-spend:${day}`;

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

// Today's browser spend so far, in USD (0 when Redis is unavailable).
export async function browserSpendToday() {
  const res = await redis([['GET', spendKey(ilDate())]]);
  return Number(res?.[0]?.result) || 0;
}

// Adds one browser call's cost. The call that crosses half the ceiling, and
// the one that reaches it, each send one email (INCRBYFLOAT hands every call
// its own total, so exactly one call crosses each line).
export async function addBrowserSpend(usd) {
  if (!(usd > 0)) return;
  const day = ilDate();
  const res = await redis([
    ['INCRBYFLOAT', spendKey(day), String(usd)],
    ['EXPIRE', spendKey(day), String(3 * 86400)],
  ]);
  const total = Number(res?.[0]?.result);
  if (!Number.isFinite(total)) return;

  const crossed = (line) => total >= line && total - usd < line;
  const spent = `$${total.toFixed(2)}`;
  if (crossed(BROWSER_DAILY_USD)) {
    await sendAlert({
      subject: `Gemini: browser calls blocked until midnight (${spent} today)`,
      text: [
        `Gemini calls made from browsers have cost ${spent} today (${day}, Israel date), reaching the $${BROWSER_DAILY_USD} daily ceiling.`,
        `Until 00:00 Israel time, /api/v6/gemini refuses browser calls: new onboardings and the playlist-type step can't generate.`,
        `Server calls (taste chat, special playlists) are not affected.`,
        ``,
        `A normal day is about $0.30. Check gemini_call_log for today's labels and volume.`,
        `To lift it now: delete the Redis key ${spendKey(day)} in Upstash, or raise BROWSER_DAILY_USD in api/v6/_gemini-ceiling.js and deploy.`,
      ].join('\n'),
    });
  } else if (crossed(BROWSER_DAILY_USD / 2)) {
    await sendAlert({
      subject: `Gemini: browser spend passed $${BROWSER_DAILY_USD / 2} today (${spent})`,
      text: [
        `Gemini calls made from browsers have cost ${spent} today (${day}, Israel date).`,
        `At $${BROWSER_DAILY_USD}, /api/v6/gemini refuses browser calls until midnight Israel time.`,
        `A normal day is about $0.30. Check gemini_call_log for today's labels and volume.`,
      ].join('\n'),
    });
  }
}
