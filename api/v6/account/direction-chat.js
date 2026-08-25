/* /api/v6/account/direction-chat.js
   One turn of the direction-edit chat on /v6/account.

   Flow:
     1. Verify JWT + business ownership.
     2. Insert the owner's message into business_direction_chats.
     3. Load context: business row (description + emphases), atmospheres
        (via auth admin), place, active + recently-inactive directions,
        prior changes, prior messages tail.
     4. Build the multi-turn Gemini call — system prompt + labeled context
        block + full message history.
     5. Parse the reply, insert the assistant message (with proposal
        payload if present), and return both message rows to the client so
        it can render them without a re-fetch.

   Auth: standard Supabase JWT + business ownership check. Rate-limited to
   20 req/min per IP via the shared `guard` helper.

   Request body:
     { businessId, message, selectedDirectionId? }
   Response:
     { ok: true, userMessage, assistantMessage }
       userMessage      = { id, role:'user',       content, selected_direction_id, created_at }
       assistantMessage = { id, role:'assistant',  content, proposal|null, created_at }
*/

import { pgrSelect, pgrInsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from './_require-business-owner.js';
import { setCors } from '../origin-guard.js';
import { guard } from '../ratelimit.js';
import { DIRECTION_EDIT_CHAT_SYSTEM_PROMPT } from '../../../v6/generation/direction-edit-chat-prompt.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY || '';

// Fixed model choice for the chat — cheap fast turn with responseMimeType JSON.
// Kept distinct from the ai-provider switch used for musical-directions: this
// chat is a chat, not a big JSON generation, so `low` thinking is enough.
const GEMINI_MODEL         = 'gemini-3.6-flash';
const GEMINI_THINKING      = 'low';
const GEMINI_MAX_TOKENS    = 3000;

// Context loader caps. The chat is chatty but grows over the life of a
// business — the tail-first cap keeps the prompt bounded while still
// carrying enough history for continuity.
const MESSAGE_TAIL_LIMIT   = 40;
const CHANGES_TAIL_LIMIT   = 20;

// -- helpers --------------------------------------------------------------

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

// Atmospheres live only in auth.users.raw_user_meta_data.sonic.onboarding.
// Best-effort: on any failure (missing user, dropped connection, etc.)
// return [] so the chat still works with a slightly thinner context.
async function fetchAtmospheres(ownerId) {
  if (!ownerId || !SERVICE_KEY) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${ownerId}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    const arr = j?.user_metadata?.sonic?.onboarding?.atmospheres;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Distills a business_place row into the same compact block musical-directions
// uses. Returns null on missing/empty row (owner didn't confirm a place).
function formatPlaceBlock(place) {
  if (!place || typeof place !== 'object') return null;
  const types = Array.isArray(place.types) && place.types.length ? place.types.join(', ') : 'none';
  const editorial = place.editorial_summary ? String(place.editorial_summary) : 'none';
  const priceLevel = place.price_level ? String(place.price_level) : 'unknown';
  const vibe = place.vibe && typeof place.vibe === 'object' ? place.vibe : {};
  const vibeLine = Object.entries(vibe)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || 'none';
  return [
    'Google Places:',
    `  primary_type: ${place.primary_type || 'unknown'}`,
    `  types: ${types}`,
    `  editorial_summary: ${editorial}`,
    `  price_level: ${priceLevel}`,
    `  vibe: ${vibeLine}`,
  ].join('\n');
}

// Direction serialized for the chat's internal context block. Includes the
// full spec so the model can reason about excluding/adding genres — but the
// prompt's exposure rules keep it from spilling those to the owner.
function serializeDirection(d) {
  return {
    id:                          d.id,
    title_en:                    d.title_en,
    description_he:              d.description_he,
    genres:                      Array.isArray(d.genres) ? d.genres : [],
    bpm_range:                   d.bpm_range || null,
    instrumentalness_preference: d.instrumentalness_preference || 'none',
    active:                      d.active !== false,
  };
}

// Summary of a past change, kept short so the context doesn't balloon over
// time. Focus on what the change was (kind + which fields moved), not full
// before/after snapshots.
function serializeChangeSummary(c) {
  const out = {
    applied_at:   c.applied_at,
    kind:         c.kind,
    direction_id: c.direction_id,
  };
  if (c.kind === 'add' && c.after) {
    out.added_title = c.after.title_en || null;
  }
  if (c.kind === 'edit' && c.after) {
    const changed = [];
    const b = c.before || {};
    const a = c.after || {};
    for (const k of ['title_en', 'description_he', 'genres', 'bpm_range', 'instrumentalness_preference']) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
    }
    out.edited_fields = changed;
  }
  if (c.kind === 'remove' && c.before) {
    out.removed_title  = c.before.title_en || null;
    out.playlist_action = c.playlist_action || null;
  }
  return out;
}

// Compose the user-role context block sent BEFORE the current turn. The
// model's system prompt tells it to expect this block; keeping it as a
// single user message means it flows through Gemini's `contents` array
// alongside the transcript history naturally.
function buildContextBlock({ business, atmospheres, place, directions, changes, selectedDirectionId }) {
  const parts = [];
  parts.push('## Business context');
  parts.push(`business_description: ${business.business_description || '(none provided)'}`);
  parts.push(`musical_emphases: ${business.musical_emphases || '(none provided)'}`);
  parts.push(`atmospheres: ${atmospheres.length ? atmospheres.join(', ') : '(none)'}`);
  const placeBlock = formatPlaceBlock(place);
  if (placeBlock) parts.push(placeBlock);

  const active = directions.filter((d) => d.active !== false);
  // Explicit count as its own line so the model doesn't have to count JSON
  // blobs itself. When N === 8 the "no more adds" rule (see system prompt)
  // becomes unambiguous — the model must refuse and suggest a remove.
  parts.push(`\n## Active directions count\nactive_directions_count: ${active.length} / 8`);
  if (active.length >= 8) {
    parts.push('AT CAP — do NOT emit an `add` proposal. If the owner asks to add, respond by telling them they\'re at the 8-direction cap and offer to help remove one instead.');
  }

  parts.push('\n## Current directions (INTERNAL — see Exposure rules in system)');
  if (!active.length) {
    parts.push('(the owner has no active directions right now — an add is the only reasonable next step)');
  } else {
    for (const d of active) {
      parts.push(JSON.stringify(serializeDirection(d)));
    }
  }
  const inactive = directions.filter((d) => d.active === false);
  if (inactive.length) {
    parts.push('\n## Previously removed directions (inactive — for context, do not resurrect unless asked)');
    for (const d of inactive) {
      parts.push(JSON.stringify(serializeDirection(d)));
    }
  }

  if (changes.length) {
    parts.push('\n## Prior committed changes (most recent first)');
    for (const c of changes) {
      parts.push(JSON.stringify(serializeChangeSummary(c)));
    }
  }

  if (selectedDirectionId) {
    parts.push(`\n## Selected direction id (owner clicked this card)\n${selectedDirectionId}`);
  }

  return parts.join('\n');
}

// Turn stored messages into Gemini's { role, text } shape. 'assistant' →
// 'model'. Skips empty content defensively.
function historyFromMessages(messages) {
  return messages
    .filter((m) => typeof m.content === 'string' && m.content.length)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      text: m.content,
    }));
}

