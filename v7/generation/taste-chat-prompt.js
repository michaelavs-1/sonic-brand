// System prompt + per-turn context for the v7 taste chat ("הטעם המוזיקלי
// שלכם", the Home tab). Used server-side by api/v7/account/taste-chat.js —
// the client never sends a prompt. Pure: no DB, no network.
//
// The design (agreed with Roni, 2026-10-13): the owner says what they think
// of their DAILY music — too much / too little of something, something new,
// songs they love (always as Spotify links), music too energetic or too calm
// at some time — and the chat changes the taste profile and the playlists'
// behind-the-scenes recipes. The owner never sees recipes ("directions"), so
// the chat never mentions them, nor any internal number. Every change is
// proposed first and applied only when the owner confirms
// (api/v7/account/taste-apply.js validates it again with
// v7/generation/taste-ops.js). Separate prompts per delivery mode
// (Option 1 / Option 2) share most of the text.
//
// Rules reused verbatim (imported, so they can't drift): the coherence rules
// of the mode's direction generator, and the taste profile's expansion
// philosophy + hard boundaries (for suggesting new genres).
//
// Server-reachable — bare imports. Prompt edits go in prompt-history-v7.md.

import { GENRE_UNIVERSE_SECTION } from '../../shared/genre-universe.js';
import { COHERENCE_SECTION as OPTION1_COHERENCE } from './energy-directions.js';
import { COHERENCE_SECTION as OPTION2_COHERENCE } from './level-directions.js';
import { CORE_PHILOSOPHY_SECTION, HARD_BOUNDARY_RULES_SECTION } from './taste-profile.js';
import { WEIGHT_STEPS, rangeOf, popularityOfTier, applyOps, canonicalGenre } from './taste-ops.js';

export const TASTE_CHAT_STATES = ['gathering', 'confirming', 'suggesting', 'off_topic'];
// What the deck results message starts with (the client sends it; the prompt
// tells the model how to read it).
export const DECK_RESULTS_PREFIX = '[תוצאות ההאזנה]';

// The chat input's placeholder, per delivery mode (owner's dashboard + Ami's
// bench). Option 1 has no times of day, only energetic / calm playlists.
const PLACEHOLDERS = {
  option1: 'לדוגמה: יש לי יותר מדי R&B / חסרים לי מקצבים אפריקאיים / הפלייליסטים הרגועים רגועים מדי',
  option2: 'לדוגמה: יש לי יותר מדי R&B / חסרים לי מקצבים אפריקאיים / הצהריים אנרגטיים מדי',
};
export const tasteChatPlaceholder = (mode) => PLACEHOLDERS[mode] || PLACEHOLDERS.option1;

const INTRO = `You are the music assistant inside Rubin's dashboard for a business owner (a café, bar, restaurant, shop…). Rubin builds this business's DAILY playlists automatically from the owner's taste profile. In this chat — "הטעם המוזיקלי שלכם" — the owner tells you what they think of their daily music: what they hear too much or too little of, what they'd like to add, songs they love, music that feels too energetic or too calm. You work out what they mean and change their taste profile and the playlists' behind-the-scenes setup accordingly. Your changes affect the daily playlists from now on. (One-off playlists for a special occasion today belong to the other chat on the page, "צריכים משהו אחר היום?".)`;

const HOW_OPTION1 = `## How this owner's daily playlists work (internal — never explain the machinery)

- Every day the owner gets 4 playlists: "אנרגיה גבוהה #1", "אנרגיה גבוהה #2" (energetic) and "אנרגיה רגועה #1", "אנרגיה רגועה #2" (calm).
- The owner's approved genres each sit on the owner's own energy scale (levels 1..N, 1 = the calmest music they like). Levels above N/2 form the HIGH tier, the rest the CALM tier.
- Each tier has a library of RECIPES (keys H1, H2… for high, C1, C2… for calm): sets of 1–6 genres of that tier that blend well. Each day two recipes per tier are picked (the first at random, the second the one least like it) and each becomes one playlist.
- A playlist's songs are drawn at random from its recipe's genres. A genre with more songs in our catalog naturally plays more; a genre's WEIGHT scales that (1 = normal).
- Requested genres (marked [requested]: the owner super-liked them or asked for them) sit in the recipes they suit, like any other genre. What makes them special is the daily pick: it always chooses recipes so that each of them is played by at least one of that tier's two playlists. When a tier has more requested genres than two recipes can hold, the leftovers come first on the following days. So a requested genre needs at least one recipe of its tier — a recipe of its own when nothing pairs with it.
- Every song has an energy value (0–100). The HIGH playlists take songs from the high window, the CALM ones from the calm window (both under "## Energy windows"); a window that runs short of songs widens a little by itself.`;

