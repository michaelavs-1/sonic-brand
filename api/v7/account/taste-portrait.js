/* /api/v7/account/taste-portrait.js
   Keeps the owner's musical portrait (2026-10-21; see _taste-portrait.js and
   v7/generation/taste-portrait-prompt.js). The dashboard calls it in the
   background, so the taste chat never waits for it:

   - action 'chat' — after a "success" in the taste chat: the chat and the
     owner understood each other and the chat offered the confirm button (an
     assistant message whose proposal has ops). The portrait is rewritten
     from the messages that led to it: this session's messages since the
     previous success (or the session start) up to that message.
   - action 'init' — on the dashboard's load: writes the first version from
     the onboarding answers when the business has none yet.

   Request:  { businessId, action: 'chat', messageId, sessionStartAt }
           | { businessId, action: 'init' }
   Response: { ok, portrait_he? , skipped? }
   Needs migration 2026-10-21-v7-taste-portraits.sql. */

import { pgrSelect } from '../../v5/supabase-client.js';
import { setCors }   from '../../v6/origin-guard.js';
import { guard }     from '../../v6/ratelimit.js';
import { verifyUser } from './_settings-helpers.js';
import { ownedBusiness, selfOrigin } from './_special-events.js';
import { acquireBuildLock } from './_build-lock.js';
import { latestPortrait, writePortrait } from './_taste-portrait.js';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MESSAGE_LIMIT = 40;

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-taste-portrait', 30, 3600)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const { businessId, action, messageId, sessionStartAt } = req.body || {};
    if (!UUID_RE.test(String(businessId || ''))) return res.status(400).json({ error: 'businessId required' });
    if (action !== 'chat' && action !== 'init') return res.status(400).json({ error: "action must be 'chat' or 'init'" });
    try { await ownedBusiness(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const current = await latestPortrait(businessId);
    if (action === 'init' && current) return res.status(200).json({ ok: true, skipped: 'exists' });

    // One rewrite at a time per business. A success that loses the race isn't
    // lost: the next one covers its messages (they're after the last version).
    const lock = await acquireBuildLock(`portrait:${businessId}`, 90);
    if (!lock.acquired) return res.status(200).json({ ok: true, skipped: 'busy' });
    try {
      const origin = selfOrigin(req);
      if (action === 'init') {
        const out = await writePortrait({ businessId, origin, source: 'onboarding', withOnboarding: true });
        if (out.error) return res.status(502).json({ error: out.error });
        return res.status(200).json({ ok: true, portrait_he: out.portrait_he });
      }

      // ---- 'chat': the success message ----
      if (!UUID_RE.test(String(messageId || ''))) return res.status(400).json({ error: 'messageId required' });
      const msgRows = await pgrSelect('business_direction_chats',
        { id: `eq.${messageId}`, business_id: `eq.${businessId}` },
        { select: 'id,role,proposal,created_at', limit: 1, useService: true });
      const msg = msgRows?.[0];
      if (!msg || msg.role !== 'assistant' || msg.proposal?.kind !== 'taste' || !msg.proposal?.ops?.length) {
        return res.status(200).json({ ok: true, skipped: 'not-a-success' });
      }
      if (current?.message_id === messageId) return res.status(200).json({ ok: true, skipped: 'done' });

      // The messages that led to it: since the session start, or since the
      // previous version if that's later.
      const session = (typeof sessionStartAt === 'string' && !Number.isNaN(Date.parse(sessionStartAt))) ? sessionStartAt : msg.created_at;
      const from = current && Date.parse(current.created_at) > Date.parse(session) ? current.created_at : session;
      const rows = await pgrSelect('business_direction_chats',
        { business_id: `eq.${businessId}`, and: `(created_at.gte.${from},created_at.lte.${msg.created_at})` },
        { select: 'id,role,content,created_at', order: 'created_at.asc', limit: MESSAGE_LIMIT, useService: true });

      const out = await writePortrait({
        businessId, origin, source: 'chat', transcriptRows: rows || [],
        agreedChange: msg.proposal.summary_he || null, messageId,
      });
      if (out.error) return res.status(502).json({ error: out.error });
      return res.status(200).json({ ok: true, portrait_he: out.portrait_he });
    } finally {
      try { await lock.release(); } catch { /* expires on its own */ }
    }
  } catch (err) {
    console.error('[v7 taste-portrait] error:', err);
    return res.status(500).json({ error: err.message || 'internal error' });
  }
}
