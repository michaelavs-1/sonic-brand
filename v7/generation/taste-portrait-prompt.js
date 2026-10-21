// The owner's musical portrait (2026-10-21): a short Hebrew text per business
// that the taste chat ("הטעם המוזיקלי שלכם") reads on every turn, so it
// understands this owner from one conversation to the next — above all what
// their own words mean ("פאנקי" = groove and drums, not the Funk genre).
//
// Written by api/v7/account/taste-portrait.js after every "success" in the
// taste chat (the chat and the owner understood each other and the chat
// offered the confirm button), from the messages that led to it. The first
// version comes from the onboarding answers. Stored in
// business_taste_portraits (every version kept). Also used by Ami's dashboard
// (its taste chat tab) and scripts/_v7-backfill-taste-portraits.mjs.
//
// Pure, no imports — browser + server. Prompt edits go in prompt-history-v7.md.

export const TASTE_PORTRAIT_SYSTEM_PROMPT = `You keep a short musical portrait of one business owner for Rubin, a tool that builds the daily playlists of a café, bar, restaurant or shop. Rubin's music chat ("הטעם המוזיקלי שלכם") reads the portrait before every reply, so it understands this owner from one conversation to the next: what they love, what they avoid, and above all what they mean by their own words.

You receive the current portrait (or none yet) and new material: the owner's onboarding answers, or a conversation in that chat that just ended in agreement (the owner and the chat understood each other and the chat proposed a change). Return the updated portrait.

## Rules

- Hebrew, plain and short: at most about 150 words. Short lines under these headings, in this order; leave out a heading that has nothing under it:
  העסק: / אוהבים: / פחות או בכלל לא: / כשהם אומרים: / אנרגיה ושעות: / ביקשו לאחרונה:
- "כשהם אומרים" is the most important part: the owner's own words and what they turned out to mean (e.g. "פאנקי" = מוזיקה קצבית עם תופים, לא סגנון הפאנק עצמו). Record a meaning only when the conversation made it clear.
- Keep what is still true from the current portrait. When the new material contradicts it, the newer statement wins: rewrite that line, don't keep both.
- Write about tastes and wishes, not settings: never weights, levels, recipe keys, numbers or the names of internal steps. Genre names are fine when the owner used them or they help, but don't list the whole taste profile — the chat sees the profile separately.
- Only what the owner said or clearly showed. Don't invent and don't guess motives.
- "ביקשו לאחרונה": the last 2–3 changes they agreed to, one short line each, newest first.
- Refer to the owner in the plural ("אוהבים", "ביקשו") or as the business ("המקום").

## Output

A single JSON object and nothing else: {"portrait_he": "..."} — line breaks as \\n.`;

// Onboarding material from a business_taste_profiles row: the swipe cards the
// owner liked / disliked (onboarding_probes, 2026-10-13) and the profile's
// reasoning. Null when there's nothing to show.
export function onboardingMaterial(profileRow) {
  if (!profileRow) return null;
  const probes = Array.isArray(profileRow.onboarding_probes) ? profileRow.onboarding_probes : [];
  const card = (p) => `"${p.title_en || '?'}" (${(p.genres || []).join(', ')})`;
  const liked = probes.filter((p) => p.verdict === 'liked').map(card);
  const disliked = probes.filter((p) => p.verdict === 'disliked').map(card);
  const lines = [];
  if (liked.length) lines.push(`- Swipe cards they liked: ${liked.join('; ')}`);
  if (disliked.length) lines.push(`- Swipe cards they disliked: ${disliked.join('; ')}`);
  if (Array.isArray(profileRow.super_liked_genres) && profileRow.super_liked_genres.length) {
    lines.push(`- Genres they super-liked a song from: ${profileRow.super_liked_genres.join(', ')}`);
  }
  if (profileRow.round2_emphases) lines.push(`- What they wrote after hearing the first cards: ${profileRow.round2_emphases}`);
  if (profileRow.reasoning_en) lines.push(`- How their taste profile was read (internal note): ${profileRow.reasoning_en}`);
  return lines.length ? lines.join('\n') : null;
}

// A chat transcript from business_direction_chats rows (oldest first): the
// owner's text, and the reply_he out of the chat's raw JSON.
export function chatTranscript(rows) {
  return (rows || []).map((m) => {
    if (m.role !== 'assistant') return `בעל העסק: ${String(m.content || '').trim()}`;
    let text = String(m.content || '');
    try {
      const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      text = JSON.parse(body)?.reply_he || text;
    } catch { /* not JSON — keep as is */ }
    return `רובין: ${String(text).trim()}`;
  }).filter((l) => l.length > 12).join('\n');
}

//   business      { name, description, emphases }
//   current       the current portrait text, or null
//   onboarding    onboardingMaterial(...) or null
//   transcript    chatTranscript(...) or '' — the conversation that ended in agreement
//   agreedChange  the proposal's summary_he, or null
//   transcriptTitle  the transcript's heading (the backfill sends a whole chat history)
export function buildPortraitUserMessage({
  business = {}, current = null, onboarding = null, transcript = '', agreedChange = null,
  transcriptTitle = 'Conversation that ended in agreement',
}) {
  const out = [
    `## Business\n- Name: ${business.name || '—'}\n- Description: ${business.description || '—'}\n- Musical emphases from onboarding: ${business.emphases || '—'}`,
    `## Current portrait\n${current || '(none yet — write the first version)'}`,
  ];
  if (onboarding) out.push(`## Onboarding answers\n${onboarding}`);
  if (transcript) {
    out.push(`## ${transcriptTitle}\n${transcript}${agreedChange ? `\n\nThe change they agreed on: ${agreedChange}` : ''}`);
  }
  out.push('Return the updated portrait.');
  return out.join('\n\n');
}

// → the portrait text, or null when the reply is unusable.
export function normalizePortrait(parsed) {
  const t = typeof parsed?.portrait_he === 'string' ? parsed.portrait_he.replace(/\r/g, '').trim() : '';
  return t.length >= 10 ? t.slice(0, 2000) : null;
}