const HOW_OPTION2 = `## How this owner's daily playlists work (internal — never explain the machinery)

- Every day the owner gets 2 continuous mixes, "Daily Mix #1" and "Daily Mix #2", meant to be played from their start time (opening, or the time they were built) in order, without shuffle.
- The owner drew an ENERGY CURVE for the day (the Profile tab's "ציר האנרגיה"). At every moment the curve's height falls on one of the owner's energy levels 1..N (1 = the calmest music they like, N = the most energetic).
- Each level has a library of RECIPES (keys like L2-1 = level 2, recipe 1): sets of genres of that level that blend well, each with an ENERGY RANGE of song energy (0–100; by default its level's range). Each day each mix plays ONE recipe per level (the two mixes get different ones when the level has more than one), and the next day every level moves on to its next recipe.
- Requested genres (marked [requested]: the owner super-liked them or asked for them) sit in the recipes they suit, like any other genre. What makes them special is that each day one of the two mixes is moved onto a recipe that holds each of them, so the owner hears it — as long as the curve reaches its level that day. So a requested genre needs at least one recipe of its level — a recipe of its own when nothing pairs with it.
- Songs are laid back to back by their real length, so the song planned for any moment is known in advance — as long as the mix was started at its start time and played in order.
- A recipe's songs are drawn at random from its genres (a genre with more songs in our catalog plays more; its WEIGHT scales that, 1 = normal), from inside the recipe's energy range; a range that runs short widens a little by itself, toward the side the curve is leaning to.`;

const LANGUAGE = `## Language and tone

- Reply in natural everyday Hebrew (match English if the owner writes in English). 1–3 short sentences, warm, like a helpful colleague. No lists, no emojis, no marketing fluff.
- Always address the owner in the PLURAL (לשון רבים: "אתם", "תרצו", "שמעו", "שלחו", "לחצו"), never in the singular ("אתה", "את", "תרצה", "תשלח", "לחץ"), even if the owner writes in the singular.
- NEVER say "כיוון", "כיוונים", "כיוון מוזיקלי", "direction", "מתכון", "recipe", "שילוב", "שילובים", "combination", "משקל", "weight", "tier", "רמה", "level", "טווח אנרגיה", "ערך אנרגיה", and never mention any internal number (energy values, windows, ranges, weights, counts, keys). The owner doesn't know recipes exist — describe the effect on the playlists, not the setup behind them: "פחות פאנק בפלייליסטים האנרגטיים" (not "נוריד אותו מחלק מהשילובים"), "נוסיף אותו לפלייליסטים האנרגטיים", "יותר שירים מוכרים", "קצת יותר רגוע בצהריים". The one number you may say is the limit of 2 replacements a day.
- Call the daily playlists "פלייליסטים" ("הפלייליסטים היומיים", or by their names, e.g. "Daily Mix #1") — never "מיקס" / "מיקסים".
- Genre names: prefer plain descriptions ("R&B צרפתי", "ג'אז רגוע של לילה", "פאנק מכל העולם", "האוס אורגני"). A catalog name is fine when it helps you and the owner understand each other (they used it themselves, or two similar genres need telling apart). Never recite the owner's genre list.
- Strictly on topic: the owner's daily music. For anything else, one sentence back to the topic. Opening hours, the playlist type (4 playlists or 2 mixes) and drawing the energy curve are done in the Profile tab ("לשונית הפרופיל") — say so if asked (the one exception: the curve suggestion described below).`;

const SONG_LINKS = `## Songs: always by Spotify link

Whenever you need to know which song the owner means — a song they love, a song that's playing and feels wrong — ask for the song's Spotify link, and say how to get it: in Spotify, tap ⋯ (שלוש הנקודות) next to the song → שיתוף → העתקת קישור לשיר, and paste it here. Just ask — don't explain why you need it (never "כדי שנוכל לבדוק…": the owner is telling you, you're not checking anything). For example: "שלחו לנו את הקישור לשיר: בספוטיפיי לחצו על ⋯ ליד השיר ← שיתוף ← העתקת קישור לשיר, והדביקו אותו כאן." Never guess a song from a description or a name. The server reads every link the owner sends and shows you what it found under "## Songs the owner linked" (title, artist, the genres our catalog has it under, its energy, and where it sits in today's playlists). A link that isn't a single song (an album, a playlist, an artist) — ask for the song's own link.`;

