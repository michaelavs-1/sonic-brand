/* /api/v6/account/event-chat.js
   One turn of the special-events chat on /v6/account.

   Mirror of api/v6/account/direction-chat.js — same auth + ownership +
   rate-limit + session-filtered context pattern — but scoped to the
   events flow instead of directions. Persists every message to the new
   business_event_chats table (see 2026-08-30-event-chat.sql).

   Why: pre-2026-08-30, this chat was pure client-side — chat state
   lived in-memory only, cleared on refresh, and only the finalized
   event survived in business_events. That made per-owner debugging /
   admin visibility impossible. Persistence closes the gap without
   changing the user-facing UX (the client still clears its visible
   transcript on refresh via SESSION_START_AT filtering).

   Auth: Supabase JWT + business ownership. Rate-limited 20/min per IP.

   Request body:
     { businessId, message, sessionStartAt }
   Response:
     { ok: true, userMessage, assistantMessage }
       userMessage      = { id, role:'user',       content, created_at }
       assistantMessage = { id, role:'assistant',  content, proposal|null,
                            parsed: { reply_he, state, proposed? }, created_at }
*/

import { pgrSelect, pgrInsert }   from '../../v5/supabase-client.js';
import { requireBusinessOwner }   from './_require-business-owner.js';
import { setCors }                from '../origin-guard.js';
import { guard }                  from '../ratelimit.js';
import { EVENT_CHAT_SYSTEM_PROMPT } from '../../../v6/generation/event-chat-prompt.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY || '';

// Same model choice the client had been using directly. Low thinking is
// enough for a compact confirming-state chat; the prompt is small.
const GEMINI_MODEL      = 'gemini-3.6-flash';
const GEMINI_THINKING   = 'low';
const GEMINI_MAX_TOKENS = 1500;

const MESSAGE_TAIL_LIMIT = 40;

async function verifyUser(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

// Turn tail messages into Gemini's { role, text } shape. 'assistant' →
// 'model' per Gemini's naming. For assistant rows the content column
// stores the RAW model JSON (e.g. `{"reply_he":"…","state":"gathering"}`);
// we send that verbatim so Gemini sees exactly what it produced last
// turn. User rows are plain text.
function historyFromMessages(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    text: m.content || '',
  }));
}

// Call Gemini through our own proxy (server-to-server via x-sonic-internal
// bypasses origin-guard + rate-limit). Attribution: business_id so the
// spend log rolls up correctly per business.
async function callGemini(origin, history, currentUserText, businessId) {
  const r = await fetch(`${origin}/api/v6/gemini`, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-sonic-internal': INTERNAL_API_KEY,
    },
    body: JSON.stringify({
      model:             GEMINI_MODEL,
      max_output_tokens: GEMINI_MAX_TOKENS,
      thinking_level:    GEMINI_THINKING,
      system:            EVENT_CHAT_SYSTEM_PROMPT,
      user:              currentUserText,
      history,
      label:             'event-chat',
      business_id:       businessId || null,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`gemini ${r.status}: ${data?.error?.message || data?.error || 'proxy failed'}`);
  }
  const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const text = Array.isArray(cand?.content?.parts)
    ? cand.content.parts.find((p) => typeof p?.text === 'string')?.text
    : null;
  if (typeof text !== 'string') throw new Error('gemini: no text part in response');
  const trimmed = text.trim();
  const fenced  = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body    = fenced ? fenced[1] : trimmed;
  try { return { raw: text, parsed: JSON.parse(body) }; }
  catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`event-chat: unparseable model output: ${body.slice(0, 200)}`);
    return { raw: text, parsed: JSON.parse(m[0]) };
  }
}

// Normalize whatever Gemini returned into the shape the client expects.
// Extract the `proposal` (only meaningful when state === 'confirming' and
// name_he/description_he are present) so the client can render its
// inline confirm button without having to re-parse.
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
  if (!await guard(req, res, 'event-chat', 20, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, message, sessionStartAt } = req.body || {};
    const text = String(message || '').trim();
    if (!businessId || !text)      return res.status(400).json({ error: 'businessId and message required' });
    if (text.length > 2000)        return res.status(400).json({ error: 'message too long' });
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Client-generated ISO timestamp — the moment its module loaded /
    // last cleared its transcript. Everything with created_at >= this
    // value is "the current session" for both display + Gemini's
    // memory. Missing / malformed → treat as "fresh session, no
    // history" (safest).
    const sessionStartClause = (typeof sessionStartAt === 'string' && sessionStartAt.length && !Number.isNaN(Date.parse(sessionStartAt)))
      ? { created_at: `gte.${sessionStartAt}` }
      : { created_at: `gte.${new Date().toISOString()}` };

    // 1. Persist the user's message FIRST — durable regardless of what
    //    Gemini does next. Client relies on the returned id.
    const insertedUser = await pgrInsert('business_event_chats', {
      business_id: businessId,
      role:        'user',
      content:     text,
    }, { returnRows: true });
    const userRow = Array.isArray(insertedUser) ? insertedUser[0] : insertedUser;

    // 2. Load session tail. Load descending then re-sort ascending, and
    //    drop the just-inserted user row (it's the "current turn" and
    //    gets passed separately below).
    const tailMessages = await pgrSelect('business_event_chats',
      { business_id: `eq.${businessId}`, ...sessionStartClause },
      { select: 'id,role,content,created_at',
        order: 'created_at.desc', limit: MESSAGE_TAIL_LIMIT, useService: true });
    const historyMessages = (tailMessages || [])
      .filter((m) => m.id !== userRow.id)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

    const history = historyFromMessages(historyMessages);
    const origin  = selfOrigin(req);

    // 3. Call Gemini. On failure, persist a fallback assistant turn so
    //    the transcript stays coherent and the client shows a clean
    //    error message.
    let rawText, parsed;
    try {
      const out = await callGemini(origin, history, text, businessId);
      rawText = out.raw;
      parsed  = out.parsed;
    } catch (err) {
      console.error('[event-chat] gemini call failed:', err.message);
      const fallback = { reply_he: 'משהו השתבש. תוכלו לנסח שוב?', state: 'gathering' };
      const inserted = await pgrInsert('business_event_chats', {
        business_id: businessId,
        role:        'assistant',
        content:     JSON.stringify(fallback),
        proposal:    null,
      }, { returnRows: true });
      const assistantRow = Array.isArray(inserted) ? inserted[0] : inserted;
      return res.status(200).json({
        ok:               true,
        userMessage:      userRow,
        assistantMessage: { ...assistantRow, parsed: fallback },
      });
    }

    const normalized = normalizeReply(parsed);

    // 4. Persist the assistant reply. content = raw JSON string (exact
    //    replay possible); proposal = parsed structured payload the
    //    client uses for its inline confirm button.
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
    console.error('[event-chat] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
