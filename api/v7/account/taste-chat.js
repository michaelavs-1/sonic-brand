/* /api/v7/account/taste-chat.js
   One turn of the v7 taste chat ("הטעם המוזיקלי שלכם", the Home tab).

   The owner says what they think of their daily music; the model (prompt:
   v7/generation/taste-chat-prompt.js) answers and, when it knows what to
   change, proposes a list of ops (v7/generation/taste-ops.js). Nothing is
   applied here — the owner confirms in the dashboard, which calls
   taste-apply.js. Every proposal is dry-run against the business's current
   state before it's returned: ops that don't fit are dropped, and a proposal
   left with nothing to apply comes back as a normal message.

   Each turn the server also:
   - reads every Spotify link in the message (_spotify-links.js) and keeps the
     songs it found on the assistant row (proposal.linked), so a later
     "allow this song" in the same conversation can be checked;
   - builds the context (_taste-context.js): the time now, the profile, the
     recipes, what played, today's playlists, the curve, the change log.

   Messages are persisted to business_direction_chats (v6's direction-chat
   log — v7 has no business_directions, so the table is free; the admin API
   already shows it). Same session model as the special-playlists chat:
   sessionStartAt gates what the model sees.

   Request:  { businessId, message, sessionStartAt }
   Response: { ok, userMessage, assistantMessage }
               assistantMessage.parsed = { reply_he, state, proposal?, suggestions?,
                                           timeline_hint?, offer_new_mix?, new_genres? }
   Needs migration 2026-10-13-v7-taste-chat.sql. */

import { pgrSelect, pgrInsert } from '../../v5/supabase-client.js';
import { setCors }              from '../../v6/origin-guard.js';
import { guard }                from '../../v6/ratelimit.js';
import { verifyUser, readHours } from './_settings-helpers.js';
import { ownedBusiness, selfOrigin, parseModelJson, geminiText } from './_special-events.js';
import { subscriptionEnded, SUBSCRIPTION_ENDED_MESSAGE } from './_subscription.js';
import { readTasteState } from './_taste-state.js';
import { buildTasteContext } from './_taste-context.js';
import { findSpotifyLinks, resolveSongLink } from './_spotify-links.js';
import { buildTasteChatSystemPrompt, formatTasteContext, normalizeTasteReply } from '../../../v7/generation/taste-chat-prompt.js';
import { applyOps, canonicalGenre } from '../../../v7/generation/taste-ops.js';

const SERVICE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Medium thinking: the chat places genres by the coherence rules and works
// out what dominates, which low thinking did poorly in v6's chat. Thinking
// tokens count against the output cap.
const GEMINI_MODEL      = 'gemini-3.6-flash';
const GEMINI_THINKING   = 'medium';
const GEMINI_MAX_TOKENS = 12000;
const MESSAGE_TAIL_LIMIT = 40;
export const COULD_NOT_PREPARE = 'לא הצלחתי להכין את השינוי הזה. תוכלו לנסח שוב, במילים קצת אחרות?';

const historyFromMessages = (messages) => messages.map((m) => ({
  role: m.role === 'assistant' ? 'model' : 'user',
  text: m.content || '',
}));