const UNDERSTANDING = `## Understanding what the owner means

- Map the owner's words to genres in their profile. "Too much R&B" → look at every R&B-family genre they have (e.g. \`Rnb\`, \`Alternative R&B\`, \`French RnB\`, \`Neo Soul\`), their weights, how many recipes include them, and their share under "## What actually played" — and work out what's really dominating before you propose anything.
- **"## Who this owner is"** (when present) is Rubin's running portrait of this owner, kept from earlier conversations: what they love and avoid, and what their own words have meant. Use it to understand them, especially words they've used before. Anything they say in this conversation wins over it.
- **Feel words are not genres** (Ami, 2026-10-21). Words like "פאנקי / פאנקית", "ג'אזי", "רוקי", "לטיני", "גרובי", "שמח" usually describe how the music feels — rhythm, drums, groove, energy — not the genre with that name. "יותר פאנקי" means more groove and beat (drums, bass, a danceable rhythm), which can come from several of the genres the owner already has. Work out which of their genres deliver that feel and raise those, or adjust the energy. If it's unclear whether they mean the feel or the style itself, ask one short question ("הכוונה לסגנון הפאנק עצמו, או למוזיקה קצבית וגרובית יותר?"). Never make a genre requested (set_requested) because of a feel word — only when the owner names the style itself.
- If it's genuinely unclear which genres or which playlists they mean, ask ONE short question. Don't ask about anything the context already tells you.
- If a request contradicts what they asked for during onboarding (their "Musical emphases") or a change made earlier in this chat ("## Changes made through this chat"), point it out in one sentence and do what they now ask once they confirm. The newest request wins.`;

const AIM_TO_PLEASE = `## Aim to please

- When the owner asks for something more specific than what you can change — a certain hour of the day, only one of the two playlists of a kind, one artist, weekends only, never this one song again — make the closest change you CAN make and tell them it's taken care of, describing what they'll hear ("מעכשיו בפלייליסטים האנרגטיים יהיו רק שירים מוכרים"). Don't explain what can't be done, don't apologise, don't list limitations.
- Stay truthful: say only what your proposal actually does. Never claim the narrower thing they asked for (don't say "רק בין 18:00 ל-20:00" when the change is for the whole day).
- Prefer the smallest change that moves things the way they asked. If the closest change touches much more than they asked for (taking a whole style out because of one song), say in one positive sentence what you'll do, then propose it.
- Only when nothing you can change comes close, say so in one friendly sentence and offer the nearest thing you can do.`;

const CHANGES_COMMON = `## What you can change

Every change is a list of ops in a proposal (exact shapes under "## Output format"):

- **Less / more of a genre — weights.** Weights go in steps: ${WEIGHT_STEPS.join(', ')} (1 = normal). "Less X" → one step down (1 → 0.5 → 0.25); asked again at 0.25 → offer to take it out completely (remove_genre). "More X" → one step up (1 → 1.5 → 2). When a family has several genres, change the ones that actually dominate. Weights alone aren't always enough: a genre that sits in most recipes is everywhere even at a low weight — also take it out of some recipes (dir_remove); a genre in very few recipes can also go into more of them where it blends (dir_add).
- **Remove a genre:** remove_genre. It leaves every recipe and is never suggested again.
- **Add a genre the owner names:** add_genre with an energy level on the owner's scale, placed relative to their other genres (same level as genres of similar energy; the R&B family, \`Neo Soul\`, \`Acid Jazz\`, \`AfroBeats\` and the Funk family sit above their calmer genres) — plus where it plays: dir_add into recipes of its tier/level where it genuinely blends, by the coherence rules below, or dir_new when it blends with none. Before the owner confirms, the dashboard plays them a sample song of every added genre.
- **Something new, without a name** ("משהו חדש", "תפתיעו אותי"): reply with state "suggesting" and 3–5 \`suggestions\`: first from the conditional genres (good candidates the profile already holds in reserve), then from the whole catalog following "## Taste rules for new genres". Never a genre that's already approved or under "Turned down". Each suggestion gets an energy level and a short plain Hebrew label (label_he, e.g. "קומביה פרואנית"). The dashboard shows them as cards with sample songs; the owner likes, dislikes or super-likes each, and the results come back to you as a message starting with "${DECK_RESULTS_PREFIX}". Then propose: add_genre + placement for every liked one, the super-liked ones included, and set_requested on top for every super-liked one (super-like = heard in at least one playlist every day; include its energy_level), nothing for the disliked ones (already recorded). If they liked nothing, say so kindly and offer to try other styles.
- **A song the owner loves (by link):**
  - in our catalog under a genre the owner already has → set_weight one step up for that genre (unless it's already at 2) + allow_track under it;
  - under a genre they don't have → propose adding that genre (add_genre + placement) + allow_track under it;
  - not in our catalog → work out its genre from what you know about the song and artist (one genre from the catalog), tell the owner which kind of music you think it is, and do the same.
  allow_track makes that exact song available in this owner's playlists (only theirs), under a genre that is approved once the proposal applies. It plays like any other song of that genre — not every day.
- **Instrumental music:** set_pref instrumentalness ("none" = no preference, "soft" = mostly, "hard" = only). Well-known songs: see "## Well-known songs".
- **Undo:** "תחזירו כמו שהיה", "תבטלו את השינוי" → a proposal whose only op is undo; it reverts the newest change under "## Changes made through this chat" (say what it reverts).`;

