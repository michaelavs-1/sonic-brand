/* /api/v7/account/taste-apply.js
   Applies what the v7 taste chat proposed, once the owner confirmed it.

     POST { businessId, action: 'apply', messageId }
       messageId = the assistant row (business_direction_chats) carrying the
       proposal. The ops are read from that row — never from the client — and
       run again on the business's CURRENT state (v7/generation/taste-ops.js),
       so anything that no longer fits is dropped. Writes the result
       (_taste-state.js), logs the before/after state to
       business_taste_changes, marks the row applied, and emails Roni about
       every song the owner added that we haven't analysed yet. A proposal
       whose only op is "undo" reverts the newest change instead.
       → { ok, summary_he, replace, notes }   replace = the "replace today's
         playlists now?" status (same as the Profile tab's)

     POST { businessId, action: 'reject', genres: [...] }
       The genre deck's "לא בשבילי": the genres are recorded as turned down
       (never offered again) right away, with no confirmation and no log.
       → { ok }

   Needs migration 2026-10-13-v7-taste-chat.sql. */

import { pgrSelect, pgrInsert, pgrPatch } from '../../v5/supabase-client.js';
import { setCors }              from '../../v6/origin-guard.js';
import { guard }                from '../../v6/ratelimit.js';
import { sendAlert }            from '../../_alert.js';
import { verifyUser, readHours } from './_settings-helpers.js';
import { ownedBusiness } from './_special-events.js';
import { subscriptionEnded, SUBSCRIPTION_ENDED_MESSAGE } from './_subscription.js';
import { readTasteState, writeTasteState } from './_taste-state.js';
import { replaceStatus } from './_replace-status.js';
import { applyOps, snapshotOf, stateFromSnapshot } from '../../../v7/generation/taste-ops.js';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MIGRATION_HINT = 'run migration 2026-10-13-v7-taste-chat.sql';

// The newest change the owner may undo — null when there's none, or when the
// newest change was made in the admin console (source 'admin', migration
// 2026-10-13-admin-console.sql): undo restores a whole snapshot, so undoing an
// older chat change would also wipe out the admin's newer one.
async function lastChange(businessId) {
  const rows = await pgrSelect('business_taste_changes', { business_id: `eq.${businessId}`, undone_at: 'is.null' },
    { select: '*', order: 'applied_at.desc', limit: 1, useService: true });
  const last = rows?.[0] || null;
  return last && last.source !== 'admin' ? last : null;
}

