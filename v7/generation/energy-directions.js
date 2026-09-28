// v7 energy-directions generator — runs when the owner picks the "Option 1"
// daily playlist type (4 playlists/day = 2 high-energy + 2 low-energy), from
// the first-login gate or the Profile tab. Runs in the browser (callModel
// fetches /api/v6/gemini); v7/account/app.js persists the result via
// /api/v7/account/save-energy-directions.
//
// Job: take the owner's persisted taste profile — specifically its
// `approved_genres` list (each carrying a per-user energy_level 1..N) — and
// build a LIBRARY of up to 30 directions (as many as the genres support)
// from ONLY those genres. The owner's
// own energy scale (N = energy_levels_total) is split at its midpoint (N/2):
//   - HIGH tier = approved genres whose energy_level > N/2.
//   - LOW tier  = approved genres whose energy_level <= N/2.
// Every direction sits wholly inside one tier. Each direction is a curated,
// internally coherent blend (v6 onboarding style: 4–6 genres, v6's energy /
// jazz / pop / house pairing rules, cross-cultural blends encouraged), and
// the directions in the library sound different from one another. Genres
// may repeat across directions without limit. Every day the daily builder
// draws 2 directions per tier at random, one direction per playlist
// (api/v7/account/_daily-builder.js planOption1). Tiers with few approved
// genres get fewer directions (floor 2) rather than near-duplicates.
//
// `conditional_genres` and `excluded_genres` are IGNORED — they are not even
// sent to the model. Only `approved_genres` are in play, and the normalizer
// enforces it: a genre that isn't approved, or sits in the other tier, is
// dropped from the direction.
//
// Success return:
//   { directions: [
//       { energy_tier: 'high' | 'low', title_en: string, genres: [string, ...] },
//       ...
//     ] }
//   No rank, no bpm_range, no description_he — downstream persistence assigns
//   rank. title_en is an internal descriptor (owners see fixed tier names).
//   Every genre string is a canonical string verbatim from the Genre Universe.
//
// Error return:
//   { error: 'insufficient_signal' | 'matcher_error',
//     reasoning_en: '...' }

import { callModel, parseJSONFromText } from './ai-provider.js';
import { GENRE_UNIVERSE_SECTION, GENRES, GENRE_SET } from '../../shared/genre-universe.js';
export { GENRE_UNIVERSE_SECTION };

// Gemini counts thinking tokens against the output cap. A 30-direction
// library plus thinking=high can outgrow the old 8192, so use Gemini's hard
// cap like R1 and the taste profile do.
const MAX_TOKENS = 65536;

// The prompt asks for as many directions as make sense, up to 30; the
// normalizer enforces the ceiling (no minimum — a small taste profile
// legitimately yields few).
export const MAX_DIRECTIONS = 30;

// ---------- Prompt sub-constants ----------

const ENERGY_DIRECTIONS_INTRO = `You build a library of "energy-tiered musical directions" for a public-facing-business playlist tool. The business owner has finished onboarding and has a taste profile: a list of APPROVED genres, each tagged with an energy level on the owner's own energy scale. From those genres you build a library of as many directions as make sense, up to 30. Each direction is a curated, internally coherent blend of genres — a complete musical concept that can carry one full playlist on its own — and every direction is either entirely HIGH-energy or entirely LOW-energy (calm). Every day the tool picks two HIGH directions and two LOW directions from your library at random and turns each one into a playlist, so the library must give the owner real variety from one day to the next.`;

const ENERGY_DIRECTIONS_INPUTS_SECTION = `## Inputs

You will receive:

- **Approved genres** — the ONLY genres in play. Each entry is \`{genre, energy_level}\` where \`genre\` is a verbatim string from the Genre Universe and \`energy_level\` is an integer on the user's own scale.
- **Energy levels total (N)** — the size of the user's dynamic energy scale (an integer 2–6). Energy levels are RELATIVE to this user's own taste range, not absolute.
- Optionally: Business name.
- Optionally: Free-text description of the business (any language).
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases** — free-text preferences the owner typed during onboarding.
- Optionally: **Venue context** — a short block describing the physical venue (name / type / summary). Use it only to lightly inform how genres are combined for venue-appropriateness; it does NOT add or remove genres.

You will NOT receive conditional or excluded genres. Do not ask for them, do not infer them, do not reintroduce them. Build directions strictly from the approved genres given.`;