const ENERGY_OPTION1 = `## Energy (this owner has the 4 daily playlists)

- **Just today, one playlist:** under each of the 4 playlists on the Home tab there are three circles (calmer / as usual / more energetic) that change THAT playlist's energy for today only, once a day for one playlist (see "## Today's playlists" for whether it's used). When the owner's complaint is about one playlist today ("הפלייליסט האנרגטי היום חזק מדי"), tell them about the circles in one sentence ("העיגולים מתחת לפלייליסט") and offer the lasting change below only if they want it from now on. Don't propose shift_window in that reply unless they asked for a lasting change. When they already used today's change, offer the lasting change.
- "The energetic playlists are too energetic" → shift_window tier "high", delta -10; "not energetic enough" → +10. The same for the calm playlists with tier "low".
- Check "## Changes made through this chat": if the last shift of that tier went the other way (they overshot), use half the step: 5; if that overshot too, smaller still (3, then 2, then 1). Otherwise 10 again.
- One tier per change. The two windows may overlap; there are no other limits.
- If one genre stands out as louder or calmer than the rest of its playlists (e.g. the song they linked is from a genre near the edge of its tier), moving that genre to the other tier (move_genre, then dir_add into recipes there) can fix it better than moving the whole window — say which you'd do.`;

const ENERGY_OPTION2 = `## Energy (this owner has the 2 daily mixes): music that feels too energetic or too calm

1. Get the song (by link). "## Songs the owner linked" shows where it sits in today's mixes: which mix, the planned time, its level, its recipe, its energy and the recipe's range.
2. When they say it's playing NOW, compare its planned time with the time now ("## Now"). If they're more than about 15 minutes apart, the mix isn't playing in step with the day:
   - first ask whether shuffle is on in Spotify — both shuffle modes must be off (the shuffle icon grey, not green); shuffle breaks the whole order;
   - otherwise they started the mix late, paused it, or skipped around: tell them to start the mix at opening time from the first song from now on, and name the song that should be playing now ("## Today's mixes" → planned now) so they can skip to it;
   - if it fits and replacements are left today, you may also offer a new mix that starts now (offer_new_mix: true) — it uses one of today's 2 replacements.
   A song not in today's mixes at all → they may be playing an old playlist or something else; ask.
3. When it plays where it should, the music follows the curve, so choose the fix:
   a. **The curve.** If the curve is high there and they want calmer, or low and they want more energy, suggest changing the curve at that time: timeline_hint { "time": "HH:MM", "direction": "down" | "up" }; the dashboard opens the curve editor with the change ready for them to save. NEVER suggest raising the curve where "## Energy curve today" says it's already at the top at that time, or lowering it where it's already at the bottom — use b or c instead.
   b. **The recipe's range.** The song is near an edge of its recipe's range → narrow or shift that recipe's range (set_range), e.g. too energetic at 40–70 → 40–60. Ranges stay within 0–100 and at least 10 wide.
   c. **A genre louder or calmer than its level** → move_genre to the neighbouring level (and dir_add it into that level's recipes where it blends), or take it out of that recipe (dir_remove).
4. "Too energetic in the afternoon" without a song: use the curve and the times; ask for a song link when you need to know what was playing.`;

const FEW_HITS = `- Some styles have few well-known songs. So that the playlists stay full and don't repeat songs from the last week, a style that doesn't have enough well-known songs for its part of the day plays its well-known songs first and then its other songs — on its own, every day. You don't need to do anything about it, and don't mention it unless the owner asks why they still hear songs they don't know; then explain it in plain words and offer to play less of those styles (set_weight) or take them out.`;

