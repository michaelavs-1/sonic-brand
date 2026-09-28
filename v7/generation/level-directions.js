// v7 level-directions generator — runs when the owner picks the "Option 2"
// daily playlist type (2 mixes/day whose energy follows the owner's timeline),
// from the first-login gate or the Profile tab. Runs in the browser (callModel
// fetches /api/v6/gemini); v7/account/app.js persists the result via
// /api/v7/account/save-level-directions.
//
// Job: from the owner's taste profile — its `approved_genres`, each tagged
// with an energy level 1..N on the owner's own scale — build a LIBRARY of
// directions for EACH energy level, made only from that level's genres. Each
// direction is a curated, internally coherent blend (v6-onboarding style, same
// pairing rules as Option 1's energy directions), and never pairs genres that
// don't make sense together: a genre with no natural partner in its level
// gets a direction of its own. As many directions per level as the genres
// genuinely support (no target; at least 2 for a level with 2+ genres so the
// two mixes can differ, 1 for a single-genre level, at most MAX_PER_LEVEL).
//
// Downstream (api/v7/account/_option2-builder.js): each day every level plays
// ONE direction per mix, the two mixes different ones when the level has 2+,
// and the next day the level moves on to its next direction
// (pickLevelDirections in timeline-assembler.js).
//
// Sizing was measured before this shipped (2026-09-28, all 10 v7 taste
// profiles, see prompt-history-v7.md): roughly one direction per 2–3 genres
// of a level — 1 genre → 1, 2 → 2–3, 3–7 → 2–4, 8–14 → 3–6, 19 → 7.
//
// `conditional_genres` and `excluded_genres` are IGNORED — not even sent.
//
// Success return:
//   { directions: [ { energy_level: 1..N, title_en: string, genres: [string, ...] }, ... ] }
//   title_en is an internal descriptor (owners see "Daily Mix #1/#2").
// Error return:
//   { error: 'insufficient_signal' | 'matcher_error', reasoning_en: '...' }
//
// Bare imports only (scripts/_v7-regenerate-level-directions.mjs imports it
// from Node).

import { callModel, parseJSONFromText } from './ai-provider.js';
import { GENRE_UNIVERSE_SECTION, GENRES } from '../../shared/genre-universe.js';
import { normLevels } from './energy-timeline.js';

// Gemini counts thinking tokens against the output cap (thinking=high used
// 2.6k–10k in the 2026-09-28 test), so use Gemini's hard cap like Option 1.
const MAX_TOKENS = 65536;

// Safety ceiling only — the 2026-09-28 test never went above 7 per level.
export const MAX_PER_LEVEL = 10;

// ---------- Prompt sub-constants ----------

const LEVEL_DIRECTIONS_INTRO = `You build a library of "energy-level musical directions" for a public-facing-business playlist tool. The business owner has finished onboarding and has a taste profile: a list of APPROVED genres, each tagged with an energy level on the owner's own energy scale (1 = calmest, N = most energetic). The owner has drawn how the energy of their day should move, and every day the tool plays two continuous mixes that follow that curve. Whenever a mix is at a given energy level, it plays from ONE direction of that level for the whole day; the next day the level moves on to another of its directions, and so on through the whole set before any direction repeats. So for EACH energy level you build a library of directions made only from that level's genres. Each direction is a curated, internally coherent blend of genres — a complete musical concept that can carry its energy level on its own for a whole day.`;

const LEVEL_DIRECTIONS_INPUTS_SECTION = `## Inputs

You will receive:

- **Approved genres, grouped by energy level** — the ONLY genres in play. Every genre is a verbatim string from the Genre Universe and sits in exactly one level.
- **Energy levels total (N)** — the size of the user's dynamic energy scale (an integer 2–6). Energy levels are RELATIVE to this user's own taste range, not absolute: level 1 is the calmest music this owner likes, level N the most energetic.
- Optionally: Business name.
- Optionally: Free-text description of the business (any language).
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases** — free-text preferences the owner typed during onboarding.
- Optionally: **Venue context** — a short block describing the physical venue (name / type / summary). Use it only to lightly inform how genres are combined for venue-appropriateness; it does NOT add or remove genres.

You will NOT receive conditional or excluded genres. Do not ask for them, do not infer them, do not reintroduce them. Build directions strictly from the approved genres given.`;

