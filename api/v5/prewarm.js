/* /api/v5/prewarm.js
   Fire-and-forget prewarm for Postgres plan cache. Frontend calls this once
   on page load. We hit both v5 RPCs so their plans are cached by the time
   the user's real submit arrives — cold cold-start on the first real call
   otherwise pushes past Supabase's 3s statement_timeout.

   Always returns 200; failures are swallowed and only logged server-side.
*/

import { pgrRpc } from './supabase-client.js';
import { requireSite, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'prewarm', 30, 60)) return;

  const t0 = Date.now();
  const results = await Promise.allSettled([
    pgrRpc('v5_anchor_tracks', {
      p_specs:  [{ rank: 0, genre: 'rock', bpm_lo: 0, bpm_hi: 250 }],
      p_pop_lo: 0,
      p_pop_hi: 100,
    }),
    pgrRpc('v5_direction_tracks', {
      p_genres: ['rock'],
      p_bpm_lo: 0,
      p_bpm_hi: 250,
      p_pop_lo: 0,
      p_pop_hi: 100,
      p_limit:  1,
    }),
  ]);

  const summary = results.map((r, i) => {
    const name = i === 0 ? 'anchor_tracks' : 'direction_tracks';
    return r.status === 'fulfilled'
      ? `${name}=ok`
      : `${name}=err(${(r.reason?.message || 'unknown').slice(0, 80)})`;
  }).join(' ');
  console.log(`[v5 prewarm] ${Date.now() - t0}ms ${summary}`);

  return res.status(200).json({ ok: true, elapsed: Date.now() - t0 });
}
