/* /api/internal/directions — the admin console's direction editor (item 10 of
   Michael's list, 2026-10-13).

   GET ?id=<business_uuid>
     → { business_id, mode, N, editable, directions, approved_by_level,
         option1, option2, option2_matches_profile, energy_windows,
         genre_catalog, last_change }
       `directions` = the library in use (= option1 or option2 by mode); keys
       as in _library.js. editable = false until the owner has picked a
       playlist type (no library yet).

   POST { business_id, action, ... }  — edits the library IN USE (the other
   one is rebuilt from the profile when the owner switches type, so editing
   it would be lost):
     add_genre       { direction, genre, energy_level?, move? }
     remove_genre    { direction, genre }
     replace_genre   { direction, genre, with, energy_level?, move? }
     new_direction   { genres:[...], tier: 'high'|'low' (Option 1) | energy_level (Option 2), title_en? }
     delete_direction{ direction }
     undo            {}   — reverts the newest admin change, only while it is
                            also the newest change overall
     direction = a key from the latest GET ("H2", "C1", "L3-2").

   Adding a genre the owner's taste profile doesn't approve also approves it
   (Option 1: at `energy_level`, default the direction's middle level within
   its tier; Option 2: at the direction's level) — a direction can only play
   approved genres. A genre already approved in the OTHER tier / at another
   level is refused unless `move: true`, which moves it (that also takes it
   out of the recipes of its old tier / level).

   Runs the taste chat's ops (v7/generation/taste-ops.js) on the business's
   current state and writes it the same way (_taste-state.js), so the result
   is always consistent with the profile; logged in business_taste_changes
   with source 'admin' (the owner can't undo it, and their chat isn't shown
   it) + admin_actions.
   → { ok, applied, dropped, notes, warnings, directions, ... } (fresh view)

   Takes effect from the next build. Today's playlists change only with the
   daily-picks endpoint's rebuild_today.

   Auth: bearer INTERNAL_ADMIN_API_KEY (./_guard.js). */

import { pgrSelect, pgrInsert, pgrPatch } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { UUID_RE, hasServiceKey, loadBusiness, logAdminAction } from './_admin.js';
import { readLibrary } from './_library.js';
import { readTasteState, writeTasteState } from '../v7/account/_taste-state.js';
import { applyOps, snapshotOf, stateFromSnapshot, canonicalGenre } from '../../v7/generation/taste-ops.js';
import { tierOfLevel } from '../../v7/generation/option1-draw.js';
import { GENRES } from '../../shared/genre-universe.js';

const ACTIONS = new Set(['add_genre', 'remove_genre', 'replace_genre', 'new_direction', 'delete_direction', 'undo']);

async function view(businessId) {
  const lib = await readLibrary(businessId);
  const directions = lib.mode === 'option2' ? lib.option2 : lib.mode === 'option1' ? lib.option1 : [];
  return {
    business_id: businessId,
    mode: lib.mode,
    N: lib.N,
    editable: !!(lib.profile && lib.mode),
    directions,
    approved_by_level: lib.approved_by_level,
    option1: lib.option1,
    option2: lib.option2,
    option2_matches_profile: lib.option2_matches_profile,
    energy_windows: lib.energy_windows,
  };
}

async function newestChange(businessId) {
  const rows = await pgrSelect('business_taste_changes', { business_id: `eq.${businessId}`, undone_at: 'is.null' },
    { select: '*', order: 'applied_at.desc', limit: 1, useService: true }).catch(() => []);
  return rows?.[0] || null;
}