const TIER_SPLIT_RULES_SECTION = `## Energy Tiers

### 1. Only approved genres are in play

Build every direction ONLY from the approved genres you were given. NEVER invent a genre, translate one, add a qualifier, or pull in a genre that is not in the approved list. Any string not present verbatim in both the approved list AND the Genre Universe will be silently dropped downstream.

### 2. Split the approved genres into two energy tiers by the user's own scale

The user's scale has N levels (N = energy levels total). Define the midpoint as \`N/2\`:
- **HIGH tier** = approved genres whose \`energy_level\` is in the UPPER half of the scale, i.e. \`energy_level > N/2\`.
- **LOW tier** = approved genres whose \`energy_level\` is in the LOWER half of the scale, i.e. \`energy_level <= N/2\`.

Every approved genre lands in exactly one tier based on its \`energy_level\`. Examples:
- N=4, midpoint 2: levels 3–4 are HIGH, levels 1–2 are LOW.
- N=6, midpoint 3: levels 4–6 are HIGH, levels 1–3 are LOW.
- N=2, midpoint 1: level 2 is HIGH, level 1 is LOW.

### 3. Every direction sits inside one tier — never mix tiers

A HIGH direction contains only HIGH-tier genres; a LOW direction contains only LOW-tier genres. NEVER place a high-energy genre in a low direction or a low-energy genre in a high direction. The whole point of the split is that each daily playlist has a coherent energy register — mixing tiers breaks that. A genre placed in the wrong tier will be silently dropped from its direction downstream.`;

const LIBRARY_SECTION = `## Library Size & Diversity

### 4. As many directions as make sense — up to 30

- There is no minimum. Build as many directions as the approved genres genuinely support, up to 30 in total.
- Split them between the two tiers roughly in proportion to how many approved genres each tier holds, with at least 2 directions for every tier that has any approved genres.
- Add a direction only if it is a genuinely different listening experience from the ones you already have. Never pad the library with near-duplicates to reach a number.

### 5. Diverse across the library

- Directions should sound clearly different from one another: vary the genre combinations, the mood, the cultural flavour, the instrumentation and the groove within each tier. For example, a HIGH tier might hold a global funk blend, a disco and city-pop blend, a driving house set and a Latin dance blend; a LOW tier might hold a late-night jazz blend, a Mediterranean acoustic blend and an ambient downtempo set.
- Use the whole approved list: every approved genre should appear in at least one direction.

### 6. Genre overlap between directions is fine

- The same genre may appear in as many directions as make sense — there is no limit on how many genres two directions share.
- The only thing to avoid is repeating a whole sound: no two directions may have the same set of genres, and don't return two directions whose genre lists are so close that they would sound the same.`;