// The assistant's own JSON payload is what we store in `content` — that
// way the transcript we replay to Gemini next turn is exactly what
// Gemini emitted, and we don't have to reconstruct proposals. The client
// separately parses `proposal` for its inline buttons.
function assistantContentString(reply) {
  return JSON.stringify(reply);
}

// Coerce whatever the model returned into the two shapes the client cares
// about: a short natural-language reply, and an optional structured
// proposal. Returns { reply_he, state, proposal|null }.
function normalizeReply(raw) {
  const out = { reply_he: '', state: 'gathering', proposal: null };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.reply_he === 'string') out.reply_he = raw.reply_he.trim();
  if (raw.state === 'confirming' || raw.state === 'off_topic' || raw.state === 'gathering') {
    out.state = raw.state;
  }
  if (raw.state === 'confirming' && raw.proposal && typeof raw.proposal === 'object') {
    const p = raw.proposal;
    if (p.kind === 'edit' && typeof p.direction_id === 'string' && p.updates && typeof p.updates === 'object') {
      out.proposal = { kind: 'edit', direction_id: p.direction_id, updates: sanitizeUpdates(p.updates) };
    } else if (p.kind === 'remove' && typeof p.direction_id === 'string') {
      out.proposal = { kind: 'remove', direction_id: p.direction_id };
    } else if (p.kind === 'add' && p.spec && typeof p.spec === 'object') {
      const s = sanitizeAddSpec(p.spec);
      if (s) out.proposal = { kind: 'add', spec: s };
    }
  }
  return out;
}