const LEVEL_RULES_SECTION = `## Energy Levels

### 1. Only approved genres are in play

Build every direction ONLY from the approved genres you were given. NEVER invent a genre, translate one, add a qualifier, or pull in a genre that is not in the approved list. Any string not present verbatim in both the approved list AND the Genre Universe will be silently dropped downstream.

### 2. Every direction belongs to exactly one energy level

Tag every direction with an \`energy_level\` — one of the levels in the input — and build it ONLY from the genres listed under that level. NEVER use a genre from another level, not even an adjacent one: the mix plays this direction exactly when the owner's curve is at this level, so every genre in it must carry that level's energy. A genre placed in a direction of the wrong level will be silently dropped downstream. Build no directions for a level that has no approved genres.`;

const LIBRARY_SECTION = `## Library Size & Diversity

### 3. How many directions per level

- Each direction is one day's music for its level, so more directions mean more days before the owner hears a repeat. Build as many directions for each level as that level's genres genuinely support — there is no target number.
- At least 2 directions for every level that has 2 or more approved genres (the two daily mixes play different directions of the same level). Reach that by splitting genres into separate directions when they don't belong together — never by pairing genres that don't make sense together. A level with a single approved genre gets exactly 1 direction.
- At most ${MAX_PER_LEVEL} directions per level.
- Add a direction only if it is a genuinely different listening experience from the other directions of the same level. Never pad a level with near-duplicates to reach a number.

### 4. Diverse within each level

- The directions of one level should sound clearly different from one another: vary the genre combinations, the mood, the cultural flavour, the instrumentation and the groove.
- Use the whole approved list: every approved genre should appear in at least one direction of its level.

### 5. Genre overlap between directions is fine

- Within a level, the same genre may appear in as many directions as make sense — there is no limit on how many genres two directions share.
- The only thing to avoid is repeating a whole sound: no two directions of the same level may have the same set of genres, and don't return two directions whose genre lists are so close that they would sound the same.`;