// The coherence rules below are copied from v6's Round 1 prompt
// (v6/generation/musical-directions.js, as of 2026-09-02) — the owner-facing
// v6 directions were exactly this kind of curated blend. Copied, not
// imported, so v7 keeps no runtime dependency on v6 and Ami can tune these
// separately. Renumbered 7–12 and lightly adapted (approved genres only; no
// Non-Overlap rule — overlap is allowed here).
const COHERENCE_SECTION = `## Coherence Inside Each Direction

A direction is played as one continuous playlist, so everything inside it must belong together. These rules decide which genres may share a direction.

### 7. Absolute Energy & Dynamic Cohesion (Zero Tolerance for Mismatches)

- **Unbroken Dynamic & Rhythm Compatibility:** Every direction MUST maintain a completely cohesive dynamic feel, rhythmic foundation, and energy level.
- **Strict Beat/Percussion Pairing Rules:** NEVER pair genres with strong rhythmic grooves, prominent drum patterns, or sexy/upbeat vibes (e.g., \`RnB\`, \`French RnB\`, \`Funk\`, \`Neo Soul\`) with ambient, drumless, or slow acoustic genres (e.g., \`Late Night jazz\`, \`Piano Impressionism\`, \`Chamber music\`). Switching between a drum-driven beat and a beatless slow jazz track within the same direction is strictly forbidden.
- **Strict Energy Filtering within Regional Blends:** When combining cultural/regional music, remove high-energy outliers that break the room's vibe (e.g., if creating a mid-tempo Mediterranean/Latin direction, pair Flamenco, Arab Classic, and Turk Arabesk, but strictly EXCLUDE high-energy festival genres like Samba, Salsa, or Dabke).

### 8. Jazz Isolation Rule

- **Jazz Sub-genres Containment:** All Jazz genres (\`Jazz (Standards)\`, \`Late Night jazz\`, \`Smooth Jazz\`, \`Swing Jazz\`, \`French Jazz\`, \`Gypsy jazz\`, \`JazzHop\`) are intrinsically laid-back, background, or seated styles. They MUST NEVER be paired with dancing, energetic, or heavy beat-driven genres (such as RnB, Hip Hop, Funk, Pop, or Dance).
- **Allowed Jazz Pairings:** Except for \`Ethio-Jazz\` and \`Acid Jazz\` (both rhythmic/uplifting and can blend with Afro/Funk/R&B styles) and \`Jazz House\` (enclosed under House rules), all Jazz genres can ONLY be paired with:
  - Other Jazz genres.
  - \`Bossa Nova\`
  - \`Fado\`

### 9. Multi-Cultural & Cross-Regional Genre Fusion

- **Avoid Monocultural Silos:** Do NOT restrict directions to a single geographic or stylistic domain (e.g., avoid creating a "purely Latin" or "purely Arabic" direction if the approved genres allow for cross-cultural integration).
- **Maximize Complementary Global Genres:** Proactively weave together genres from different regions and cultural scenes that share the exact same energy and dynamic feel. The examples below name genres only to show the idea — use only genres from the approved list.
  - *Example 1 (Cross-Cultural Lounge/Dining):* Blend Latin, Middle Eastern, Turkish, and European flavours (Flamenco, Arab Classic, Turk Arabesk, Rebetiko, Fado) under one cohesive mid-tempo vibe.
  - *Example 2 (Cross-Cultural Energetic Dining):* Blend Latin, Middle Eastern, Asian, and European flavours (Cha Cha Cha, Peruvian Cumbia, Anatolian Psychedelic Rock, Tishoumaren, Thai Molam, Samba-Choro) under one cohesive, not danceable yet groove-filled vibe.
  - *Example 3 (Global RnB & Soul):* Enrich standard R&B directions by incorporating international equivalents that share the exact same vibe and tempo tier, such as RnB, Neo Soul, Acid Jazz, French RnB, Japanese RnB, and Korean RnB.
  - *Example 4 (Global Funk & Groove):* Funk genres blend well with one another regardless of origin country (Funk, Afro Funk, Italian Funk, French Funk, Greek Funk, Arabic Funk, Latin Funk).
  - *Example 5 (Global Disco and City Pop):* Genres from around the world that share a similar groove background, such as a disco groove, pair naturally. In this case, Disco (not Nu Disco or Italo Disco) along with Japanese City Pop and Chinese City Pop.

### 10. Equal Genre Weight & Density (No Anchor Genre)

- **Holistic Direction Composition:** There is NO anchor genre. Every direction is defined as the unified sum of all its constituent genres.
- **Target Genre Count:** Actively aim for 4 to 6 genres per direction to create rich, varied sonic identities.
- **Justified Minimal Exceptions (1–3 Genres):** A direction may contain fewer than 4 genres (1–3 genres) ONLY if it serves an isolated, hyper-specific contextual need (e.g., pure שירי ארץ ישראל or dedicated electronic sub-genres) where adding external genres would destroy dynamic or cultural coherence, or if its tier simply doesn't hold enough approved genres that fit together.
- **Stand-Alone / Near-Stand-Alone Genres:** Certain musical styles function effectively as a complete, standalone direction or paired with at most ONE closely related genre. If any of the following genres are in the approved list, you may present a direction consisting **solely of that genre** or **that genre plus one closely related style**:
  - \`Nu Metal\`
  - \`Indie Rock\`
  - \`Punk\`
  - \`Blues\`
  - \`Folk\`
  - \`Jazz House\`

### 11. Strict Pop Isolation Rule

- **Pop Isolation:** ALL Pop genres (including \`Bedroom Pop\`, \`Modern Pop\`, \`Female Pop\`, \`80s Pop\`, \`90's pop party\`, \`Electro Pop\`, \`Alternative Pop\`, \`K-Pop\`, \`פופ מזרחית\`, \`Cantopop\`) must NEVER be mixed with non-pop, niche, esoteric, acoustic, or electronic dance genres.
- **Pop-Only Pairs:** Pop sub-genres can ONLY be paired with other Pop sub-genres of matching energy tiers.
- **City Pop Exception:** City Pop sub-genres (\`Japanese City Pop\` and \`Chinese City Pop\`) are explicitly **EXEMPT** from the Pop Isolation rule and may be mixed with appropriate non-pop genres (such as Funk, Disco, or DownTempo) based on energy cohesion.

### 12. House & Techno Containment Rule

- **Strict House/Techno Enclosure:** With the sole exception of DownTempo (and French DownTempo), NO House or Techno genre may EVER be paired with non-House/Techno genres.
- **Allowed Pairings:** Genres like Deep House, Tech House, Afro House, Soulful House, Organic House, or Jazz House can ONLY be paired with other House genres or pure electronic dance styles of identical energy.`;