// Trim/whitelist the fields on an edit proposal so the client + apply
// endpoint see a clean shape. Silently drops unknown fields.
function sanitizeUpdates(u) {
  const out = {};
  if (Array.isArray(u.exclude_genres) && u.exclude_genres.length) {
    out.exclude_genres = u.exclude_genres.filter((g) => typeof g === 'string' && g.length);
  }
  if (Array.isArray(u.add_genres) && u.add_genres.length) {
    out.add_genres = u.add_genres.filter((g) => typeof g === 'string' && g.length);
  }
  if (u.bpm_range && Number.isFinite(u.bpm_range.min) && Number.isFinite(u.bpm_range.max) && u.bpm_range.min <= u.bpm_range.max) {
    out.bpm_range = { min: Math.round(u.bpm_range.min), max: Math.round(u.bpm_range.max) };
  }
  if (u.instrumentalness_preference === 'none' || u.instrumentalness_preference === 'soft' || u.instrumentalness_preference === 'hard') {
    out.instrumentalness_preference = u.instrumentalness_preference;
  }
  if (typeof u.title_en === 'string' && u.title_en.trim().length) {
    out.title_en = u.title_en.trim().slice(0, 120);
  }
  if (typeof u.description_he === 'string' && u.description_he.trim().length) {
    out.description_he = u.description_he.trim().slice(0, 800);
  }
  return Object.keys(out).length ? out : null;
}

// Validate an add spec's minimum shape (title + description + genres +
// bpm). Returns the sanitized spec or null if something's missing.
function sanitizeAddSpec(s) {
  const title = typeof s.title_en === 'string' ? s.title_en.trim() : '';
  const desc  = typeof s.description_he === 'string' ? s.description_he.trim() : '';
  const genres = Array.isArray(s.genres)
    ? s.genres.filter((g) => typeof g === 'string' && g.length)
    : [];
  const bpm = s.bpm_range || {};
  if (!title || !desc || !genres.length) return null;
  if (!Number.isFinite(bpm.min) || !Number.isFinite(bpm.max) || bpm.min > bpm.max) return null;
  const inst = (s.instrumentalness_preference === 'soft' || s.instrumentalness_preference === 'hard')
    ? s.instrumentalness_preference : 'none';
  return {
    title_en:                    title.slice(0, 120),
    description_he:              desc.slice(0, 800),
    genres,
    bpm_range:                   { min: Math.round(bpm.min), max: Math.round(bpm.max) },
    instrumentalness_preference: inst,
  };
}