// The coherence rules are copied from Option 1's COHERENCE_SECTION
// (v7/generation/energy-directions.js, 2026-09-28 — itself copied from v6's
// Round 1 prompt), renumbered 6–11 and worded for levels. Copied, not
// imported, so the two prompts can be tuned separately. Two changes beyond
// the wording (Roni, 2026-09-28: "I don't want forced pairings"): the
// "no forced pairings" paragraph at the top, and §8 / §9 no longer push
// fusions or a 4–6 genre count when the level's genres don't fit together.
const COHERENCE_SECTION = `## Coherence Inside Each Direction

A direction is played as one continuous stretch of the mix, so everything inside it must belong together. These rules decide which genres may share a direction.

**Above all — no forced pairings.** Only put genres together in a direction when they genuinely make sense together musically. A genre that doesn't blend naturally with any other genre of its level gets a direction of its own: a single-genre direction is always better than a forced pairing. Never add a genre to a direction to reach a genre count, to use up a genre, or to make a level's directions look richer.

### 6. Absolute Energy & Dynamic Cohesion (Zero Tolerance for Mismatches)

- **Unbroken Dynamic & Rhythm Compatibility:** Every direction MUST maintain a completely cohesive dynamic feel, rhythmic foundation, and energy level.
- **Strict Beat/Percussion Pairing Rules:** NEVER pair genres with strong rhythmic grooves, prominent drum patterns, or sexy/upbeat vibes (e.g., \`RnB\`, \`French RnB\`, \`Funk\`, \`Neo Soul\`) with ambient, drumless, or slow acoustic genres (e.g., \`Late Night jazz\`, \`Piano Impressionism\`, \`Chamber music\`). Switching between a drum-driven beat and a beatless slow jazz track within the same direction is strictly forbidden.
- **Strict Energy Filtering within Regional Blends:** When combining cultural/regional music, remove high-energy outliers that break the room's vibe (e.g., if creating a mid-tempo Mediterranean/Latin direction, pair Flamenco, Arab Classic, and Turk Arabesk, but strictly EXCLUDE high-energy festival genres like Samba, Salsa, or Dabke).

### 7. Jazz Isolation Rule

- **Jazz Sub-genres Containment:** All Jazz genres (\`Jazz (Standards)\`, \`Late Night jazz\`, \`Smooth Jazz\`, \`Swing Jazz\`, \`French Jazz\`, \`Gypsy jazz\`, \`JazzHop\`) are intrinsically laid-back, background, or seated styles. They MUST NEVER be paired with dancing, energetic, or heavy beat-driven genres (such as RnB, Hip Hop, Funk, Pop, or Dance).
- **Allowed Jazz Pairings:** Except for \`Ethio-Jazz\` and \`Acid Jazz\` (both rhythmic/uplifting and can blend with Afro/Funk/R&B styles) and \`Jazz House\` (enclosed under House rules), all Jazz genres can ONLY be paired with:
  - Other Jazz genres.
  - \`Bossa Nova\`
  - \`Fado\`

### 8. Multi-Cultural & Cross-Regional Genre Fusion

- **Avoid Monocultural Silos — but never force a fusion:** Do NOT restrict directions to a single geographic or stylistic domain (e.g., a "purely Latin" or "purely Arabic" direction) when the level holds genres from other regions that genuinely share the same energy and feel. A fusion is only right when it sounds natural; a single-region or single-genre direction is better than a forced one.
- **Maximize Complementary Global Genres:** Proactively weave together genres from different regions and cultural scenes that share the exact same energy and dynamic feel. The examples below name genres only to show the idea — use only genres from the approved list, in their own level.
  - *Example 1 (Cross-Cultural Lounge/Dining):* Blend Latin, Middle Eastern, Turkish, and European flavours (Flamenco, Arab Classic, Turk Arabesk, Rebetiko, Fado) under one cohesive mid-tempo vibe.
  - *Example 2 (Cross-Cultural Energetic Dining):* Blend Latin, Middle Eastern, Asian, and European flavours (Cha Cha Cha, Peruvian Cumbia, Anatolian Psychedelic Rock, Tishoumaren, Thai Molam, Samba-Choro) under one cohesive, not danceable yet groove-filled vibe.
  - *Example 3 (Global RnB & Soul):* Enrich standard R&B directions by incorporating international equivalents that share the exact same vibe and tempo tier, such as RnB, Neo Soul, Acid Jazz, French RnB, Japanese RnB, and Korean RnB.
  - *Example 4 (Global Funk & Groove):* Funk genres blend well with one another regardless of origin country (Funk, Afro Funk, Italian Funk, French Funk, Greek Funk, Arabic Funk, Latin Funk).
  - *Example 5 (Global Disco and City Pop):* Genres from around the world that share a similar groove background, such as a disco groove, pair naturally. In this case, Disco (not Nu Disco or Italo Disco) along with Japanese City Pop and Chinese City Pop.

### 9. Equal Genre Weight & Density (No Anchor Genre)

- **Holistic Direction Composition:** There is NO anchor genre. Every direction is defined as the unified sum of all its constituent genres.
- **Target Genre Count:** Aim for 4 to 6 genres per direction when the level holds that many genres that genuinely belong together, to create rich, varied sonic identities.
- **Fewer Genres (1–3):** A direction contains fewer than 4 genres (down to a single genre) whenever its level doesn't hold more approved genres that genuinely fit together with it, or when it serves an isolated, hyper-specific contextual need (e.g., pure שירי ארץ ישראל or dedicated electronic sub-genres) where adding external genres would destroy dynamic or cultural coherence. Never add a genre just to reach a count.
- **Stand-Alone / Near-Stand-Alone Genres:** Certain musical styles function effectively as a complete, standalone direction or paired with at most ONE closely related genre. If any of the following genres are in the approved list, you may present a direction consisting **solely of that genre** or **that genre plus one closely related style** from the same level:
  - \`Nu Metal\`
  - \`Indie Rock\`
  - \`Punk\`
  - \`Blues\`
  - \`Folk\`
  - \`Jazz House\`

### 10. Strict Pop Isolation Rule

- **Pop Isolation:** ALL Pop genres (including \`Bedroom Pop\`, \`Modern Pop\`, \`Female Pop\`, \`80s Pop\`, \`90's pop party\`, \`Electro Pop\`, \`Alternative Pop\`, \`K-Pop\`, \`פופ מזרחית\`, \`Cantopop\`) must NEVER be mixed with non-pop, niche, esoteric, acoustic, or electronic dance genres.
- **Pop-Only Pairs:** Pop sub-genres can ONLY be paired with other Pop sub-genres of matching energy tiers.
- **City Pop Exception:** City Pop sub-genres (\`Japanese City Pop\` and \`Chinese City Pop\`) are explicitly **EXEMPT** from the Pop Isolation rule and may be mixed with appropriate non-pop genres (such as Funk, Disco, or DownTempo) based on energy cohesion.

### 11. House & Techno Containment Rule

- **Strict House/Techno Enclosure:** With the sole exception of DownTempo (and French DownTempo), NO House or Techno genre may EVER be paired with non-House/Techno genres.
- **Allowed Pairings:** Genres like Deep House, Tech House, Afro House, Soulful House, Organic House, or Jazz House can ONLY be paired with other House genres or pure electronic dance styles of identical energy.`;