// Where an added genre should sit in the profile, as ops to run before
// dir_add. → { ops, error }
function placeGenre(state, dir, genre, { energy_level, move }) {
  const have = state.approved.find((a) => a.genre === genre);
  if (state.mode === 'option2') {
    if (!have) return { ops: [{ op: 'add_genre', genre, energy_level: dir.energy_level }] };
    if (have.energy_level === dir.energy_level) return { ops: [] };
    if (!move) return { error: `${genre} is approved at energy level ${have.energy_level}, not ${dir.energy_level} — pass move:true to move it (it then leaves the level-${have.energy_level} directions)` };
    return { ops: [{ op: 'move_genre', genre, energy_level: dir.energy_level }] };
  }
  const tier = dir.energy_tier;
  const levelsOfTier = Array.from({ length: state.N }, (_, i) => i + 1).filter((L) => tierOfLevel(L, state.N) === tier);
  let L = Number(energy_level);
  if (energy_level != null && (!Number.isInteger(L) || !levelsOfTier.includes(L))) {
    return { error: `energy_level must be one of ${levelsOfTier.join(', ')} for a ${tier}-energy direction` };
  }
  if (energy_level == null) {
    // The direction's own genres' middle level, else the tier's middle level.
    const lv = dir.genres.map((g) => state.approved.find((a) => a.genre === g)?.energy_level).filter(Boolean).sort((a, b) => a - b);
    L = lv.length ? lv[Math.floor((lv.length - 1) / 2)] : levelsOfTier[Math.floor((levelsOfTier.length - 1) / 2)];
  }
  if (!have) return { ops: [{ op: 'add_genre', genre, energy_level: L }] };
  if (tierOfLevel(have.energy_level, state.N) === tier) return { ops: [] };
  if (!move) return { error: `${genre} is approved in the ${tier === 'high' ? 'calm' : 'high'}-energy tier — pass move:true to move it (it then leaves that tier's directions)` };
  return { ops: [{ op: 'move_genre', genre, energy_level: L }] };
}

