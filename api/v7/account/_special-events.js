/* /api/v7/account/_special-events.js
   Shared pieces for v7's special playlists ("צריכים משהו אחר היום?"):
   event-chat, save-event, event-playlist, delete-event.

   v7 model (Roni, 2026-10-03): a special playlist is made for TODAY only —
   the "day" runs from 04:00 IL to the next 04:00 IL (prevIl4amIso /
   nextIl4amIso), the playlist expires at the next 04:00, the card is shown
   only during its day, and at most SPECIAL_PLAYLISTS_PER_DAY events may be
   created per business per day (trashing one frees a slot, since
   delete-event removes the business_events row).

   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect } from '../../v5/supabase-client.js';
import { prevIl4amIso } from '../../../v7/generation/playlist-length.js';

export { SPECIAL_PLAYLISTS_PER_DAY } from '../../../v7/generation/event-chat-prompt.js';

export const DAILY_CAP_MESSAGE = 'אפשר להכין כאן עד 2 פלייליסטים ביום. כדי להכין עוד אחד, מחקו אחד מהפלייליסטים של היום.';

export function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

// The caller's business row ({ id, name }), or throws an Error carrying
// .status (400 / 403) — same contract as v6's requireBusinessOwner, plus the
// name the chat context and the Spotify title need.
export async function ownedBusiness(businessId, userId) {
  if (!businessId) throw Object.assign(new Error('businessId required'), { status: 400 });
  const rows = await pgrSelect('businesses',
    { id: `eq.${businessId}`, owner_id: `eq.${userId}` },
    { select: 'id,name', limit: 1, useService: true });
  if (!rows?.[0]) throw Object.assign(new Error('not your business'), { status: 403 });
  return rows[0];
}

// Special playlists (business_events rows) created since the last 04:00 IL.
export async function eventsMadeToday(businessId) {
  const rows = await pgrSelect('business_events',
    { business_id: `eq.${businessId}`, created_at: `gte.${prevIl4amIso()}` },
    { select: 'id', limit: 50, useService: true });
  return Array.isArray(rows) ? rows.length : 0;
}

// The model's text → JSON (tolerates ```json fences and stray prose).
export function parseModelJson(text) {
  const trimmed = String(text || '').trim();
  const fenced  = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body    = fenced ? fenced[1] : trimmed;
  try { return JSON.parse(body); }
  catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`unparseable model output: ${body.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}

// First text part of a /api/v6/gemini response.
export function geminiText(data) {
  const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const text = Array.isArray(cand?.content?.parts)
    ? cand.content.parts.find((p) => typeof p?.text === 'string')?.text
    : null;
  if (typeof text !== 'string') throw new Error('gemini: no text part in response');
  return text;
}