const TITLES_SECTION = `## Titles

### 12. Titles

\`title_en\` is a short English label, 3–6 words, that says what the direction sounds like (e.g. "Global Funk & Disco Grooves", "Late-Night Jazz & Bossa", "Mediterranean Acoustic Café"). English only. It is an internal label — the owner never sees it — so describe the music, not the time of day or the venue.`;

const OUTPUT_FORMAT = `## Output format

Return a single JSON object with exactly this shape, and NOTHING ELSE — no prose before or after, no markdown code fences around it. Do not add fields not listed here.

Normal case:
{
  "directions": [
    {"energy_level": 1, "title_en": "Late-Night Jazz & Bossa",     "genres": ["Late Night jazz", "Smooth Jazz", "Jazz (Standards)", "Bossa Nova", "Fado"]},
    {"energy_level": 1, "title_en": "Mediterranean Acoustic Café", "genres": ["Flamenco", "Arab Classic", "Turk Arabesk", "Rebetiko"]},
    {"energy_level": 3, "title_en": "Global Funk Grooves",         "genres": ["Funk", "Afro Funk", "Italian Funk", "Latin Funk", "Greek Funk"]},
    {"energy_level": 3, "title_en": "Disco & City Pop Glow",       "genres": ["Disco", "Japanese City Pop", "Chinese City Pop", "Funk"]}
    // ... for every level that has approved genres: as many as its genres genuinely support,
    //     at least 2 when it has 2 or more genres, 1 when it has a single genre, at most ${MAX_PER_LEVEL}
  ]
}

Field contracts:
- \`directions\`: array of \`{energy_level, title_en, genres}\`.
- \`energy_level\`: an integer — one of the levels that has approved genres in the input.
- \`title_en\`: a short English label for the direction.
- \`genres\`: a non-empty array of genre strings, each VERBATIM from the Genre Universe and each drawn ONLY from the approved genres listed under this direction's level.

Hard invariants:
- Every genre in every direction is an approved genre of that direction's level.
- Every genre string is VERBATIM from the Genre Universe.
- At least 2 directions for each level that has 2 or more approved genres; exactly 1 for a level with a single approved genre; none for a level with no approved genres.
- At most ${MAX_PER_LEVEL} directions per level.
- No two directions of the same level have the same set of genres.
- No direction puts together genres that don't make sense together musically.

Error case (return instead of directions):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

const WHEN_NOT_TO_RETURN_DIRECTIONS = `## When NOT to return directions

If the input genuinely has no approved genres to work with, return an error instead of fabricating directions.

Return \`{"error": "insufficient_signal", "reasoning_en": "..."}\` when the approved genres list is empty — there is nothing to build from.

Do NOT emit this error just because a level is small. A level with even one approved genre still gets its direction. Only error when there is genuinely nothing to work with.`;

// Composed editable prompt.
export const EDITABLE_PROMPT_SECTION = [
  LEVEL_DIRECTIONS_INTRO,
  GENRE_UNIVERSE_SECTION,
  LEVEL_DIRECTIONS_INPUTS_SECTION,
  LEVEL_RULES_SECTION,
  LIBRARY_SECTION,
  COHERENCE_SECTION,
  TITLES_SECTION,
].join('\n\n');