// The request → taste ops. → { ops, error, warnings }
function opsFor(state, body) {
  const lib = state.mode === 'option2' ? state.levelDirs : state.option1Dirs;
  const key = String(body.direction || '').trim().toUpperCase();
  const dir = lib.find((d) => d.key === key);
  const needDir = ['add_genre', 'remove_genre', 'replace_genre', 'delete_direction'].includes(body.action);
  if (needDir && !dir) return { error: `no direction "${body.direction}" — use a key from the latest GET (${lib.map((d) => d.key).join(', ') || 'none'})` };
  const warnings = [];
  const requestedNote = (g) => (state.mode === 'option1' && state.requested.includes(g)
    ? [`${g} is a requested genre: every Option 1 playlist of its tier gets it at build time, whatever its directions hold`] : []);

  switch (body.action) {
    case 'add_genre': {
      const g = canonicalGenre(body.genre);
      if (!g) return { error: `"${body.genre}" is not a genre from the catalog` };
      if (dir.genres.includes(g)) return { error: `${g} is already in ${dir.key}` };
      const placed = placeGenre(state, dir, g, body);
      if (placed.error) return { error: placed.error };
      return { ops: [...placed.ops, { op: 'dir_add', dir: dir.key, genre: g }], warnings };
    }
    case 'remove_genre': {
      const g = canonicalGenre(body.genre);
      if (!g || !dir.genres.includes(g)) return { error: `${body.genre} is not in ${dir.key}` };
      if (dir.genres.length === 1) warnings.push(`${dir.key} had only ${g}, so the direction is removed`);
      return { ops: [{ op: 'dir_remove', dir: dir.key, genre: g }], warnings: [...warnings, ...requestedNote(g)] };
    }
    case 'replace_genre': {
      const out = canonicalGenre(body.genre);
      const inn = canonicalGenre(body.with);
      if (!out || !dir.genres.includes(out)) return { error: `${body.genre} is not in ${dir.key}` };
      if (!inn) return { error: `"${body.with}" is not a genre from the catalog` };
      if (dir.genres.includes(inn)) return { error: `${inn} is already in ${dir.key}` };
      const placed = placeGenre(state, dir, inn, body);
      if (placed.error) return { error: placed.error };
      // Remove first: the pairing-rule check on dir_add then sees the recipe
      // without the genre being replaced.
      return { ops: [...placed.ops, { op: 'dir_remove', dir: dir.key, genre: out }, { op: 'dir_add', dir: dir.key, genre: inn }], warnings: requestedNote(out) };
    }
    case 'new_direction': {
      const genres = [...new Set((Array.isArray(body.genres) ? body.genres : []).map(canonicalGenre).filter(Boolean))];
      if (!genres.length) return { error: 'genres: a list of catalog genres' };
      const missing = genres.filter((g) => !state.approved.some((a) => a.genre === g));
      if (missing.length) return { error: `not approved for this business: ${missing.join(', ')} — create the direction with approved genres, then add_genre the rest` };
      if (state.mode === 'option2') {
        return { ops: [{ op: 'dir_new', energy_level: Number(body.energy_level), genres, title_en: body.title_en || genres.join(' + ') }] };
      }
      return { ops: [{ op: 'dir_new', tier: body.tier, genres, title_en: body.title_en || genres.join(' + ') }] };
    }
    case 'delete_direction': {
      const same = lib.filter((d) => (state.mode === 'option2' ? d.energy_level === dir.energy_level : d.energy_tier === dir.energy_tier));
      if (same.length === 1) warnings.push(state.mode === 'option2'
        ? `${dir.key} was the only direction at level ${dir.energy_level}: that level now plays all its genres together`
        : `${dir.key} was the last ${dir.energy_tier} direction: a new one with all the tier's genres takes its place`);
      return { ops: [{ op: 'dir_delete', dir: dir.key }], warnings };
    }
    default:
      return { error: 'unknown action' };
  }
}

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

    if (req.method === 'GET') {
      const v = await view(id);
      return res.status(200).json({ ...v, genre_catalog: GENRES, last_change: await newestChange(id) });
    }

    if (!ACTIONS.has(body.action)) return res.status(400).json({ error: `action must be one of ${[...ACTIONS].join(', ')}` });
    const loaded = await readTasteState(id);
    if (!loaded) return res.status(409).json({ error: 'no taste profile or no playlist type picked yet — nothing to edit', code: 'not-ready' });
    const { state } = loaded;

    // ---- undo: the newest admin change, only while nothing came after it ----
    if (body.action === 'undo') {
      const last = await newestChange(id);
      if (!last || last.source !== 'admin') {
        return res.status(409).json({ error: last ? 'the newest change was the owner\'s (taste chat) — an admin undo would wipe it out' : 'nothing to undo', code: 'nothing-to-undo' });
      }
      let target = stateFromSnapshot(state, last.before);
      if (last.delivery_mode !== state.mode) target = { ...target, option1Dirs: state.option1Dirs, levelDirs: state.levelDirs };
      target = applyOps(target, []).state;
      await writeTasteState(id, state, target);
      await pgrPatch('business_taste_changes', { id: `eq.${last.id}` }, { undone_at: new Date().toISOString() });
      await logAdminAction(id, 'direction:undo', { change_id: last.id, summary: last.summary_he });
      return res.status(200).json({ ok: true, undone: { id: last.id, summary: last.summary_he, ops: last.ops }, ...(await view(id)) });
    }

    const { ops, error, warnings = [] } = opsFor(state, body);
    if (error) return res.status(400).json({ error });
    const r = applyOps(state, ops);
    const failed = r.dropped.length ? r.dropped : null;
    if (failed) return res.status(400).json({ error: 'nothing changed', dropped: failed });
    if (!r.changed) return res.status(409).json({ error: 'nothing changed', code: 'nothing-to-change' });

    await writeTasteState(id, state, r.state);
    const summary = `[admin] ${body.action}${body.direction ? ` ${String(body.direction).toUpperCase()}` : ''}`
      + `${body.genre ? ` ${body.genre}` : ''}${body.with ? ` → ${body.with}` : ''}`
      + `${body.action === 'new_direction' ? ` ${(body.genres || []).join(', ')}` : ''}`;
    const logRow = {
      business_id: id, delivery_mode: state.mode, ops: r.applied, summary_he: summary,
      before: snapshotOf(state), after: snapshotOf(r.state), message_id: null, source: 'admin',
    };
    try {
      await pgrInsert('business_taste_changes', logRow);
    } catch (e) {
      // Before migration 2026-10-13-admin-console.sql there's no `source`
      // column: log the change anyway (it then looks like a chat change).
      if (!/source/.test(e.message || '')) console.error('[internal directions] change log failed:', e.message);
      else {
        const { source, ...rest } = logRow;
        await pgrInsert('business_taste_changes', rest).catch((e2) => console.error('[internal directions] change log failed:', e2.message));
        warnings.push('migration 2026-10-13-admin-console.sql not run: this change is logged as if the owner made it (their undo could revert it)');
      }
    }
    await logAdminAction(id, `direction:${body.action}`, {
      request: { direction: body.direction, genre: body.genre, with: body.with, genres: body.genres, tier: body.tier, energy_level: body.energy_level, move: body.move },
      ops: r.applied, notes: r.notes,
    });

    return res.status(200).json({ ok: true, applied: r.applied, notes: r.notes, warnings, ...(await view(id)) });
  } catch (err) {
    console.error('[internal directions] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
