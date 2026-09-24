// v7 energy-directions generator — the stage that runs AFTER the taste
// profile is persisted and produces the seeds for v7's "Option 1" daily
// playlist mode (4 playlists/day = 2 high-energy + 2 low-energy).
//
// PLACEHOLDER: authored now so the prompt is designed alongside the taste
// profile, but the pipeline that calls it (v7's daily playlist builder) has
// not been built yet. When we wire v7's "Option 1" mode, this fires off the
// persisted taste profile to synthesise energy-tiered directions.
//
// Job: take the user's persisted taste profile — specifically its
// `approved_genres` list (each carrying a per-user energy_level 1..N) — and
// group ONLY those approved genres into a small set of "energy-tiered
// directions". The user's own dynamic energy scale (N = energy_levels_total)
// is split at its midpoint (N/2):
//   - HIGH tier = approved genres whose energy_level is in the UPPER half
//     (energy_level > N/2).
//   - LOW tier  = approved genres whose energy_level is in the LOWER half
//     (energy_level <= N/2).
// Within each tier the model forms small tight clusters of energy-and-vibe-
// similar genres (same spirit as v7's diagnostic probes — never dump a whole
// tier into one direction). The model decides how many directions each tier
// gets based on how many distinct clusters the tier holds, with a FLOOR of 2
// directions per tier.
//
// `conditional_genres` and `excluded_genres` are IGNORED — they are not even
// sent to the model. Only `approved_genres` are in play.
//
// Success return:
//   { directions: [
//       { energy_tier: 'high' | 'low', title_en: string, genres: [string, ...] },
//       ...
//     ] }
//   No rank, no bpm_range, no description_he — downstream persistence assigns
//   rank. Every genre string is a canonical string verbatim from the Genre
//   Universe.
//
// Error return:
//   { error: 'insufficient_signal' | 'matcher_error',
//     reasoning_en: '...' }

import { callModel, parseJSONFromText } from './ai-provider.js';
import { GENRE_UNIVERSE_SECTION, GENRES, GENRE_SET } from '../../shared/genre-universe.js';
export { GENRE_UNIVERSE_SECTION };

// Energy-directions output is small (a handful of directions, each a short
// title + a few genre strings). taste-profile uses Gemini's 65536 hard cap
// because it emits 116 genre entries; here 8192 is plenty even with thinking.
const MAX_TOKENS = 8192;

// ---------- Prompt sub-constants ----------

const ENERGY_DIRECTIONS_INTRO = `You group a user's approved music genres into a small set of "energy-tiered directions" for a public-facing-business playlist tool. The user has already completed onboarding and a full-catalog taste profile has been computed and persisted. You will receive ONLY the user's APPROVED genres — each tagged with a per-user energy level on the user's own dynamic energy scale — plus light venue context. Your job is to split the approved genres into a HIGH-energy tier and a LOW-energy tier, then form small, tight, energy-and-vibe-coherent clusters ("directions") WITHIN each tier. These directions become the seeds for the daily playlists (roughly two high-energy playlists and two low-energy playlists per day).`;

const ENERGY_DIRECTIONS_INPUTS_SECTION = `## Inputs

You will receive:

- **Approved genres** — the ONLY genres in play. Each entry is \`{genre, energy_level}\` where \`genre\` is a verbatim string from the Genre Universe and \`energy_level\` is an integer on the user's own scale.
- **Energy levels total (N)** — the size of the user's dynamic energy scale (an integer 2–6). Energy levels are RELATIVE to this user's own taste range, not absolute.
- Optionally: Business name.
- Optionally: Free-text description of the business (any language).
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases** — free-text preferences the owner typed during onboarding.
- Optionally: **Venue context** — a short block describing the physical venue (name / type / summary). Use it only to lightly inform how genres are grouped for venue-appropriateness; it does NOT add or remove genres.

You will NOT receive conditional or excluded genres. Do not ask for them, do not infer them, do not reintroduce them. Build directions strictly from the approved genres given.`;

const TIER_SPLIT_RULES_SECTION = `## Tier Split & Clustering Rules

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

### 3. Form directions WITHIN each tier — never mix tiers

A HIGH direction contains only HIGH-tier genres; a LOW direction contains only LOW-tier genres. NEVER place a high-energy genre in a low direction or a low-energy genre in a high direction. The whole point of the split is that each daily playlist has a coherent energy register — mixing tiers breaks that.

### 4. Small tight clusters, not one big dump per tier

Each direction is a small tight cluster of genres that are similar in energy AND vibe (instrumentation family, cultural register, mood) — same spirit as v7's diagnostic probes. Do NOT dump every high-energy genre into a single high direction; split a tier into coherent sub-clusters that each represent a distinct musical archetype within that energy register.

### 5. How many directions per tier — model's call, with a FLOOR of 2

You decide how many directions each tier gets based on how many distinct genres/clusters that tier holds. There is a HARD FLOOR of **2 directions per tier**:
- If a tier has plenty of genres, split it into as many coherent distinct clusters as make sense (aim for tight, non-redundant clusters).
- If a tier genuinely has very few genres, still return at least 2 directions for that tier — they may share or overlap genres if unavoidable, but prefer coherent distinct clusters whenever the genre count allows.
- Never return fewer than 2 directions for a tier that has any approved genres in it.

### 6. Titles

\`title_en\` is a short English label describing the cluster's character (e.g. "Late-Night Jazz", "Driving House Grooves"). English only. Keep it concise.`;

