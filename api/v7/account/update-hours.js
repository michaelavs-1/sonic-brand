/* /api/v7/account/update-hours.js
   v7 copy of /api/v6/account/update-hours (v6's endpoint is untouched):
   persist the week's opening hours from the Profile-tab editor, audit the
   change — and, new for v7, immediately bring the Option-2 energy timeline in
   line with the new hours.

   Timeline rule (Roni, 2026-09-24): KEEP CLOCK TIMES. Dots stay at their
   hours; a dot on the old opening/closing moves to the new one; dots outside
   the new hours are dropped (at least 2 kept); a day that gets its own hours
   copies the timeline it came from. See reconcileTimeline in
   v7/generation/energy-timeline.js. Reconciled whenever the business has a
   stored timeline (even while on Option 1, so switching back is consistent),
   or has none yet but is on Option 2 (→ defaults). An hours change never
   asks "replace today's playlists?" — it applies from the next build.

   Request:  { businessId, hours, longestMinutes? }
   Response: { ok: true, timeline } | { error }   (timeline null if none applies)
*/

import { pgrUpsert, pgrSelect, pgrInsert, pgrPatch } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from '../../v6/account/_require-business-owner.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { reconcileTimeline, timelinesEqual } from '../../../v7/generation/energy-timeline.js';
import { verifyUser, readSettings, auditSetting } from './_settings-helpers.js';

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-update-hours', 20, 60)) return;

  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, hours, longestMinutes } = req.body || {};
    if (!businessId || !hours || typeof hours !== 'object') {
      return res.status(400).json({ error: 'businessId and hours required' });
    }
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Before-snapshot for the audit row (best-effort).
    let beforeHours = null;
    try {
      const rows = await pgrSelect('business_hours',
        { business_id: `eq.${businessId}` },
        { select: 'hours,longest_minutes', limit: 1, useService: true });
      if (rows?.[0]) beforeHours = { hours: rows[0].hours, longest_minutes: rows[0].longest_minutes };
    } catch (e) {
      console.warn('[v7 update-hours] before-snapshot read failed:', e.message);
    }

    const nextLongestMinutes = Number.isFinite(longestMinutes) && longestMinutes > 0
      ? Math.round(longestMinutes)
      : null;
    await pgrUpsert('business_hours', {
      business_id:     businessId,
      hours,
      longest_minutes: nextLongestMinutes,
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'business_id' });

    const afterHours = { hours, longest_minutes: nextLongestMinutes };
    if (!beforeHours || JSON.stringify(beforeHours) !== JSON.stringify(afterHours)) {
      try {
        await pgrInsert('business_settings_changes', {
          business_id: businessId, field: 'hours', before: beforeHours, after: afterHours,
        });
      } catch (e) {
        console.warn('[v7 update-hours] audit insert failed:', e.message);
      }
    }

    // Timeline follows the hours.
    let timeline = null;
    try {
      const settings = await readSettings(businessId);
      if (settings && (settings.timeline || settings.delivery_mode === 'option2')) {
        timeline = reconcileTimeline(settings.timeline, hours);
        if (!timelinesEqual(settings.timeline, timeline)) {
          await pgrPatch('business_v7_settings', { business_id: `eq.${businessId}` }, { timeline });
          await auditSetting(businessId, 'energy_timeline', settings.timeline ?? null, timeline);
        }
      }
    } catch (e) {
      // The hours are saved; the builder reconciles on read anyway.
      console.warn('[v7 update-hours] timeline reconcile failed:', e.message);
    }

    return res.status(200).json({ ok: true, timeline });
  } catch (err) {
    console.error('[v7 update-hours] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