export const FIXED_PROMPT_SECTION = [
  OUTPUT_FORMAT,
  WHEN_NOT_TO_RETURN_DIRECTIONS,
].join('\n\n');

export function assembleSystemPrompt(editable) {
  return editable + '\n\n' + FIXED_PROMPT_SECTION;
}

const SYSTEM_PROMPT = assembleSystemPrompt(EDITABLE_PROMPT_SECTION);

// ---------- Helpers ----------

const CANONICAL_BY_LOWER = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
function canonicalize(genreString) {
  if (typeof genreString !== 'string') return null;
  return CANONICAL_BY_LOWER.get(genreString.trim().toLowerCase()) || null;
}

// Approved genres read the way the Option-2 builder reads them: canonical
// name, level rounded + clamped to 1..N. Unknown genres dropped.
export function approvedByLevel(approvedGenres, n) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(approvedGenres) ? approvedGenres : []) {
    const genre = canonicalize(typeof a === 'string' ? a : a?.genre);
    if (!genre || seen.has(genre)) continue;
    seen.add(genre);
    out.push({ genre, energy_level: Math.min(n, Math.max(1, Math.round(Number(a?.energy_level) || 1))) });
  }
  return out;
}

function levelLabel(L, n) {
  if (L === 1) return `Level 1 (calmest)`;
  if (L === n) return `Level ${L} (most energetic)`;
  return `Level ${L}`;
}

function formatPlaceBlock(place) {
  if (!place || typeof place !== 'object') return '';
  const bits = [];
  if (place.name) bits.push(`Name: ${place.name}`);
  const type = place.primary_type || place.type;
  if (type) bits.push(`Type: ${type}`);
  const summary = place.editorial_summary || place.summary;
  if (summary) bits.push(`Summary: ${summary}`);
  if (place.address) bits.push(`Address: ${place.address}`);
  if (!bits.length) return '';
  return `\n\n## Venue context\n${bits.join('\n')}`;
}

// approved = approvedByLevel(...) output.
export function buildUserMessage({ bizName, bizDesc, atmospheres, musicalEmphases, place, approved, energyLevelsTotal }) {
  const N = energyLevelsTotal;
  const nameLine = (bizName && String(bizName).trim()) ? String(bizName).trim() : 'none';
  const descLine = (bizDesc && String(bizDesc).trim()) ? String(bizDesc).trim() : 'none';
  const atmLine = Array.isArray(atmospheres) && atmospheres.length ? atmospheres.join(', ') : 'none';
  let s = `Energy levels total (N): ${N}\nBusiness name: ${nameLine}\nDescription: ${descLine}\nAtmospheres: ${atmLine}`;
  if (typeof musicalEmphases === 'string' && musicalEmphases.trim().length) s += `\nMusical emphases: ${musicalEmphases.trim()}`;
  s += `\n\n## Approved genres by energy level (the ONLY genres in play)`;
  for (let L = 1; L <= N; L++) {
    const gs = approved.filter((a) => a.energy_level === L).map((a) => a.genre);
    s += `\n\n### ${levelLabel(L, N)} — ${gs.length} genre${gs.length === 1 ? '' : 's'}\n`;
    s += gs.length ? gs.map((g) => `- ${g}`).join('\n') : '(no approved genres — build no directions for this level)';
  }
  s += formatPlaceBlock(place);
  return s + `\n\nFor every level that has approved genres, build a library of as many directions as its genres genuinely support (at least 2 when it has 2 or more genres, 1 when it has a single genre, at most ${MAX_PER_LEVEL}): each a coherent blend of that level's genres only — never pairing genres that don't belong together (a genre with no natural partner gets its own direction) — the directions of a level clearly different from one another.`;
}

// ---------- Validation & normalization ----------