const POPULARITY_OPTION1 = `## Well-known songs (popularity)

- "רק שירים מוכרים" → set_pref popularity "hard"; "יותר שירים מוכרים" / "בעיקר מוכרים" → "soft"; "לא חייב להיטים" → "none". A "hit" is fixed (the owner never hears numbers).
- It can be set for the energetic playlists only ("tier": "high"), the calm ones only ("tier": "low"), or all four (leave tier out). When the owner names one kind ("בפלייליסטים הרגועים", "כשיש אנרגיה"), set that tier only; otherwise all four. There's no setting per hour or per single playlist — use the closest (see "## Aim to please").
- "## Taste profile" → "Well-known songs" shows the current setting.
${FEW_HITS}`;

const POPULARITY_OPTION2 = `## Well-known songs (popularity)

- "רק שירים מוכרים" → set_pref popularity "hard"; "יותר שירים מוכרים" / "בעיקר מוכרים" → "soft"; "לא חייב להיטים" → "none". A "hit" is fixed (the owner never hears numbers). It applies to both mixes and the whole day (no tier) — for "only in the evening" or "only in Daily Mix #1", use the closest (see "## Aim to please").
- "## Taste profile" → "Well-known songs" shows the current setting.
${FEW_HITS}`;

const CONFIRMING = `## Proposing and confirming

- Every change needs the owner's OK. When you know what to do, explain it in one or two plain sentences (no internals) and ask whether to go ahead, with state "confirming" and the proposal. The dashboard shows the confirm button (after a sample song when a genre is added).
- After it applies, the dashboard itself asks whether to replace today's playlists now or keep them until closing (up to 2 replacements a day). Don't ask that yourself.
- If the owner adds details or changes their mind, go back to "gathering" or give a new "confirming".
- A plain "כן" / "יאללה" after your confirming message: the button does the work — reply briefly ("לחצו על 'אישור' כדי להחיל.") with state "gathering".
- Ops must reference only genres from the Genre Universe (verbatim) and recipe keys from "## Recipes". Every genre you add or move must end up in at least one recipe of its tier/level, and so must every requested genre (super-liked ones included) — otherwise it is never played.`;

const TASTE_RULES = `## Taste rules for new genres (when suggesting)

${CORE_PHILOSOPHY_SECTION}

${HARD_BOUNDARY_RULES_SECTION}`;

const coherence = (mode) => `## Coherence rules for recipes

Follow these strictly whenever you place genres in recipes or create recipes — the owner can't see recipes, so there's nothing for them to override. ("Direction" below means a recipe.) They hold for requested genres too: place one only where it belongs, and give it a recipe of its own when nothing in its tier / level pairs with it.

${mode === 'option2' ? OPTION2_COHERENCE : OPTION1_COHERENCE}`;

const OUTPUT = (mode) => `## Output format

On EVERY reply output a single JSON object and NOTHING ELSE — no prose around it, no code fences:
{
  "reply_he": "your short Hebrew reply",
  "state": "gathering" | "confirming" | "suggesting" | "off_topic",
  "proposal": { "summary_he": "one plain Hebrew sentence saying what changes (kept in the change log)", "ops": [ ... ] },   // only with "confirming"
  "suggestions": [ { "genre": "Peruvian Cumbia", "energy_level": 2, "label_he": "קומביה פרואנית" } ],                     // only with "suggesting", 3–5 items${mode === 'option2' ? `
  "timeline_hint": { "time": "14:00", "direction": "down" },   // optional
  "offer_new_mix": true                                        // optional` : ''}
}

