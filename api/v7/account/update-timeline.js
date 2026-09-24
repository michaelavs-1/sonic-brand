/* /api/v7/account/update-timeline.js
   Save the owner's Option-2 energy timeline (Profile tab → "עריכת ציר
   האנרגיה" → modal → שמירה).

   The submitted timeline is normalised against the business's CURRENT hours
   (reconcileTimeline — one group per distinct schedule, dots snapped to the
   group's :00/:30 slots, 2–12 dots) before it's stored, so the stored value
   always matches the hours the builder will read.

   Does NOT touch business_v7_settings.updated_at: the v7 cron reads it as
   "delivery mode changed" (15-min mode-just-set skip), and a timeline edit
   isn't a mode change. Writes an audit row (business_settings_changes,
   field 'energy_timeline') when the stored value actually changes.

   Returns the stored timeline plus `replace` (see _replace-status.js) so the
   client knows whether to ask "replace today's playlists now?".

   Request:  { business_id, timeline }
   Response: { ok: true, timeline, replace } | { error }
*/

import { pgrPatch, pgrUpsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { reconcileTimeline, timelinesEqual } from '../../../v7/generation/energy-timeline.js';
import { verifyUser, readHours, readSettings, auditSetting, timelineTooBig } from './_settings-helpers.js';
import { replaceStatus } from './_replace-status.js';

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-update-timeline', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { business_id, timeline } = req.body || {};
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!timeline || typeof timeline !== 'object' || timelineTooBig(timeline)) {
      return res.status(400).json({ error: 'timeline required' });
    }
    try { await requireBusinessOwner(business_id, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const [hours, settings] = await Promise.all([readHours(business_id), readSettings(business_id)]);
    if (!hours) return res.status(400).json({ error: 'שעות הפתיחה עדיין לא נשמרו' });

    const stored = reconcileTimeline(timeline, hours);
    const before = settings?.timeline ?? null;
    if (settings) {
      await pgrPatch('business_v7_settings', { business_id: `eq.${business_id}` }, { timeline: stored });
    } else {
      await pgrUpsert('business_v7_settings', { business_id, timeline: stored }, { onConflict: 'business_id' });
    }
    if (!timelinesEqual(before, stored)) await auditSetting(business_id, 'energy_timeline', before, stored);

    const replace = await replaceStatus({ businessId: business_id, hours });
    console.log(`[v7 update-timeline] biz ${business_id} — ${stored.groups.length} group(s), replace=${JSON.stringify(replace)}`);
    return res.status(200).json({ ok: true, timeline: stored, replace });
  } catch (err) {
    console.error('[v7 update-timeline] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