// Coerce a raw model response into a well-formed directions array. Drops:
// - Directions whose energy_level isn't an integer in 1..N.
// - Genres not in the Genre Universe (case-normalised first), not approved,
//   or approved at a DIFFERENT level (the prompt's "silently dropped" promise).
// - Duplicate genres within a direction; directions left with no genre.
// - A direction whose level + genre set repeats an earlier one.
// - Everything past MAX_PER_LEVEL in a level.
// console.warns (never errors) for dropped genres and for a level with 2+
// genres that came back with fewer than 2 directions.
export function normalizeLevelDirections(parsed, approvedGenres, n) {
  if (!parsed || typeof parsed !== 'object') return null;
  const approved = approvedByLevel(approvedGenres, n);
  const levelOf = new Map(approved.map((a) => [a.genre, a.energy_level]));

  const directions = [];
  const seenSets = new Set();
  const perLevel = new Map();
  const dropped = [];
  for (const d of Array.isArray(parsed.directions) ? parsed.directions : []) {
    if (!d || typeof d !== 'object') continue;
    const L = Number(d.energy_level);
    if (!Number.isInteger(L) || L < 1 || L > n) continue;
    const genres = [];
    for (const g of Array.isArray(d.genres) ? d.genres : []) {
      const genre = canonicalize(g);
      if (!genre || levelOf.get(genre) !== L) { dropped.push(`${g} → L${L}`); continue; }
      if (!genres.includes(genre)) genres.push(genre);
    }
    if (!genres.length) continue;
    const setKey = `${L}|${[...genres].sort().join('|')}`;
    if (seenSets.has(setKey)) continue;
    if ((perLevel.get(L) || 0) >= MAX_PER_LEVEL) continue;
    seenSets.add(setKey);
    perLevel.set(L, (perLevel.get(L) || 0) + 1);
    const title = typeof d.title_en === 'string' && d.title_en.trim().length ? d.title_en.trim() : '(untitled)';
    directions.push({ energy_level: L, title_en: title, genres });
  }

  if (dropped.length) {
    console.warn('[v7 level-directions] dropped genres that are not approved at that level:', dropped.join(', '));
  }
  for (let L = 1; L <= n; L++) {
    const genreCount = approved.filter((a) => a.energy_level === L).length;
    const count = perLevel.get(L) || 0;
    if (genreCount && !count) console.warn(`[v7 level-directions] level ${L} has ${genreCount} genres but no direction`);
    else if (genreCount >= 2 && count < 2) console.warn(`[v7 level-directions] level ${L} returned fewer than 2 directions:`, count);
  }
  return { directions };
}

// ---------- Public entry point ----------

export async function generateLevelDirections({
  tasteProfile, bizName, bizDesc, atmospheres, musicalEmphases, place, businessId, onboardingSessionId,
  label = 'v7-level-directions',
}) {
  if (!tasteProfile || typeof tasteProfile !== 'object') {
    return { error: 'insufficient_signal', reasoning_en: 'missing or invalid taste profile' };
  }
  const energyLevelsTotal = normLevels(tasteProfile.energy_levels_total);
  const approved = approvedByLevel(tasteProfile.approved_genres, energyLevelsTotal);
  if (!approved.length) {
    return { error: 'insufficient_signal', reasoning_en: 'taste profile has no approved genres' };
  }

  const userMessage = buildUserMessage({
    bizName, bizDesc, atmospheres, musicalEmphases, place, approved, energyLevelsTotal,
  });

  let parsed;
  try {
    const { text } = await callModel({
      system: SYSTEM_PROMPT,
      userMessage,
      maxTokens: MAX_TOKENS,
      cache: true,           // Anthropic only; no-op on Gemini
      label,
      businessId,
      onboardingSessionId,
    });
    parsed = parseJSONFromText(text);
  } catch (e) {
    return { error: 'matcher_error', reasoning_en: e.message };
  }
  if (parsed?.error) {
    return { error: String(parsed.error), reasoning_en: typeof parsed.reasoning_en === 'string' ? parsed.reasoning_en : '' };
  }
  const normalized = normalizeLevelDirections(parsed, tasteProfile.approved_genres, energyLevelsTotal);
  if (!normalized) return { error: 'matcher_error', reasoning_en: 'level directions could not be parsed' };
  if (!normalized.directions.length) return { error: 'matcher_error', reasoning_en: 'level directions returned zero valid directions' };
  return { directions: normalized.directions };
}