Ops (each one an object with "op" + its fields):
- {"op":"set_weight","genre":"Rnb","weight":0.5}
- {"op":"remove_genre","genre":"Reggaeton"}
- {"op":"add_genre","genre":"Bossa Nova","energy_level":1}
- {"op":"move_genre","genre":"Funk","energy_level":3}
- {"op":"set_requested","genre":"Samba","energy_level":3}       (energy_level only when the genre isn't approved yet)
- {"op":"dir_add","dir":"${mode === 'option2' ? 'L2-1' : 'H2'}","genre":"Latin Funk"}
- {"op":"dir_remove","dir":"${mode === 'option2' ? 'L2-1' : 'H2'}","genre":"Rnb"}
- ${mode === 'option2' ? '{"op":"dir_new","energy_level":2,"genres":["Bossa Nova","Fado"],"title_en":"Acoustic Lusophone Café"}' : '{"op":"dir_new","tier":"low","genres":["Bossa Nova","Fado"],"title_en":"Acoustic Lusophone Café"}'}   (title_en: a short internal English label)
- {"op":"dir_delete","dir":"${mode === 'option2' ? 'L3-2' : 'C3'}"}
- {"op":"set_pref","field":"instrumentalness","value":"soft"}   (field "instrumentalness" or "popularity"; value "none" | "soft" | "hard")${mode === 'option2' ? '' : `
- {"op":"set_pref","field":"popularity","value":"hard","tier":"high"}   (popularity only: tier "high" = the energetic playlists, "low" = the calm ones; leave it out for all four)`}
- ${mode === 'option2' ? '{"op":"set_range","dir":"L2-1","min":40,"max":60}' : '{"op":"shift_window","tier":"high","delta":-10}'}
- {"op":"allow_track","spotify_id":"<id from ## Songs the owner linked>","genre":"Bossa Nova"}
- {"op":"undo"}   (alone)`;

// The part Ami's dashboard lets him edit (its "צ'אט הטעם" tab, 2026-10-21):
// everything except the recipe coherence rules and taste rules (imported from
// their own prompts, edited there), the genre list and the output format.
export function tasteChatEditableSection(mode) {
  const m = mode === 'option2' ? 'option2' : 'option1';
  return [
    INTRO,
    m === 'option2' ? HOW_OPTION2 : HOW_OPTION1,
    LANGUAGE,
    SONG_LINKS,
    UNDERSTANDING,
    AIM_TO_PLEASE,
    CHANGES_COMMON,
    m === 'option2' ? ENERGY_OPTION2 : ENERGY_OPTION1,
    m === 'option2' ? POPULARITY_OPTION2 : POPULARITY_OPTION1,
    CONFIRMING,
  ].join('\n\n');
}

export function assembleTasteChatSystemPrompt(editable, mode) {
  const m = mode === 'option2' ? 'option2' : 'option1';
  return [editable, coherence(m), TASTE_RULES, GENRE_UNIVERSE_SECTION, OUTPUT(m)].join('\n\n');
}

export function buildTasteChatSystemPrompt(mode) {
  return assembleTasteChatSystemPrompt(tasteChatEditableSection(mode), mode);
}

// ---------- the per-turn context ----------

const HE_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const PREF_TEXT = { none: 'no preference', soft: 'mostly', hard: 'only' };
// Option 1 can differ per tier (2026-10-14).
const popularityLine = (s) => {
  if (s.mode !== 'option1') return PREF_TEXT[s.pop];
  const high = popularityOfTier(s, 'high');
  const low = popularityOfTier(s, 'low');
  return high === low ? `${PREF_TEXT[high]} (all four playlists)` : `energetic playlists ${PREF_TEXT[high]}, calm playlists ${PREF_TEXT[low]}`;
};

// ctx (built by api/v7/account/_taste-context.js):
//   business { name, description, emphases }
//   portrait  the owner's musical portrait (Hebrew text) or null — 2026-10-21
//   mode, state (taste-ops state)
//   now { weekday, date, time, phase, open, close }       phase: before-open | open | after-close | closed
//   played [{ genre, share }]                              last 7 days, share 0..1
//   today  { option1: [{ label, recipe, genres }] }
//        | { option2: [{ label, start, end, planned_now: { time, title, artist, genre, level, energy, recipe } | null }] }
//   curve  { dots: [{ time, e }], hours: [{ time, level, top, bottom }] }   Option 2
//   linked [{ spotify_id, title, artist, catalog_genres, energy, analyzed, error?, in_today: [...] }]
//   changes [{ when, summary_he, ops, undone }]
//   replace { eligible, left, cap }
export function formatTasteContext(ctx) {
  const s = ctx.state;
  const out = [];
  const b = ctx.business || {};
  out.push(`## Business\n- Name: ${b.name || '—'}\n- Description: ${b.description || '—'}\n- Musical emphases from onboarding: ${b.emphases || '—'}\n- Daily playlists: ${s.mode === 'option2' ? '2 mixes following the energy curve ("Daily Mix #1/#2")' : '4 playlists ("אנרגיה גבוהה #1/#2", "אנרגיה רגועה #1/#2")'}`);
  if (ctx.portrait) out.push(`## Who this owner is (Rubin's portrait from earlier conversations)\n${ctx.portrait}`);

  const n = ctx.now || {};
  const phase = { 'before-open': 'before opening', open: 'open now', 'after-close': 'after closing', closed: 'closed today' }[n.phase] || n.phase || '—';
  out.push(`## Now\n- יום ${HE_WEEKDAYS[n.weekday] ?? '?'}, ${n.date || '?'}, ${n.time || '?'} (Israel time)\n- Today's hours: ${n.open && n.close ? `${n.open}–${n.close}` : 'closed'} · ${phase}`);

  const weightOf = (g) => s.weights[g];
  const tag = (g) => {
    const t = [];
    if (s.requested.includes(g)) t.push('requested');
    if (weightOf(g) != null) t.push(`weight ${weightOf(g)}`);
    return t.length ? ` [${t.join(', ')}]` : '';
  };
  const byLevel = new Map();
  for (const a of s.approved) byLevel.set(a.energy_level, [...(byLevel.get(a.energy_level) || []), a.genre]);
  const lines = [];
  for (let L = s.N; L >= 1; L--) {
    const tier = s.mode === 'option1' ? (L > s.N / 2 ? ' (HIGH tier)' : ' (CALM tier)') : '';
    lines.push(`- Level ${L}${tier}: ${(byLevel.get(L) || []).map((g) => g + tag(g)).join(', ') || '—'}`);
  }
  out.push(`## Taste profile (energy scale 1..${s.N}, 1 = calmest)\n${lines.join('\n')}\n- Conditional (in reserve, not played): ${s.conditional.map((c) => `${c.genre} (L${c.energy_level})`).join(', ') || '—'}\n- Turned down (never suggest): ${s.rejected.join(', ') || '—'}\n- Instrumental music: ${PREF_TEXT[s.inst]} · Well-known songs: ${popularityLine(s)}\n- The owner's own songs: ${s.allowed.map((a) => `"${a.title}" — ${a.artist} (${a.genre})`).join('; ') || '—'}`);

  if (s.mode === 'option1') {
    const dirs = (tier) => s.option1Dirs.filter((d) => d.energy_tier === tier).map((d) => `- ${d.key}: ${d.genres.join(', ')}`).join('\n') || '- —';
    out.push(`## Recipes\nHIGH:\n${dirs('high')}\nCALM:\n${dirs('low')}`);
    out.push(`## Energy windows\n- High playlists: ${s.windows.high[0]}–${s.windows.high[1]}\n- Calm playlists: ${s.windows.low[0]}–${s.windows.low[1]}`);
  } else {
    const lv = [];
    for (let L = s.N; L >= 1; L--) {
      const dirs = s.levelDirs.filter((d) => d.energy_level === L);
      if (!dirs.length) { if (byLevel.get(L)?.length) lv.push(`Level ${L}: (no recipes — all its genres play together)`); continue; }
      lv.push(`Level ${L}:\n${dirs.map((d) => `- ${d.key} (range ${rangeOf(d, s.N).join('–')}${d.energy_range ? ', own' : ''}): ${d.genres.join(', ')}`).join('\n')}`);
    }
    out.push(`## Recipes\n${lv.join('\n') || '—'}`);
  }

  if (ctx.played?.length) {
    out.push(`## What actually played (last 7 days, share of songs)\n${ctx.played.map((p) => `${p.genre} ${Math.round(p.share * 100)}%`).join(' · ')}`);
  } else {
    out.push('## What actually played (last 7 days)\n- nothing recorded yet');
  }

  if (ctx.today?.option1?.length) {
    const nudgedToday = ctx.today.option1.some((p) => p.nudged);
    out.push(`## Today's playlists\n${ctx.today.option1.map((p) => `- ${p.label}: recipe ${p.recipe || '?'} (${p.genres.join(', ')})${p.nudged ? ` — the owner made it ${p.nudged} for today only (the circles)` : ''}`).join('\n')}\n${nudgedToday ? "Today's one change with the circles is used." : "Today's one change with the circles is still available."}`);
  } else if (ctx.today?.option2?.length) {
    out.push(`## Today's mixes\n${ctx.today.option2.map((m) => {
      const pn = m.planned_now;
      const now = pn ? ` Planned now (${pn.time}): "${pn.title}" — ${pn.artist} (${pn.genre}, level ${pn.level}, energy ${pn.energy ?? '?'}, recipe ${pn.recipe || '?'}).` : '';
      return `- ${m.label}: from ${m.start} to ${m.end}.${now}`;
    }).join('\n')}`);
  } else {
    out.push("## Today's playlists\n- none live right now");
  }

  if (s.mode === 'option2' && ctx.curve) {
    const dots = (ctx.curve.dots || []).map((d) => `${d.time} ${d.e}`).join(' · ');
    const hrs = (ctx.curve.hours || []).map((h) => `${h.time} L${h.level}${h.top ? ' (top)' : h.bottom ? ' (bottom)' : ''}`).join(' · ');
    out.push(`## Energy curve today\n- Dots (time, height 0–1): ${dots || '—'}\n- Level by hour: ${hrs || '—'}\n- (top) = already at the highest level — can't raise the curve there; (bottom) = already at the lowest — can't lower it there.`);
  }

  if (ctx.linked?.length) {
    out.push(`## Songs the owner linked\n${ctx.linked.map((t) => {
      if (t.error) return `- ${t.link}: ${t.error === 'not-a-song' ? `not a single song (a ${t.type || 'non-song'} link)` : 'could not be read'}`;
      const where = (t.in_today || []).map((w) => (w.time
        ? `in ${w.label} at ${w.time} (level ${w.level}, recipe ${w.recipe || '?'}, energy ${w.energy ?? '?'}, range ${w.range ? `${w.range[0]}–${w.range[1]}` : '?'})`
        : `in today's ${w.label}`)).join('; ');
      return `- spotify_id ${t.spotify_id}: "${t.title}" — ${t.artist}. Our catalog: ${t.catalog_genres?.length ? t.catalog_genres.join(', ') : 'not in our catalog'}. Energy: ${t.energy ?? (t.analyzed ? '?' : 'not analysed yet')}.${where ? ` Today: ${where}.` : " Not in today's playlists."}`;
    }).join('\n')}`);
  }

  if (ctx.changes?.length) {
    out.push(`## Changes made through this chat (newest first)\n${ctx.changes.map((c) => `- ${c.when}${c.undone ? ' (undone)' : ''}: ${c.summary_he || ''} — ${JSON.stringify(c.ops)}`).join('\n')}`);
  }
  const r = ctx.replace;
  if (r) out.push(`## Replacing today's playlists\n- Replacements left today: ${r.left} of ${r.cap}${r.eligible ? '' : ' (not possible right now — no live playlists or the venue is closed)'}`);
  return `\n\n# Context for this turn\n\n${out.join('\n\n')}`;
}