const TITLES_SECTION = `## Titles

### 13. Titles

\`title_en\` is a short English label, 3–6 words, that says what the direction sounds like (e.g. "Global Funk & Disco Grooves", "Late-Night Jazz & Bossa", "Mediterranean Acoustic Café"). English only. It is an internal label — the owner never sees it — so describe the music, not the time of day or the venue.`;

// Composed editable prompt.
export const EDITABLE_PROMPT_SECTION = [
  ENERGY_DIRECTIONS_INTRO,
  GENRE_UNIVERSE_SECTION,
  ENERGY_DIRECTIONS_INPUTS_SECTION,
  TIER_SPLIT_RULES_SECTION,
  LIBRARY_SECTION,
  COHERENCE_SECTION,
  TITLES_SECTION,
].join('\n\n');

const OUTPUT_FORMAT = `## Output format

Return a single JSON object with exactly this shape, and NOTHING ELSE — no prose before or after, no markdown code fences around it. Do not add fields not listed here.

Normal case:
{
  "directions": [
    {"energy_tier": "high", "title_en": "Global Funk Grooves",        "genres": ["Funk", "Afro Funk", "Italian Funk", "Latin Funk", "Greek Funk"]},
    {"energy_tier": "high", "title_en": "Disco & City Pop Glow",      "genres": ["Disco", "Japanese City Pop", "Chinese City Pop", "Funk"]},
    {"energy_tier": "low",  "title_en": "Late-Night Jazz & Bossa",    "genres": ["Late Night jazz", "Smooth Jazz", "Jazz (Standards)", "Bossa Nova", "Fado"]},
    {"energy_tier": "low",  "title_en": "Mediterranean Acoustic Café", "genres": ["Flamenco", "Arab Classic", "Turk Arabesk", "Rebetiko"]}
    // ... as many as make sense, up to 30 in total, at least 2 per tier that has approved genres
  ]
}

Field contracts:
- \`directions\`: array of \`{energy_tier, title_en, genres}\`.
- \`energy_tier\`: exactly \`"high"\` or \`"low"\`.
- \`title_en\`: a short English label for the direction.
- \`genres\`: a non-empty array of genre strings, each VERBATIM from the Genre Universe and each drawn ONLY from the approved genres you were given.

Hard invariants:
- Every genre in every direction must be one of the approved genres provided in the input.
- Every genre string must be VERBATIM from the Genre Universe.
- HIGH directions contain only HIGH-tier genres; LOW directions contain only LOW-tier genres.
- At least 2 directions for each tier that has any approved genres.
- No two directions have the same set of genres.
- At most 30 directions in total.

Error case (return instead of directions):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

const WHEN_NOT_TO_RETURN_DIRECTIONS = `## When NOT to return directions

If the input genuinely has no approved genres to work with, return an error instead of fabricating directions.

Return \`{"error": "insufficient_signal", "reasoning_en": "..."}\` when the approved genres list is empty — there is nothing to build from.

Do NOT emit this error just because the approved list or a tier is small. A tier with even one approved genre should still yield at least 2 directions (they may share genres). Only error when there is genuinely nothing to work with.`;

export const FIXED_PROMPT_SECTION = [
  OUTPUT_FORMAT,
  WHEN_NOT_TO_RETURN_DIRECTIONS,
].join('\n\n');

