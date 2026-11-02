/* /api/internal/taste-bench — Ami's taste chat test bench on REAL accounts
   (his prompt dashboard's "צ'אט הטעם המוזיקלי" tab, 2026-10-21).

   GET  ?id=<business_uuid>
     → { business_id, name, mode, ctx, reonboard }
       ctx = exactly what the taste chat builds for this business each turn
       (_taste-context.js: profile + recipes as taste-ops state, today's
       playlists, what played, the change log, the portrait…), so the bench
       talks to the chat as the owner would. The business list comes from
       GET /api/internal/users.
       reonboard = { atmospheres, place } — the rest of the business's
       onboarding inputs, for "אונבורדינג מחדש" (2026-11-02).

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

   POST { business_id, replace: { profile, library, cards?, superLikedGenres?,
          round2Emphases?, genreTally? }, ops?, summary_he? }   (2026-11-02)
     "אונבורדינג מחדש": Ami re-ran the two-deck onboarding for this business
     (v7/?bench=1) and saves the new taste profile in place of the current one.
     1. ARCHIVE FIRST: the whole current profile row + both recipe libraries
        go into business_taste_profile_archive. If that fails, nothing is
        replaced.
     2. The new profile row is written the way signup writes it (with the new
        swipe cards), carrying over the owner's weights for genres still
        approved and the genres they turned down; their own songs stay.
     3. The current playlist type's library is replaced by `library` (built by
        the dashboard with the production generator for the new profile), then
        `ops` (the chat changes Ami tried on the new profile) are applied.
     Logged in business_taste_changes (source 'admin', ops start with
     {op:'reonboard', archive_id}) — neither undo reverts it (their snapshots
     don't carry the energy scale); the archive does — and in admin_actions.
     → { ok, replaced: true, archive_id, applied, dropped, notes }

   Guarded by INTERNAL_ADMIN_API_KEY (_guard.js), like the rest of
   /api/internal: the dashboard is a public page, and this reads and changes
   customers' data. */

import { pgrSelect, pgrInsert, pgrUpsert } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { UUID_RE, hasServiceKey, loadBusiness, logAdminAction, selfOrigin, fetchAuthUser } from './_admin.js';
import { readTasteState, writeTasteState } from '../v7/account/_taste-state.js';
import { tasteProfileRow, upsertTasteProfileRow, isUsableTasteProfile } from '../v7/account/_taste-profile.js';
import { readHours, auditSetting } from '../v7/account/_settings-helpers.js';
import { buildTasteContext } from '../v7/account/_taste-context.js';
import { applyOps, snapshotOf, withMode, stateFromRows } from '../../v7/generation/taste-ops.js';
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
      const [bizRows, hours, owner, places] = await Promise.all([
        pgrSelect('businesses', { id: `eq.${id}` }, { select: 'name,business_description,musical_emphases', limit: 1, useService: true }),
        readHours(id).catch(() => null),
        biz.owner_id ? fetchAuthUser(biz.owner_id).catch(() => null) : null,
        pgrSelect('business_place', { business_id: `eq.${id}` }, { select: '*', limit: 1, useService: true }).catch(() => []),
      ]);
      const ctx = await buildTasteContext({
        businessId: id, biz: bizRows?.[0] || null, state, settings, hours, linked: [], now: new Date(), origin: selfOrigin(req),
      });
      // The rest of the onboarding inputs, for "אונבורדינג מחדש": the
      // atmospheres (kept in the owner's auth metadata since signup) and the
      // Google place, in the shape the onboarding passes to the prompts.
      const atm = owner?.user_metadata?.sonic?.onboarding?.atmospheres;
      const p = places?.[0] || null;
      const reonboard = {
        atmospheres: Array.isArray(atm) ? atm.filter((a) => typeof a === 'string') : [],
        place: p ? {
          name: p.name || null, address: p.address || null, primary_type: p.primary_type || null,
          types: Array.isArray(p.types) ? p.types : [], editorial_summary: p.editorial_summary || null,
          price_level: p.price_level || null, vibe: p.vibe && typeof p.vibe === 'object' ? p.vibe : {},
        } : null,
      };
      return res.status(200).json({ business_id: id, name: biz.name || null, mode: state.mode, ctx, reonboard });
    }

    // ---- POST with `replace`: the re-onboarded profile in place of the current one ----
    if (body.replace) return await replaceProfile(req, res, { id, loaded, body });

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