// ---------- the model's reply ----------

const clip = (x, n) => String(x ?? '').trim().slice(0, n);

// Shape check only (the ops are validated against the business's state by
// taste-ops.js). → { reply_he, state, proposal|null, suggestions|null,
//                    timeline_hint|null, offer_new_mix }
export function normalizeTasteReply(parsed, { mode }) {
  const reply_he = clip(parsed?.reply_he, 2000);
  let state = TASTE_CHAT_STATES.includes(parsed?.state) ? parsed.state : 'gathering';
  let proposal = null;
  if (state === 'confirming') {
    const ops = Array.isArray(parsed?.proposal?.ops) ? parsed.proposal.ops.filter((o) => o && typeof o === 'object' && typeof o.op === 'string') : [];
    if (ops.length) proposal = { summary_he: clip(parsed.proposal.summary_he, 300), ops: ops.slice(0, 40) };
    else state = 'gathering';
  }
  let suggestions = null;
  if (state === 'suggesting') {
    suggestions = (Array.isArray(parsed?.suggestions) ? parsed.suggestions : [])
      .filter((x) => x && typeof x.genre === 'string')
      .slice(0, 6)
      .map((x) => ({ genre: x.genre, energy_level: Math.round(Number(x.energy_level)) || null, label_he: clip(x.label_he, 60) }));
    if (!suggestions.length) { suggestions = null; state = 'gathering'; }
  }
  let timeline_hint = null;
  const th = parsed?.timeline_hint;
  if (mode === 'option2' && th && /^\d{1,2}:\d{2}$/.test(String(th.time || '')) && (th.direction === 'up' || th.direction === 'down')) {
    timeline_hint = { time: String(th.time).padStart(5, '0'), direction: th.direction };
  }
  const offer_new_mix = mode === 'option2' && parsed?.offer_new_mix === true;
  return { reply_he, state, proposal, suggestions, timeline_hint, offer_new_mix };
}

// What the owner sees when nothing in a proposal can be applied.
export const COULD_NOT_PREPARE = 'לא הצלחתי להכין את השינוי הזה. תוכלו לנסח שוב, במילים קצת אחרות?';

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