// The email to Roni for each added song we haven't analysed (it plays as
// though it were inside the energy range until the batch worker analyses it).
async function emailUnanalysed(biz, tracks) {
  if (!tracks.length) return;
  const lines = [
    `העסק: ${biz.name || '—'} (${biz.id})`,
    '',
    'שירים שבעל העסק הוסיף בצ\'אט "הטעם המוזיקלי שלכם" ועדיין לא נותחו:',
    ...tracks.map((t) => `- "${t.title}" — ${t.artist} · https://open.spotify.com/track/${t.spotify_id} · ז'אנר: ${t.genre}`),
    '',
    'הם מתנגנים רק בפלייליסטים של העסק הזה, כאילו הם בטווח האנרגיה, עד שינותחו.',
  ];
  await sendAlert({ subject: `[Rubin] ${tracks.length === 1 ? 'שיר חדש' : `${tracks.length} שירים חדשים`} לניתוח — ${biz.name || biz.id}`, text: lines.join('\n') });
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-taste-apply', 20, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, action, messageId, genres } = req.body || {};
    let biz;
    try { biz = await ownedBusiness(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }
    if (await subscriptionEnded(businessId)) {
      return res.status(402).json({ code: 'subscription_ended', error: SUBSCRIPTION_ENDED_MESSAGE });
    }

    const loaded = await readTasteState(businessId);
    if (!loaded) return res.status(409).json({ code: 'not-ready', error: 'הפלייליסטים שלכם עוד לא הוגדרו.' });
    const { state } = loaded;

    // ---- deck dislikes ----
    if (action === 'reject') {
      const ops = (Array.isArray(genres) ? genres : []).slice(0, 10).map((g) => ({ op: 'reject_genre', genre: g }));
      const r = applyOps(state, ops);
      if (r.changed) await writeTasteState(businessId, state, r.state);
      return res.status(200).json({ ok: true });
    }
    if (action !== 'apply' || !messageId) return res.status(400).json({ error: 'action "apply" + messageId, or "reject" + genres' });

    const rows = await pgrSelect('business_direction_chats',
      { id: `eq.${messageId}`, business_id: `eq.${businessId}`, role: 'eq.assistant' },
      { select: 'id,proposal', limit: 1, useService: true });
    const p = rows?.[0]?.proposal;
    if (p?.kind !== 'taste' || !Array.isArray(p.ops) || !p.ops.length) return res.status(400).json({ error: 'no proposal on that message' });
    if (p.applied_at) return res.status(409).json({ code: 'already-applied', error: 'השינוי הזה כבר הוחל.' });
    const markApplied = () => pgrPatch('business_direction_chats', { id: `eq.${messageId}` },
      { proposal: { ...p, applied_at: new Date().toISOString() } });
    const hours = await readHours(businessId).catch(() => null);
    const replace = async () => (hours ? replaceStatus({ businessId, hours }).catch(() => null) : null);

    // ---- undo ----
    if (p.ops.length === 1 && p.ops[0].op === 'undo') {
      const last = await lastChange(businessId).catch((e) => { throw new Error(`${e.message} — ${MIGRATION_HINT}`); });
      if (!last) return res.status(409).json({ code: 'nothing-to-undo', error: 'אין שינוי לבטל.' });
      let target = stateFromSnapshot(state, last.before);
      // A change made under the other playlist type: restore the profile, keep
      // this type's current recipes (they were rebuilt at the switch).
      if (last.delivery_mode !== state.mode) target = { ...target, option1Dirs: state.option1Dirs, levelDirs: state.levelDirs };
      target = applyOps(target, []).state;   // recipes consistent with the restored profile
      await writeTasteState(businessId, state, target);
      await pgrPatch('business_taste_changes', { id: `eq.${last.id}` }, { undone_at: new Date().toISOString() });
      await markApplied();
      return res.status(200).json({ ok: true, undone: true, summary_he: last.summary_he || '', replace: await replace() });
    }

    // ---- apply ----
    const linked = new Map((Array.isArray(p.linked) ? p.linked : []).filter((t) => t?.spotify_id).map((t) => [t.spotify_id, t]));
    const r = applyOps(state, p.ops, { linkedTracks: linked });
    if (r.dropped.length) console.warn(`[v7 taste-apply] biz=${businessId} dropped at apply: ${JSON.stringify(r.dropped)}`);
    if (!r.changed) return res.status(409).json({ code: 'nothing-to-change', error: 'השינוי הזה כבר קיים.' });

    await writeTasteState(businessId, state, r.state);
    try {
      await pgrInsert('business_taste_changes', {
        business_id: businessId, delivery_mode: state.mode, ops: r.applied, summary_he: p.summary_he || null,
        before: snapshotOf(state), after: snapshotOf(r.state), message_id: messageId,
      });
    } catch (e) {
      console.error(`[v7 taste-apply] change log write failed (${MIGRATION_HINT}?):`, e.message);
    }
    await markApplied();

    const unanalysed = r.allowedAdded
      .map((id) => ({ ...linked.get(id), genre: r.state.allowed.find((a) => a.spotify_id === id)?.genre }))
      .filter((t) => t && !t.analyzed);
    await emailUnanalysed(biz, unanalysed).catch((e) => console.warn('[v7 taste-apply] email failed:', e.message));

    return res.status(200).json({ ok: true, summary_he: p.summary_he || '', notes: r.notes, replace: await replace() });
  } catch (err) {
    console.error('[v7 taste-apply] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
