/* /api/v7/account/event-chat.js
   One turn of the v7 special-playlists chat on /v7/account.

   v7 copy of api/v6/account/event-chat.js (same auth, ownership, rate limit,
   persistence to business_event_chats, session-filtered history). What's new:
   - the v7 prompt (v7/generation/event-chat-prompt.js): today-only playlists,
     the 2-per-day cap, and the "same styles as your daily playlists?" question;
   - a per-turn "## Today" block (IL date + time, the 04:00 deadline, how many
     special playlists were made today) appended to the system prompt;
   - proposed.genre_source ('event' | 'daily') passed through to the client.

   Request:  { businessId, message, sessionStartAt }
   Response: { ok: true, userMessage, assistantMessage }
               assistantMessage.parsed = { reply_he, state, proposed? }
               proposed = { name_he, description_he, genre_source } */

import { pgrSelect, pgrInsert } from '../../v5/supabase-client.js';
import { setCors }              from '../../v6/origin-guard.js';
import { guard }                from '../../v6/ratelimit.js';
import { verifyUser }           from './_settings-helpers.js';
import { ownedBusiness, eventsMadeToday, selfOrigin, parseModelJson, geminiText } from './_special-events.js';
import { EVENT_CHAT_SYSTEM_PROMPT, buildEventChatContext } from '../../../v7/generation/event-chat-prompt.js';
import { ilPartsFromDate, nextIl4amIso } from '../../../v7/generation/playlist-length.js';

const SERVICE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Low thinking keeps the chat snappy (same as v6's).
const GEMINI_MODEL      = 'gemini-3.6-flash';
const GEMINI_THINKING   = 'low';
const GEMINI_MAX_TOKENS = 1500;

const MESSAGE_TAIL_LIMIT = 40;
const GENRE_SOURCES = new Set(['event', 'daily']);

// Assistant rows store the raw model JSON; replay it verbatim.
function historyFromMessages(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    text: m.content || '',
  }));
}

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
      label:             'v7-event-chat',
      business_id:       businessId || null,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`gemini ${r.status}: ${data?.error?.message || data?.error || 'proxy failed'}`);
  const raw = geminiText(data);
  return { raw, parsed: parseModelJson(raw) };
}

function normalizeReply(parsed) {
  const reply_he = typeof parsed?.reply_he === 'string' ? parsed.reply_he : '';
  const state    = typeof parsed?.state    === 'string' ? parsed.state    : 'gathering';
  let proposal   = null;
  const p = parsed?.proposed;
  if (state === 'confirming' && p && typeof p.name_he === 'string' && typeof p.description_he === 'string'
      && p.description_he.trim().length >= 5) {
    proposal = {
      name_he:        String(p.name_he).trim().slice(0, 40),
      description_he: String(p.description_he).trim().slice(0, 4000),
      genre_source:   GENRE_SOURCES.has(p.genre_source) ? p.genre_source : 'event',
    };
  }
  return { reply_he, state, proposal };
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-event-chat', 20, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, message, sessionStartAt } = req.body || {};
    const text = String(message || '').trim();
    if (!businessId || !text) return res.status(400).json({ error: 'businessId and message required' });
    if (text.length > 2000)   return res.status(400).json({ error: 'message too long' });
    let biz;
    try { biz = await ownedBusiness(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Missing / malformed sessionStartAt → fresh session, no history.
    const sessionStartClause = (typeof sessionStartAt === 'string' && sessionStartAt.length && !Number.isNaN(Date.parse(sessionStartAt)))
      ? { created_at: `gte.${sessionStartAt}` }
      : { created_at: `gte.${new Date().toISOString()}` };

    // 1. Persist the user's message first.
    const insertedUser = await pgrInsert('business_event_chats', {
      business_id: businessId,
      role:        'user',
      content:     text,
    }, { returnRows: true });
    const userRow = Array.isArray(insertedUser) ? insertedUser[0] : insertedUser;

    // 2. Session tail (minus the just-inserted turn) + today's context.
    const [tailMessages, madeToday] = await Promise.all([
      pgrSelect('business_event_chats',
        { business_id: `eq.${businessId}`, ...sessionStartClause },
        { select: 'id,role,content,created_at', order: 'created_at.desc', limit: MESSAGE_TAIL_LIMIT, useService: true }),
      eventsMadeToday(businessId),
    ]);
    const historyMessages = (tailMessages || [])
      .filter((m) => m.id !== userRow.id)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const now = new Date();
    const system = EVENT_CHAT_SYSTEM_PROMPT + buildEventChatContext({
      businessName: biz.name || '',
      now:          ilPartsFromDate(now),
      deadline:     ilPartsFromDate(new Date(nextIl4amIso({ now }))),
      madeToday,
    });

    // 3. Gemini. On failure persist a fallback turn so the transcript stays coherent.
    let rawText, parsed;
    try {
      const out = await callGemini(selfOrigin(req), system, historyFromMessages(historyMessages), text, businessId);
      rawText = out.raw;
      parsed  = out.parsed;
    } catch (err) {
      console.error('[v7 event-chat] gemini call failed:', err.message);
      const fallback = { reply_he: 'משהו השתבש. תוכלו לנסח שוב?', state: 'gathering' };
      const inserted = await pgrInsert('business_event_chats', {
        business_id: businessId,
        role:        'assistant',
        content:     JSON.stringify(fallback),
        proposal:    null,
      }, { returnRows: true });
      const assistantRow = Array.isArray(inserted) ? inserted[0] : inserted;
      return res.status(200).json({ ok: true, userMessage: userRow, assistantMessage: { ...assistantRow, parsed: fallback } });
    }

    const normalized = normalizeReply(parsed);

    // 4. Persist the assistant reply (raw JSON + the structured proposal).
    const insertedAssistant = await pgrInsert('business_event_chats', {
      business_id: businessId,
      role:        'assistant',
      content:     typeof rawText === 'string' ? rawText : JSON.stringify(parsed),
      proposal:    normalized.proposal,
    }, { returnRows: true });
    const assistantRow = Array.isArray(insertedAssistant) ? insertedAssistant[0] : insertedAssistant;

    return res.status(200).json({
      ok:               true,
      userMessage:      userRow,
      assistantMessage: {
        ...assistantRow,
        parsed: { reply_he: normalized.reply_he, state: normalized.state, proposed: normalized.proposal || undefined },
      },
    });
  } catch (err) {
    console.error('[v7 event-chat] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