async function callGemini(origin, system, history, currentUserText, businessId) {
  const r = await fetch(`${origin}/api/v6/gemini`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_API_KEY },
    body: JSON.stringify({
      model:             GEMINI_MODEL,
      max_output_tokens: GEMINI_MAX_TOKENS,
      thinking_level:    GEMINI_THINKING,
      system,
      user:              currentUserText,
      history,
      label:             'v7-taste-chat',
      business_id:       businessId || null,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`gemini ${r.status}: ${data?.error?.message || data?.error || 'proxy failed'}`);
  const raw = geminiText(data);
  return { raw, parsed: parseModelJson(raw) };
}

// The compact form of a linked song kept on the assistant row.
const keepLinked = (t) => (t.spotify_id
  ? { spotify_id: t.spotify_id, title: t.title, artist: t.artist, duration_sec: t.duration_sec ?? null,
      catalog_genres: t.catalog_genres || [], energy: t.energy ?? null, analyzed: !!t.analyzed }
  : null);

// Check a normalized reply against the state. Mutates `reply`.
//   proposal → only the ops that apply (+ new_genres for the sample step);
//   suggestions → only catalog genres that aren't approved or turned down.
export function vetReply(reply, state, { linkedTracks, hasUndoable }) {
  const notes = [];
  if (reply.proposal) {
    const ops = reply.proposal.ops;
    if (ops.some((o) => o.op === 'undo')) {
      if (hasUndoable) reply.proposal.ops = [{ op: 'undo' }];
      else { notes.push('undo with nothing to undo'); reply.proposal = null; }
    } else {
      const dry = applyOps(state, ops, { linkedTracks });
      if (dry.dropped.length) notes.push(`dropped: ${JSON.stringify(dry.dropped)}`);
      if (!dry.applied.length || !dry.changed) reply.proposal = null;
      else {
        const approvedBefore = new Set(state.approved.map((a) => a.genre));
        reply.proposal.ops = dry.applied;
        reply.proposal.new_genres = [...new Set(dry.applied
          .filter((o) => o.op === 'add_genre' || o.op === 'set_requested')
          .map((o) => canonicalGenre(o.genre))
          .filter((g) => g && !approvedBefore.has(g)))];
      }
    }
    if (!reply.proposal) { reply.state = 'gathering'; reply.reply_he = COULD_NOT_PREPARE; }
  }
  if (reply.suggestions) {
    const approved = new Set(state.approved.map((a) => a.genre));
    const seen = new Set();
    reply.suggestions = reply.suggestions
      .map((x) => ({ ...x, genre: canonicalGenre(x.genre) }))
      .filter((x) => x.genre && !approved.has(x.genre) && !state.rejected.includes(x.genre) && !seen.has(x.genre) && seen.add(x.genre))
      .map((x) => ({ ...x, energy_level: Math.min(state.N, Math.max(1, x.energy_level || Math.ceil(state.N / 2))), label_he: x.label_he || x.genre }));
    if (!reply.suggestions.length) { notes.push('no usable suggestions'); reply.suggestions = null; reply.state = 'gathering'; }
  }
  return notes;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-taste-chat', 20, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, message, sessionStartAt } = req.body || {};
    const text = String(message || '').trim();
    if (!businessId || !text) return res.status(400).json({ error: 'businessId and message required' });
    if (text.length > 2000) return res.status(400).json({ error: 'message too long' });
    try { await ownedBusiness(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }
    if (await subscriptionEnded(businessId)) {
      return res.status(402).json({ code: 'subscription_ended', error: SUBSCRIPTION_ENDED_MESSAGE });
    }

    const [loaded, bizRows, hours] = await Promise.all([
      readTasteState(businessId),
      pgrSelect('businesses', { id: `eq.${businessId}` }, { select: 'name,business_description,musical_emphases', limit: 1, useService: true }),
      readHours(businessId).catch(() => null),
    ]);
    if (!loaded) {
      return res.status(409).json({ code: 'not-ready', error: 'הפלייליסטים שלכם עוד לא הוגדרו. בחרו סוג פלייליסטים יומיים ונסו שוב.' });
    }
    const { state, settings } = loaded;

    const sessionStart = (typeof sessionStartAt === 'string' && !Number.isNaN(Date.parse(sessionStartAt)))
      ? sessionStartAt : new Date().toISOString();

    // 1. Persist the user's message first.
    const insertedUser = await pgrInsert('business_direction_chats',
      { business_id: businessId, role: 'user', content: text }, { returnRows: true });
    const userRow = Array.isArray(insertedUser) ? insertedUser[0] : insertedUser;

    // 2. Session tail, this message's links, the context.
    const origin = selfOrigin(req);
    const [tail, resolved] = await Promise.all([
      pgrSelect('business_direction_chats', { business_id: `eq.${businessId}`, created_at: `gte.${sessionStart}` },
        { select: 'id,role,content,proposal,created_at', order: 'created_at.desc', limit: MESSAGE_TAIL_LIMIT, useService: true }),
      Promise.all(findSpotifyLinks(text).map((l) => resolveSongLink(l, { origin }).catch(() => ({ link: l, error: 'unreadable' })))),
    ]);
    const history = (tail || []).filter((m) => m.id !== userRow.id)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const known = new Map();
    for (const m of history) for (const t of m.proposal?.linked || []) if (t?.spotify_id) known.set(t.spotify_id, t);
    for (const t of resolved) if (t.spotify_id) known.set(t.spotify_id, keepLinked(t));
    const linkedForContext = [...resolved.filter((t) => t.error), ...known.values()];

    const now = new Date();
    const ctx = await buildTasteContext({
      businessId, biz: bizRows?.[0] || null, state, settings, hours, linked: linkedForContext, now, origin,
    });
    const system = buildTasteChatSystemPrompt(state.mode) + formatTasteContext(ctx);
    const hasUndoable = (ctx.changes || []).some((c) => !c.undone);

    // 3. The model. On failure persist a fallback turn so the transcript stays coherent.
    const linkedRow = [...known.values()];
    let rawText, reply;
    try {
      const out = await callGemini(origin, system, historyFromMessages(history), text, businessId);
      rawText = out.raw;
      reply = normalizeTasteReply(out.parsed, { mode: state.mode });
    } catch (err) {
      console.error('[v7 taste-chat] gemini call failed:', err.message);
      const fallback = { reply_he: 'משהו השתבש. תוכלו לנסח שוב?', state: 'gathering' };
      const inserted = await pgrInsert('business_direction_chats', {
        business_id: businessId, role: 'assistant', content: JSON.stringify(fallback), proposal: { kind: 'taste', linked: linkedRow },
      }, { returnRows: true });
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      return res.status(200).json({ ok: true, userMessage: userRow, assistantMessage: { ...row, parsed: fallback } });
    }

    const notes = vetReply(reply, state, { linkedTracks: known, hasUndoable });
    if (notes.length) console.warn(`[v7 taste-chat] biz=${businessId}: ${notes.join(' | ')}`);

    // 4. Persist the assistant reply (raw JSON + the vetted payload).
    const payload = {
      kind: 'taste',
      state: reply.state,
      summary_he: reply.proposal?.summary_he || null,
      ops: reply.proposal?.ops || null,
      new_genres: reply.proposal?.new_genres || null,
      suggestions: reply.suggestions,
      timeline_hint: reply.timeline_hint,
      offer_new_mix: reply.offer_new_mix || false,
      linked: linkedRow,
      notes: notes.length ? notes : undefined,
    };
    const insertedAssistant = await pgrInsert('business_direction_chats', {
      business_id: businessId, role: 'assistant',
      content: typeof rawText === 'string' ? rawText : JSON.stringify(reply),
      proposal: payload,
    }, { returnRows: true });
    const assistantRow = Array.isArray(insertedAssistant) ? insertedAssistant[0] : insertedAssistant;

    return res.status(200).json({
      ok: true,
      userMessage: userRow,
      assistantMessage: {
        id: assistantRow.id,
        created_at: assistantRow.created_at,
        parsed: {
          reply_he: reply.reply_he,
          state: reply.state,
          proposal: reply.proposal ? { summary_he: reply.proposal.summary_he, ops: reply.proposal.ops } : undefined,
          new_genres: reply.proposal?.new_genres?.length ? reply.proposal.new_genres : undefined,
          suggestions: reply.suggestions || undefined,
          timeline_hint: reply.timeline_hint || undefined,
          offer_new_mix: reply.offer_new_mix || undefined,
        },
      },
    });
  } catch (err) {
    console.error('[v7 taste-chat] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