// No strict anchor-injection scheme (unlike v6's injectPlaces). Places is
// appended defensively to the user message when present — see buildUserMessage.
export function assembleSystemPrompt(editable) {
  return editable + '\n\n' + FIXED_PROMPT_SECTION;
}

const SYSTEM_PROMPT = assembleSystemPrompt(EDITABLE_PROMPT_SECTION);

// ---------- Helpers ----------

const tierOfLevel = (level, n) => (level > n / 2 ? 'high' : 'low');

// Approved genres grouped by tier (split computed here, same rule the prompt
// states), so the model doesn't have to do the midpoint arithmetic itself.
function formatApprovedGenres(approved, n) {
  if (!Array.isArray(approved) || !approved.length) return '(none)';
  const line = (e) => `- ${e.genre} (energy level ${e.energy_level})`;
  const high = approved.filter((e) => tierOfLevel(Number(e.energy_level), n) === 'high');
  const low  = approved.filter((e) => tierOfLevel(Number(e.energy_level), n) === 'low');
  return `### HIGH tier (energy level > ${n / 2})\n${high.map(line).join('\n') || '(none)'}`
    + `\n\n### LOW tier (energy level <= ${n / 2})\n${low.map(line).join('\n') || '(none)'}`;
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

export function buildUserMessage({
  bizName, bizDesc, atmospheres, musicalEmphases, place,
  approvedGenres, energyLevelsTotal,
}) {
  const nameLine = (bizName && String(bizName).trim()) ? String(bizName).trim() : 'none';
  const descLine = (bizDesc && String(bizDesc).trim()) ? String(bizDesc).trim() : 'none';
  const atmLine = Array.isArray(atmospheres) && atmospheres.length ? atmospheres.join(', ') : 'none';

  let base = `Energy levels total (N): ${energyLevelsTotal}`;
  base += `\nBusiness name: ${nameLine}`;
  base += `\nDescription: ${descLine}`;
  base += `\nAtmospheres: ${atmLine}`;
  if (typeof musicalEmphases === 'string' && musicalEmphases.trim().length) {
    base += `\nMusical emphases: ${musicalEmphases.trim()}`;
  }

  base += `\n\n## Approved genres (the ONLY genres in play)\n${formatApprovedGenres(approvedGenres, energyLevelsTotal)}`;
  base += formatPlaceBlock(place);

  return base
    + `\n\nBuild a library of as many directions as make sense, up to 30, from these approved genres: each direction a coherent blend inside a single tier, the directions diverse from one another, at least 2 per tier that has approved genres.`;
}

// ---------- Validation & normalization ----------

// Build a case-insensitive lookup so we can accept minor casing drift from
// the model ("deep house" → "Deep House") while still writing back the
// canonical spelling. GENRE_SET itself is case-sensitive.
const CANONICAL_BY_LOWER = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
function canonicalize(genreString) {
  if (typeof genreString !== 'string') return null;
  return CANONICAL_BY_LOWER.get(genreString.trim().toLowerCase()) || null;
}

// Coerce a raw model response into a well-formed directions array. Drops:
// - Directions whose energy_tier is not exactly 'high' or 'low'.
// - Genre strings not in the shared Genre Universe (case-normalised first).
// - Genres that aren't in the approved list, or whose energy level puts them
//   in the other tier (the prompt's "silently dropped downstream" promise).
// - Duplicate genres within a single direction.
// - Directions left with zero valid genres.
// - A direction whose tier + genre set repeats an earlier one.
// - Everything past MAX_DIRECTIONS (30).
// Emits console.warns (never hard-errors) for dropped genres, a tier with
// fewer than 2 directions.
export function normalizeEnergyDirections(parsed, approvedGenres, n) {
  if (!parsed || typeof parsed !== 'object') return null;

  const tierOfGenre = new Map();
  for (const e of Array.isArray(approvedGenres) ? approvedGenres : []) {
    const g = canonicalize(e?.genre);
    const level = Number(e?.energy_level);
    if (g && Number.isFinite(level)) tierOfGenre.set(g, tierOfLevel(level, n));
  }

  const rawDirections = Array.isArray(parsed.directions) ? parsed.directions : [];
  const directions = [];
  const seenSets = new Set();
  const dropped = [];

  for (const d of rawDirections) {
    if (directions.length >= MAX_DIRECTIONS) break;
    if (!d || typeof d !== 'object') continue;
    const tier = typeof d.energy_tier === 'string' ? d.energy_tier.trim().toLowerCase() : '';
    if (tier !== 'high' && tier !== 'low') continue;

    const seen = new Set();
    const genres = [];
    const rawGenres = Array.isArray(d.genres) ? d.genres : [];
    for (const g of rawGenres) {
      const genre = canonicalize(g);
      if (!genre || seen.has(genre)) continue;
      if (tierOfGenre.get(genre) !== tier) { dropped.push(`${g} → ${tier}`); continue; }
      genres.push(genre);
      seen.add(genre);
    }
    if (!genres.length) continue;

    const setKey = `${tier}|${[...genres].sort().join('|')}`;
    if (seenSets.has(setKey)) continue;
    seenSets.add(setKey);

    const title = typeof d.title_en === 'string' && d.title_en.trim().length
      ? d.title_en.trim()
      : '(untitled)';

    directions.push({ energy_tier: tier, title_en: title, genres });
  }

  if (dropped.length) {
    console.warn('[v7 energy-directions] dropped genres that are not approved for that tier:', dropped.join(', '));
  }
  // Only warn for tiers that produced at least one direction — a completely
  // empty tier just means the user had no approved genres in that half.
  const highCount = directions.filter((x) => x.energy_tier === 'high').length;
  const lowCount = directions.filter((x) => x.energy_tier === 'low').length;
  if (highCount >= 1 && highCount < 2) {
    console.warn('[v7 energy-directions] HIGH tier returned fewer than 2 directions:', highCount);
  }
  if (lowCount >= 1 && lowCount < 2) {
    console.warn('[v7 energy-directions] LOW tier returned fewer than 2 directions:', lowCount);
  }

  return { directions };
}

// ---------- Model call ----------

async function callEnergyDirections({ userMessage, label, businessId, onboardingSessionId }) {
  const { text } = await callModel({
    system: SYSTEM_PROMPT,
    userMessage,
    maxTokens: MAX_TOKENS,
    // System prompt is stable across users, so on Anthropic the ephemeral
    // cache kicks in after the first call. No-op on Gemini.
    cache: true,
    label,
    businessId,
    onboardingSessionId,
  });
  return parseJSONFromText(text);
}

// ---------- Public entry point ----------

export async function generateEnergyDirections({
  tasteProfile,
  bizName,
  bizDesc,
  atmospheres,
  musicalEmphases,
  place,
  businessId,
  onboardingSessionId,
}) {
  if (!tasteProfile || typeof tasteProfile !== 'object') {
    return { error: 'insufficient_signal', reasoning_en: 'missing or invalid taste profile' };
  }
  const approvedGenres = Array.isArray(tasteProfile.approved_genres)
    ? tasteProfile.approved_genres
    : [];
  if (!approvedGenres.length) {
    return { error: 'insufficient_signal', reasoning_en: 'taste profile has no approved genres to cluster' };
  }

  let energyLevelsTotal = Number(tasteProfile.energy_levels_total);
  if (!Number.isFinite(energyLevelsTotal)) energyLevelsTotal = 4;
  energyLevelsTotal = Math.max(2, Math.min(6, Math.round(energyLevelsTotal)));

  const userMessage = buildUserMessage({
    bizName, bizDesc, atmospheres, musicalEmphases, place,
    approvedGenres, energyLevelsTotal,
  });

  let parsed;
  try {
    parsed = await callEnergyDirections({
      userMessage,
      label: 'v7-energy-directions',
      businessId,
      onboardingSessionId,
    });
  } catch (e) {
    return { error: 'matcher_error', reasoning_en: e.message };
  }
  if (parsed?.error) {
    return {
      error: String(parsed.error),
      reasoning_en: typeof parsed.reasoning_en === 'string' ? parsed.reasoning_en : '',
    };
  }

  const normalized = normalizeEnergyDirections(parsed, approvedGenres, energyLevelsTotal);
  if (!normalized) {
    return { error: 'matcher_error', reasoning_en: 'energy directions could not be parsed' };
  }
  if (!normalized.directions.length) {
    return { error: 'matcher_error', reasoning_en: 'energy directions returned zero valid directions' };
  }
  return { directions: normalized.directions };
}
