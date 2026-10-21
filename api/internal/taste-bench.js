/* /api/internal/taste-bench — Ami's taste chat test bench on REAL accounts
   (his prompt dashboard's "צ'אט הטעם המוזיקלי" tab, 2026-10-21).

   GET  ?id=<business_uuid>
     → { business_id, name, mode, ctx }
       ctx = exactly what the taste chat builds for this business each turn
       (_taste-context.js: profile + recipes as taste-ops state, today's
       playlists, what played, the change log, the portrait…), so the bench
       talks to the chat as the owner would. The business list comes from
       GET /api/internal/users.

   POST { business_id, ops: [...], summary_he?, switch?: { mode, library } }
     Saves the changes Ami tried in the bench to the real profile:
     - switch (optional, first): the business moves to the other playlist
       type with the library the bench showed (taste-ops withMode — keys as
       the bench gave them). Like the owner's own switch (set-delivery-mode):
       business_v7_settings.delivery_mode + updated_at (the cron then skips
       the business for 15 min), and for Option 2 the stored energy timeline,
       or a default one fitted to the opening hours when there's none.
       Audited as 'delivery_mode' / 'energy_timeline'.
     - ops: run again on the business's CURRENT state (taste-ops applyOps —
       what no longer fits is dropped and reported).
     Written like the admin console's direction edits (writeTasteState),
     logged in business_taste_changes with source 'admin' (so the owner's undo
     never reverts it) and admin_actions.
     → { ok, applied, dropped, notes, switched }
     They take effect from the next build (today's playlists stay as they are).

   Guarded by INTERNAL_ADMIN_API_KEY (_guard.js), like the rest of
   /api/internal: the dashboard is a public page, and this reads and changes
   customers' data. */

import { pgrSelect, pgrInsert, pgrUpsert } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { UUID_RE, hasServiceKey, loadBusiness, logAdminAction, selfOrigin } from './_admin.js';
import { readTasteState, writeTasteState } from '../v7/account/_taste-state.js';
import { readHours, auditSetting } from '../v7/account/_settings-helpers.js';
import { buildTasteContext } from '../v7/account/_taste-context.js';
import { applyOps, snapshotOf, withMode } from '../../v7/generation/taste-ops.js';
import { reconcileTimeline, timelinesEqual } from '../../v7/generation/energy-timeline.js';

const MAX_OPS = 40;

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const id = String(req.method === 'GET' ? req.query?.id || '' : body.business_id || '').trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ error: '`id` (GET) / `business_id` (POST) must be a business uuid' });
    const biz = await loadBusiness(id);
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const loaded = await readTasteState(id);
    if (!loaded) return res.status(409).json({ error: 'no taste profile or no playlist type picked yet', code: 'not-ready' });
    const { state, settings } = loaded;

    if (req.method === 'GET') {
      const [bizRows, hours] = await Promise.all([
        pgrSelect('businesses', { id: `eq.${id}` }, { select: 'name,business_description,musical_emphases', limit: 1, useService: true }),
        readHours(id).catch(() => null),
      ]);
      const ctx = await buildTasteContext({
        businessId: id, biz: bizRows?.[0] || null, state, settings, hours, linked: [], now: new Date(), origin: selfOrigin(req),
      });
      return res.status(200).json({ business_id: id, name: biz.name || null, mode: state.mode, ctx });
    }

    // ---- POST: save the bench's changes ----
    const ops = Array.isArray(body.ops) ? body.ops.filter((o) => o && typeof o === 'object' && typeof o.op === 'string') : [];
    const sw = body.switch && typeof body.switch === 'object' ? body.switch : null;
    if (!ops.length && !sw) return res.status(400).json({ error: 'nothing to save: ops and/or switch' });
    if (ops.length > MAX_OPS) return res.status(400).json({ error: `at most ${MAX_OPS} ops at a time` });
    if (ops.some((o) => o.op === 'undo')) return res.status(400).json({ error: 'undo is not saved from the bench' });
    if (sw && sw.mode !== 'option1' && sw.mode !== 'option2') return res.status(400).json({ error: "switch.mode must be 'option1' or 'option2'" });
    const switching = !!sw && sw.mode !== state.mode;

    const base = switching ? withMode(state, sw.mode, Array.isArray(sw.library) ? sw.library : []) : state;
    const r = ops.length ? applyOps(base, ops) : { state: base, applied: [], dropped: [], notes: [], changed: true };
    if (!switching && (!r.applied.length || !r.changed)) {
      return res.status(409).json({ error: 'nothing would change on the current profile', code: 'nothing-to-change', dropped: r.dropped });
    }
    await writeTasteState(id, state, r.state);

    if (switching) {
      // The playlist type, as the owner's own switch writes it.
      const hours = await readHours(id).catch(() => null);
      const row = { business_id: id, delivery_mode: sw.mode, updated_at: new Date().toISOString() };
      if (sw.mode === 'option2' && hours) row.timeline = reconcileTimeline(settings.timeline ?? null, hours);
      await pgrUpsert('business_v7_settings', row, { onConflict: 'business_id' });
      await auditSetting(id, 'delivery_mode', state.mode, sw.mode);
      if (row.timeline && !timelinesEqual(settings.timeline ?? null, row.timeline)) {
        await auditSetting(id, 'energy_timeline', settings.timeline ?? null, row.timeline);
      }
    }

    const what = [switching ? `switched to ${sw.mode}` : '', String(body.summary_he || '').trim()].filter(Boolean).join(' · ');
    const summary = `[admin · Ami's bench] ${what.slice(0, 280) || `${r.applied.length} changes`}`;
    const logRow = {
      business_id: id, delivery_mode: r.state.mode, ops: r.applied, summary_he: summary,
      before: snapshotOf(state), after: snapshotOf(r.state), message_id: null, source: 'admin',
    };
    try {
      await pgrInsert('business_taste_changes', logRow);
    } catch (e) {
      console.error('[internal taste-bench] change log failed:', e.message);
    }
    await logAdminAction(id, 'taste:bench_save', { switched: switching ? sw.mode : null, ops: r.applied, dropped: r.dropped, notes: r.notes, summary });
    return res.status(200).json({ ok: true, applied: r.applied, dropped: r.dropped, notes: r.notes, switched: switching ? sw.mode : null });
  } catch (err) {
    console.error('[internal taste-bench] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