// --- Gemini call via our own proxy (server-to-server with x-sonic-internal
// bypasses the proxy's origin guard + rate limiter). ---
async function callGemini(origin, systemPrompt, contextBlock, history, currentUserText, businessId) {
  // The context block goes as the very first user turn ahead of the
  // transcript. Gemini's chat is stateless — we replay the whole thing
  // every call, which is why the tail caps above matter.
  const contents = [
    { role: 'user',  parts: [{ text: contextBlock }] },
    { role: 'model', parts: [{ text: 'OK' }] },
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user',  parts: [{ text: currentUserText }] },
  ];

  // Reuses api/v6/gemini's history+user shape. `history` there is
  // everything BEFORE the final user turn; we bundle context as the very
  // first user pair so the model sees it as authoritative pre-context.
  const historyPayload = contents.slice(0, -1).map((t) => ({
    role: t.role,
    text: t.parts?.[0]?.text || '',
  }));
  const userPayload = contents[contents.length - 1].parts[0].text;

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
      system:            systemPrompt,
      user:              userPayload,
      history:           historyPayload,
      label:             'direction-chat',
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
  try { return JSON.parse(body); }
  catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`direction-chat: unparseable model output: ${body.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}

// -- handler --------------------------------------------------------------

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'direction-chat', 20, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, message, selectedDirectionId, sessionStartAt } = req.body || {};
    const text = String(message || '').trim();
    if (!businessId || !text)      return res.status(400).json({ error: 'businessId and message required' });
    if (text.length > 2000)        return res.status(400).json({ error: 'message too long' });
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Client sends sessionStartAt (ISO) so we only include messages from
    // the current browser session in Gemini's context — matching what
    // the owner sees on screen after a hard refresh. Missing / malformed
    // → fall back to "no prior context" (equivalent to a fresh session).
    const sessionStartClause = (typeof sessionStartAt === 'string' && sessionStartAt.length && !Number.isNaN(Date.parse(sessionStartAt)))
      ? { created_at: `gte.${sessionStartAt}` }
      : { created_at: `gte.${new Date().toISOString()}` };

    // 1. Insert the owner's message FIRST — the endpoint's contract is
    //    "your message is durably stored, even if Gemini falls over." The
    //    client relies on the returned id for message-range audit links.
    const insertedUser = await pgrInsert('business_direction_chats', {
      business_id:           businessId,
      role:                  'user',
      content:               text,
      selected_direction_id: selectedDirectionId || null,
    }, { returnRows: true });
    const userRow = Array.isArray(insertedUser) ? insertedUser[0] : insertedUser;

    // 2. Load context in parallel — the four queries are independent.
    const [businessRows, placeRows, directionRows, changeRows, tailMessages, atmospheres] = await Promise.all([
      pgrSelect('businesses',
        { id: `eq.${businessId}` },
        { select: 'id,owner_id,name,business_description,musical_emphases', limit: 1, useService: true }),
      pgrSelect('business_place',
        { business_id: `eq.${businessId}` },
        { select: 'primary_type,types,editorial_summary,price_level,vibe', limit: 1, useService: true }),
      pgrSelect('business_directions',
        { business_id: `eq.${businessId}` },
        { select: 'id,rank,title_en,description_he,genres,bpm_range,popularity_window,instrumentalness_preference,active,created_at',
          order: 'rank.asc.nullslast', useService: true }),
      pgrSelect('business_direction_changes',
        { business_id: `eq.${businessId}` },
        { select: 'kind,direction_id,before,after,playlist_action,applied_at',
          order: 'applied_at.desc', limit: CHANGES_TAIL_LIMIT, useService: true }),
      // Load the LAST N-1 messages FROM THIS SESSION (excluding the row
      // we just inserted). Filtering by sessionStartAt keeps Gemini's
      // memory aligned with what the owner sees on screen — a hard
      // refresh clears both.
      pgrSelect('business_direction_chats',
        { business_id: `eq.${businessId}`, ...sessionStartClause },
        { select: 'id,role,content,created_at',
          order: 'created_at.desc', limit: MESSAGE_TAIL_LIMIT, useService: true }),
      fetchAtmospheres(user.id),
    ]);

    const business = businessRows?.[0];
    if (!business) return res.status(404).json({ error: 'business not found' });
    const place = placeRows?.[0] || null;
    const directions = directionRows || [];
    const changes = changeRows || [];
    // Descending → ascending, then drop the row we just inserted (it's the
    // current turn and gets passed separately).
    const historyMessages = (tailMessages || [])
      .filter((m) => m.id !== userRow.id)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

    // 3. Compose the context block + call Gemini.
    const contextBlock = buildContextBlock({
      business, atmospheres, place, directions, changes,
      selectedDirectionId: selectedDirectionId || null,
    });
    const history = historyFromMessages(historyMessages);
    const origin = selfOrigin(req);

    let raw;
    try {
      raw = await callGemini(origin, DIRECTION_EDIT_CHAT_SYSTEM_PROMPT, contextBlock, history, text, businessId);
    } catch (err) {
      console.error('[direction-chat] gemini call failed:', err.message);
      // Persist a fallback assistant turn so the transcript stays coherent
      // and the owner sees a clear error message.
      const fallback = { reply_he: 'משהו השתבש. תוכלו לנסח שוב?', state: 'gathering' };
      const inserted = await pgrInsert('business_direction_chats', {
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

    const parsed = normalizeReply(raw);

    // 4. Persist the assistant reply. content = the model's raw JSON so
    //    replay is exact; proposal = the parsed structured payload the
    //    client uses for its inline confirm buttons.
    const insertedAssistant = await pgrInsert('business_direction_chats', {
      business_id: businessId,
      role:        'assistant',
      content:     assistantContentString(raw),
      proposal:    parsed.proposal,
    }, { returnRows: true });
    const assistantRow = Array.isArray(insertedAssistant) ? insertedAssistant[0] : insertedAssistant;

    // 5. Return both rows + the parsed reply. Client caches these into its
    //    local transcript without a re-fetch.
    return res.status(200).json({
      ok:               true,
      userMessage:      userRow,
      assistantMessage: {
        ...assistantRow,
        parsed,   // { reply_he, state, proposal|null } — client renders this
      },
    });
  } catch (err) {
    console.error('[direction-chat] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
