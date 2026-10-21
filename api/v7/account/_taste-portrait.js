/* /api/v7/account/_taste-portrait.js
   The owner's musical portrait (2026-10-21) — read the current one, write a
   new version. Prompt: v7/generation/taste-portrait-prompt.js. Table:
   business_taste_portraits (migration 2026-10-21-v7-taste-portraits.sql);
   without it, reads return null and writes fail softly.

   Used by taste-portrait.js (after a success in the taste chat, and the first
   version on the dashboard's first load), _taste-context.js (the chat reads
   it every turn) and scripts/_v7-backfill-taste-portraits.mjs.

   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect, pgrInsert } from '../../v5/supabase-client.js';
import { parseModelJson, geminiText } from './_special-events.js';
import {
  TASTE_PORTRAIT_SYSTEM_PROMPT, buildPortraitUserMessage, normalizePortrait, onboardingMaterial, chatTranscript,
} from '../../../v7/generation/taste-portrait-prompt.js';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
// Low thinking: a short rewrite of a short text.
const GEMINI_MODEL      = 'gemini-3.6-flash';
const GEMINI_THINKING   = 'low';
const GEMINI_MAX_TOKENS = 4000;

// → { id, portrait_he, source, message_id, created_at } | null
export async function latestPortrait(businessId) {
  try {
    const rows = await pgrSelect('business_taste_portraits', { business_id: `eq.${businessId}` },
      { select: 'id,portrait_he,source,message_id,created_at', order: 'created_at.desc', limit: 1, useService: true });
    return rows?.[0] || null;
  } catch { return null; }
}

/* Write a new version and return it.
     source          'onboarding' | 'chat' | 'backfill'
     origin          base URL for /api/v6/gemini (selfOrigin(req), or vercel dev for scripts)
     transcriptRows  business_direction_chats rows that led to the success (oldest first)
     agreedChange    the proposal's summary_he
     messageId       the assistant message with the confirm button
     withOnboarding  include the onboarding answers (always when there's no portrait yet)
   → { portrait_he, row } | { error } */
export async function writePortrait({
  businessId, origin, source, transcriptRows = [], agreedChange = null, messageId = null, withOnboarding = false,
  transcriptTitle,
}) {
  const [bizRows, current, profileRows] = await Promise.all([
    pgrSelect('businesses', { id: `eq.${businessId}` },
      { select: 'name,business_description,musical_emphases', limit: 1, useService: true }),
    latestPortrait(businessId),
    pgrSelect('business_taste_profiles', { business_id: `eq.${businessId}` }, { select: '*', limit: 1, useService: true }).catch(() => []),
  ]);
  const biz = bizRows?.[0] || {};
  const userMessage = buildPortraitUserMessage({
    business: { name: biz.name, description: biz.business_description, emphases: biz.musical_emphases },
    current: current?.portrait_he || null,
    onboarding: (withOnboarding || !current) ? onboardingMaterial(profileRows?.[0]) : null,
    transcript: chatTranscript(transcriptRows),
    agreedChange,
    ...(transcriptTitle ? { transcriptTitle } : {}),
  });

  const r = await fetch(`${origin}/api/v6/gemini`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_API_KEY },
    body: JSON.stringify({
      model: GEMINI_MODEL, max_output_tokens: GEMINI_MAX_TOKENS, thinking_level: GEMINI_THINKING,
      system: TASTE_PORTRAIT_SYSTEM_PROMPT, user: userMessage, label: 'v7-taste-portrait', business_id: businessId,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `gemini ${r.status}: ${data?.error?.message || data?.error || 'proxy failed'}` };
  const portrait = normalizePortrait(parseModelJson(geminiText(data)));
  if (!portrait) return { error: 'the model returned no usable portrait' };

  try {
    const inserted = await pgrInsert('business_taste_portraits',
      { business_id: businessId, portrait_he: portrait, source, message_id: messageId || null }, { returnRows: true });
    return { portrait_he: portrait, row: Array.isArray(inserted) ? inserted[0] : inserted };
  } catch (e) {
    return { error: `saving failed (migration 2026-10-21-v7-taste-portraits.sql run?): ${e.message}` };
  }
}
