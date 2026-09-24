/* /api/v7/account/set-delivery-mode.js
   Persist the owner's v7 daily-playlist type ("סוג פלייליסטים יומיים").

   Called by the first-login mode gate (#v7ModeGate in v7/account) and by the
   Profile tab's type cards. Upserts ONE row into business_v7_settings
   (owner-scoped, upsert on business_id):
     - delivery_mode = 'option1' (4 playlists/day: 2 high + 2 low energy)
                     | 'option2' (2 playlists/day: energy follows the timeline)
     - updated_at    = now (the v7 cron skips a business for 15 min after a
                       mode change — the dashboard builds today's set itself)
     - timeline      — Option 2's energy timeline. Switching to Option 2 always
                       goes through the timeline modal (mandatory), so the
                       client sends it; it's normalised against the current
                       hours (reconcileTimeline). Option 2 with no timeline
                       sent or stored → defaults. Switching to Option 1 keeps
                       the stored timeline (switching back restores it).

   Audit: business_settings_changes rows for 'delivery_mode' and
   'energy_timeline' when they change.

   Auth: owner JWT + requireBusinessOwner.
   Request:  { business_id, delivery_mode, timeline? }
   Response: { ok: true, delivery_mode, timeline, replace } | { error }
             (replace — see _replace-status.js — tells the Profile tab whether
             to ask "replace today's playlists now?")
*/

import { pgrUpsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { reconcileTimeline, timelinesEqual } from '../../../v7/generation/energy-timeline.js';
import { verifyUser, readHours, readSettings, auditSetting, timelineTooBig } from './_settings-helpers.js';
import { replaceStatus } from './_replace-status.js';

const MODE_SET = new Set(['option1', 'option2']);

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'set-delivery-mode', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { business_id, delivery_mode, timeline } = req.body || {};
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!MODE_SET.has(delivery_mode)) {
      return res.status(400).json({ error: 'delivery_mode must be option1 or option2' });
    }
    if (timeline != null && (typeof timeline !== 'object' || timelineTooBig(timeline))) {
      return res.status(400).json({ error: 'invalid timeline' });
    }
    try { await requireBusinessOwner(business_id, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const [hours, before] = await Promise.all([readHours(business_id), readSettings(business_id)]);

    const row = { business_id, delivery_mode, updated_at: new Date().toISOString() };
    let stored = before?.timeline ?? null;
    if (delivery_mode === 'option2' && hours && (timeline || !stored)) {
      stored = reconcileTimeline(timeline || stored, hours);
      row.timeline = stored;
    }

    await pgrUpsert('business_v7_settings', row, { onConflict: 'business_id' });

    if ((before?.delivery_mode ?? null) !== delivery_mode) {
      await auditSetting(business_id, 'delivery_mode', before?.delivery_mode ?? null, delivery_mode);
    }
    if (row.timeline && !timelinesEqual(before?.timeline ?? null, row.timeline)) {
      await auditSetting(business_id, 'energy_timeline', before?.timeline ?? null, row.timeline);
    }

    const replace = hours ? await replaceStatus({ businessId: business_id, hours }) : null;
    console.log(`[set-delivery-mode] biz ${business_id} — ${delivery_mode}${row.timeline ? ' (+timeline)' : ''}`);
    return res.status(200).json({ ok: true, delivery_mode, timeline: stored, replace });
  } catch (err) {
    console.error('[set-delivery-mode] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