// Composed editable prompt.
export const EDITABLE_PROMPT_SECTION = [
  ENERGY_DIRECTIONS_INTRO,
  GENRE_UNIVERSE_SECTION,
  ENERGY_DIRECTIONS_INPUTS_SECTION,
  TIER_SPLIT_RULES_SECTION,
].join('\n\n');

const OUTPUT_FORMAT = `## Output format

Return a single JSON object with exactly this shape, and NOTHING ELSE — no prose before or after, no markdown code fences around it. Do not add fields not listed here.

Normal case:
{
  "directions": [
    {"energy_tier": "high", "title_en": "Driving House Grooves", "genres": ["Deep House", "Nu Disco"]},
    {"energy_tier": "high", "title_en": "Upbeat Funk & Soul",     "genres": ["Funk", "Disco"]},
    {"energy_tier": "low",  "title_en": "Late-Night Jazz",         "genres": ["Late Night jazz", "Smooth Jazz"]},
    {"energy_tier": "low",  "title_en": "Sultry Acoustic",         "genres": ["Bossa Nova", "Fado"]}
    // ... at least 2 directions per tier that has approved genres
  ]
}

Field contracts:
- \`directions\`: array of \`{energy_tier, title_en, genres}\`.
- \`energy_tier\`: exactly \`"high"\` or \`"low"\`.
- \`title_en\`: a short English label for the cluster.
- \`genres\`: a non-empty array of genre strings, each VERBATIM from the Genre Universe and each drawn ONLY from the approved genres you were given.

Hard invariants:
- Every genre in every direction must be one of the approved genres provided in the input.
- Every genre string must be VERBATIM from the Genre Universe.
- HIGH directions contain only HIGH-tier genres; LOW directions contain only LOW-tier genres.
- At least 2 directions for each tier that has any approved genres.

Error case (return instead of directions):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

const WHEN_NOT_TO_RETURN_DIRECTIONS = `## When NOT to return directions

If the input genuinely has no approved genres to work with, return an error instead of fabricating directions.

Return \`{"error": "insufficient_signal", "reasoning_en": "..."}\` when the approved genres list is empty — there is nothing to cluster.

Do NOT emit this error just because a tier is small. A tier with even one approved genre should still yield directions (per the FLOOR of 2 rule). Only error when there is genuinely nothing to work with.`;

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

function formatApprovedGenres(approved) {
  if (!Array.isArray(approved) || !approved.length) return '(none)';
  return approved
    .map((e) => `- ${e.genre} (energy level ${e.energy_level})`)
    .join('\n');
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

function buildUserMessage({
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

  base += `\n\n## Approved genres (the ONLY genres in play)\n${formatApprovedGenres(approvedGenres)}`;
  base += formatPlaceBlock(place);

  return base
    + `\n\nSplit these approved genres into HIGH and LOW energy tiers by the midpoint of the user's N-level scale, then form small tight clusters WITHIN each tier per the Tier Split & Clustering Rules. Return at least 2 directions per tier that has approved genres.`;
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
// - Duplicate genres within a single direction.
// - Directions left with zero valid genres.
// Emits a console.warn (but does NOT hard-error) when a tier comes back with
// fewer than 2 valid directions — a short tier is tolerated, not fabricated.
function normalizeEnergyDirections(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const rawDirections = Array.isArray(parsed.directions) ? parsed.directions : [];
  const directions = [];

  for (const d of rawDirections) {
    if (!d || typeof d !== 'object') continue;
    const tier = typeof d.energy_tier === 'string' ? d.energy_tier.trim().toLowerCase() : '';
    if (tier !== 'high' && tier !== 'low') continue;

    const seen = new Set();
    const genres = [];
    const rawGenres = Array.isArray(d.genres) ? d.genres : [];
    for (const g of rawGenres) {
      const genre = canonicalize(g);
      if (!genre || seen.has(genre)) continue;
      genres.push(genre);
      seen.add(genre);
    }
    if (!genres.length) continue;

    const title = typeof d.title_en === 'string' && d.title_en.trim().length
      ? d.title_en.trim()
      : '(untitled)';

    directions.push({ energy_tier: tier, title_en: title, genres });
  }

  // Log (do not error) when a tier is short. Only warn for tiers that
  // actually produced at least one direction — a completely empty tier just
  // means the user had no approved genres in that half of their scale.
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

  const normalized = normalizeEnergyDirections(parsed);
  if (!normalized) {
    return { error: 'matcher_error', reasoning_en: 'energy directions could not be parsed' };
  }
  if (!normalized.directions.length) {
    return { error: 'matcher_error', reasoning_en: 'energy directions returned zero valid directions' };
  }
  return { directions: normalized.directions };
}