// "אונבורדינג מחדש" — see the header. Archive first; replace only after.
async function replaceProfile(req, res, { id, loaded, body }) {
  const { state, settings, profile: oldProfile } = loaded;
  const rep = body.replace && typeof body.replace === 'object' ? body.replace : {};
  if (body.switch) return res.status(400).json({ error: 'a re-onboarding is saved on its own, without a type switch' });
  const ops = Array.isArray(body.ops) ? body.ops.filter((o) => o && typeof o === 'object' && typeof o.op === 'string') : [];
  if (ops.length > MAX_OPS) return res.status(400).json({ error: `at most ${MAX_OPS} ops at a time` });
  if (ops.some((o) => o.op === 'undo')) return res.status(400).json({ error: 'undo is not saved from the bench' });
  const profile = rep.profile;
  if (!isUsableTasteProfile(profile) || !profile.approved_genres.length) {
    return res.status(400).json({ error: 'replace.profile must be a taste profile with approved genres' });
  }
  const library = Array.isArray(rep.library) ? rep.library.filter((d) => d && Array.isArray(d.genres) && d.genres.length) : [];
  if (!library.length) return res.status(400).json({ error: `replace.library must hold the new ${state.mode} recipes` });

  // 1. Archive the current profile and both libraries. Nothing is replaced
  //    unless this succeeds.
  const [option1Rows, levelRows] = await Promise.all([
    pgrSelect('business_v7_directions', { business_id: `eq.${id}`, active: 'is.true' }, { select: '*', useService: true }).catch(() => []),
    pgrSelect('business_v7_level_directions', { business_id: `eq.${id}`, active: 'is.true' }, { select: '*', useService: true }).catch(() => []),
  ]);
  let archiveId = null;
  try {
    const rows = await pgrInsert('business_taste_profile_archive', {
      business_id: id, profile: oldProfile, option1_directions: option1Rows, level_directions: levelRows,
      delivery_mode: state.mode, reason: 'reonboard', source: 'ami-dashboard',
    }, { returnRows: true });
    archiveId = rows?.[0]?.id ?? null;
  } catch (e) {
    console.error('[internal taste-bench] archive failed:', e.message);
    return res.status(500).json({
      error: `the current profile could not be archived, so nothing was replaced (${e.message}) — run migration 2026-11-02-v7-taste-profile-archive.sql`,
      code: 'archive-failed',
    });
  }

  // 2. The new profile row, as signup writes it; the owner's weights (for
  //    genres still approved) and turned-down genres carry over.
  const approvedNow = new Set(profile.approved_genres.map((e) => e?.genre).filter(Boolean));
  const weights = Object.fromEntries(Object.entries(state.weights || {}).filter(([g]) => approvedNow.has(g)));
  const rejected = (state.rejected || []).filter((g) => !approvedNow.has(g));
  const row = tasteProfileRow(id, profile, Array.isArray(rep.genreTally) ? rep.genreTally : null, {
    superLikedGenres: Array.isArray(rep.superLikedGenres) ? rep.superLikedGenres : [],
    round2Emphases: typeof rep.round2Emphases === 'string' ? rep.round2Emphases : '',
    onboardingProbes: Array.isArray(rep.cards) ? rep.cards : null,
  });

  // 3. The state on the new profile with the new library, then the tried
  //    changes. Written over the old state (writeTasteState compares).
  let next = stateFromRows({
    mode: state.mode,
    profile: { ...row, genre_weights: weights, rejected_genres: rejected, popularity_tiers: null },
    settings,
    allowedRows: state.allowed,
  });
  next = withMode(next, state.mode, library);
  const r = ops.length ? applyOps(next, ops) : { state: next, applied: [], dropped: [], notes: [] };

  // The change-log row goes in BEFORE the profile is replaced, and must: it's
  // what stops the owner's undo from reaching an older change (made on the
  // old profile) and restoring it over the new one.
  const what = String(body.summary_he || '').trim();
  const summary = `[admin · Ami's bench] re-onboarding — the previous profile is archived (#${archiveId})${what ? ` · ${what}` : ''}`.slice(0, 300);
  try {
    await pgrInsert('business_taste_changes', {
      business_id: id, delivery_mode: r.state.mode, ops: [{ op: 'reonboard', archive_id: archiveId }, ...r.applied],
      summary_he: summary, before: snapshotOf(state), after: snapshotOf(r.state), message_id: null, source: 'admin',
    });
  } catch (e) {
    console.error('[internal taste-bench] change log failed:', e.message);
    return res.status(500).json({ error: `the change log could not be written, so nothing was replaced (${e.message}); the archive row #${archiveId} stays`, code: 'log-failed' });
  }

  await upsertTasteProfileRow(row);
  await writeTasteState(id, state, r.state);

  await logAdminAction(id, 'taste:reonboard', { archive_id: archiveId, ops: r.applied, dropped: r.dropped, notes: r.notes, summary });
  return res.status(200).json({ ok: true, replaced: true, archive_id: archiveId, applied: r.applied, dropped: r.dropped, notes: r.notes });
}
