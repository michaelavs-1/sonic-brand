// v7 onboarding probes in two decks (Ami, 2026-11-02) — calm first, then
// energetic (energetic was first until 2026-11-03), 6 probes each. Replaces
// musical-directions.js's 8 mixed probes in the onboarding
// (generateDeckDirections, label 'v7-onboarding'); Ami's prompt dashboard
// runs the same prompt.
//
// Same probe idea as musical-directions.js: each direction is a tight cluster
// of near-identical genres, the owner hears one song from it and likes or
// dislikes the whole cluster. New:
//   - The deck sets the side tested. Energetic-deck cards play songs at
//     energy 60–80, calm-deck cards at 30–50 (per-genre exceptions in
//     shared/genre-sides.js). The energetic deck then shapes the owner's
//     energetic daily playlists, the calm deck their calm ones.
//   - Ami's genre sides: a deck only uses its own side's genres plus the
//     genres that go both ways; a both-ways genre goes on a deck only where
//     that side fits the venue (a restaurant may want upbeat Flamenco but not
//     calm Flamenco). normalizeDeckDirections drops genres from the wrong side.
//   - Ami's families spread a deck's 6 probes across different musical worlds.
//   - A requested style gets one direction per deck its side fits (was: one
//     direction in all).
//   - The model also names the venue's category (venue_category: food-drink /
//     beauty / clothing, 2026-11-03), which picks the picture shown before each
//     deck (v7/images/deck-intro/).
// One call per deck; the two are independent, so they can run in parallel.
// Ranks: energetic deck 1–6, calm deck 7–12, whatever order they're shown in.
//
// Shared rules are imported from musical-directions.js. Bare imports only
// (server-reachable).
import { callModel, parseJSONFromText } from './ai-provider.js';
import { GENRE_UNIVERSE_SECTION, GENRES } from '../../shared/genre-universe.js';
import { DECK_WINDOWS, allowedOnDeck, genreSidesList } from '../../shared/genre-sides.js';
import {
  PROCESSING_RULES_SECTION,
  HOMOGENEITY_SECTION,
  ENERGY_PAIRING_SECTION,
  OUTPUT_LANGUAGE_SECTION,
  TITLE_RULES_SECTION,
  HEBREW_DESCRIPTION_SECTION,
  VENUE_PHRASE_SECTION,
  WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION,
  injectPlaces,
  normalizeVenuePhrase,
} from './musical-directions.js';

export const DECK_SIZE = 6;
export const DECK_RANK_START = { energetic: 1, calm: 1 + DECK_SIZE };
// The order the owner swipes the decks in (Ami, 2026-11-03: calm first).
export const DECK_ORDER = ['calm', 'energetic'];

// The venue's category, for the picture before each deck (Ami, 2026-11-03).
// Anything that fits none of them gets food-drink.
export const VENUE_CATEGORIES = ['food-drink', 'beauty', 'clothing'];
export const DEFAULT_VENUE_CATEGORY = 'food-drink';
export function normalizeVenueCategory(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return VENUE_CATEGORIES.includes(s) ? s : DEFAULT_VENUE_CATEGORY;
}

// ---------- Prompt sub-constants ----------

const DECK_INTRO = `You design diagnostic taste probes for a public-facing-business playlist tool. The business owner swipes through two decks of probes: a CALM deck first, then an ENERGETIC deck. You build ONE deck per call — the user message says which — of ${DECK_SIZE} tightly-clustered "musical directions" from a fixed genre universe. Each direction is a small group of near-identical genres — same instrumentation family, same cultural register, same mood. The owner hears one representative song from each direction and likes or dislikes the whole cluster as one taste vector. On the energetic deck that song comes from the genres' energetic side (track energy ${DECK_WINDOWS.energetic[0]}–${DECK_WINDOWS.energetic[1]} out of 100); on the calm deck from their calm side (energy ${DECK_WINDOWS.calm[0]}–${DECK_WINDOWS.calm[1]}). Downstream, the energetic deck shapes the owner's energetic daily playlists and the calm deck their calm ones; overlapping genres across two liked directions become a stronger signal, not a bug.`;

const DECK_INPUTS_SECTION = `## Inputs

You will receive:

- **Deck** — ENERGETIC or CALM: the deck you are building.
- Free-text description of the business (any language).
- Optionally: Business name.
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases** — free-text preferences the owner typed in a dedicated field. Contains styles they explicitly love, styles they want to avoid, general leanings (e.g. "no electronic at all", "as much R&B as possible", "only hits", "make each playlist varied and adventurous"). Usually short (1–3 sentences), any language.
- Optionally: **Known taste** and **turned-down genres** — only when Rubin re-runs the onboarding for an existing owner: a short portrait of their taste, written from their conversations with us, and the genres they turned down. Treat the portrait like the musical emphases (just below them in priority), and treat turned-down genres as exclusions.`;

export const GENRE_SIDES_SECTION = `## Genre Energy Sides & Families

Every genre in the Genre Universe has an energy side, set by our music curator:
- **Both ways** — the genre has a real calm side AND a real energetic side (calm R&B and upbeat R&B are different listening experiences). It may appear on either deck, or on both.
- **Energetic only** — energetic deck only.
- **Calm only** — calm deck only.

Genres are also grouped into families (musical worlds). Use the families to spread a deck's probes.

${genreSidesList()}`;

const DECK_RULES_SECTION = `## Deck Rules

- **Only this deck's genres:** the ENERGETIC deck uses Energetic-only and Both-ways genres; the CALM deck uses Calm-only and Both-ways genres. A genre from the other side is silently dropped downstream.
- **Test this deck's side:** a Both-ways genre on the energetic deck stands for its upbeat side, on the calm deck for its calm side. Cluster it with genres whose SAME side sounds alike (calm \`Rnb\` with calm \`Neo Soul\`; upbeat \`Rnb\` with upbeat \`Korean RnB\`).
- **Both-ways genres by fit, never by default:** put a Both-ways genre on a deck only when that side of it suits this venue. It does not need to appear on both decks — a restaurant may suit upbeat \`Flamenco\` but not calm \`Flamenco\`, or the reverse.
- **Spread across families:** the ${DECK_SIZE} probes of a deck come from as many different families as the venue allows. Two probes from the same family only when the venue strongly points there — and then they must still test clearly different taste vectors.
- **Requested styles, per deck:** a style the owner explicitly asked for gets ONE direction on each deck whose side of it fits the venue — so a Both-ways style may be tested twice, once upbeat and once calm, but never twice on the same deck. This replaces the "only one direction" count in the Processing Rules; the rest of that rule stands.`;

const DECK_DISTINCTNESS_SECTION = `## Direction Distinctness

The ${DECK_SIZE} clusters of a deck must represent distinctly different musical archetypes. Any two clusters should differ on at least two of: family, instrumentation family, cultural register, mood. If two of your clusters test the same taste vector you've wasted a probe slot — replace one of them with a new angle.

**Overlapping genres across clusters are allowed.** If a genre legitimately sits at the intersection of two archetypes, it may appear in both. When the owner likes two clusters that share a genre, the overlap becomes a stronger genre-level taste signal downstream — a feature, not a duplicate.`;

const DECK_TASK_WORKFLOW = `## Task Workflow

1. **Filter Genre Universe:** Keep only this deck's genres (Deck Rules), then permanently eliminate irrelevant genres for this venue/brand based on exclusions and business fit — including Both-ways genres whose side for this deck doesn't suit the venue.
2. **Build ${DECK_SIZE} Diagnostic Clusters:** Create ${DECK_SIZE} tightly-clustered directions from the surviving genres, spread across families, ensuring maximal diversity across the ${DECK_SIZE} probes. Only if this venue genuinely can't support ${DECK_SIZE} distinct probes on this side, return fewer (at least 3). Each direction must satisfy every rule above:
   - Deck Rules (this deck's genres and side, families, requested styles per deck)
   - Cluster Homogeneity & Broad Inter-Direction Diversity (single unified vibe per cluster; clusters as different from each other as the business allows)
   - Direction Distinctness (${DECK_SIZE} different archetypes; overlapping genres between clusters are allowed)
   - Critical Rules 0–0.3 (Electronic R&B isolation, Pure Pop isolation, DownTempo & LoFi independence, sound over geographic labels)
   - Beat & Percussion Pairing
   - Jazz Isolation Rule
   - House & Techno Containment Rule
   - Japanese Folk Restriction (from Processing Rules)
   Each direction must include:
   - **Genres list:** 3 to 6 genres from the pool that form a tight, near-identical cluster. Certain genres function well standalone or paired with one closely-related style (\`Nu Metal\`, \`Indie Rock\`, \`Punk\`, \`Blues\`, \`Folk\`, \`Jazz House\`) — these may form a 1–2 genre cluster if that best fits the venue's needs.
3. **Rank Directions:** Rank directions by relevance to the business (best fit first).`;

const VENUE_CATEGORY_SECTION = `## Rules for the Venue Category (\`venue_category\`)

Alongside the directions, return the business's category. It picks the illustration the owner sees before each deck. Exactly one of:
- \`"food-drink"\` — the business serves food or drink: restaurants, cafés, bars, pubs, wine bars, bakeries, ice-cream and juice shops, hotel bars and lobbies.
- \`"beauty"\` — the business deals with hair, cosmetics or beauty: hair salons, barbershops, nail and beauty salons, spas, cosmetics and makeup shops, beauty clinics.
- \`"clothing"\` — a shop that sells clothing: fashion boutiques, clothing, shoe and accessories stores.

Decide from the description, the business name and the Google Places context. A business that fits none of them (a gym, an office, a bookstore, a furniture store…) gets \`"food-drink"\`. One that fits two (a café inside a clothing store) gets the one its description centres on.`;

export const DECK_EDITABLE_PROMPT_SECTION = [
  DECK_INTRO,
  GENRE_UNIVERSE_SECTION,
  GENRE_SIDES_SECTION,
  DECK_INPUTS_SECTION,
  PROCESSING_RULES_SECTION,
  DECK_RULES_SECTION,
  HOMOGENEITY_SECTION,
  DECK_DISTINCTNESS_SECTION,
  ENERGY_PAIRING_SECTION,
  DECK_TASK_WORKFLOW,
  OUTPUT_LANGUAGE_SECTION,
  TITLE_RULES_SECTION,
  HEBREW_DESCRIPTION_SECTION,
  VENUE_PHRASE_SECTION,
  VENUE_CATEGORY_SECTION,
].join('\n\n');

const DECK_OUTPUT_FORMAT = `## Output format

Return a single JSON object with exactly this shape, and NOTHING ELSE — no prose before or after, no markdown code fences around it. Do not add fields not listed here.

Normal case:
{
  "directions": [
    {
      "rank": 1,
      "title_en": "English title, 3-6 words (see Rules for English Titles)",
      "genres": ["...", "...", "..."],
      "description_he": "Hebrew description, 1-2 sentences, 15-30 words total: the sound, then a statement starting with בודק (see Rules for Hebrew Descriptions)",
      "instrumentalness_preference": "none",
      "popularity_preference": "none"
    }
    // ... ${DECK_SIZE} directions (this deck only)
  ],
  "venue_phrase_he": "Hebrew phrase: the type of business + one adjective (see Rules for the Venue Phrase)",
  "venue_category": "food-drink"
}

The \`venue_category\` field is one of \`"food-drink"\` | \`"beauty"\` | \`"clothing"\`. See the Rules for the Venue Category.

The \`instrumentalness_preference\` field is one of \`"none"\` | \`"soft"\` | \`"hard"\`. See the "Instrumentalness preference" sub-rule under Processing Rules for when to use each. Default is \`"none"\`.

The \`popularity_preference\` field is also one of \`"none"\` | \`"soft"\` | \`"hard"\`. See the "Popularity preference" sub-rule under Processing Rules. Default is \`"none"\`. Unlike \`instrumentalness_preference\`, this field DOES influence your genre picks — see the sub-rule for the hit-friendly vs esoteric genre lists.

Error case (return instead of directions):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

export const DECK_FIXED_PROMPT_SECTION = [
  DECK_OUTPUT_FORMAT,
  WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION.replace('(produce 8 directions)', '(produce the deck)'),
].join('\n\n');

export function assembleDeckSystemPrompt(editable) {
  return injectPlaces(editable) + '\n\n' + DECK_FIXED_PROMPT_SECTION;
}

// ---------- User message ----------

const DECK_TASK = {
  energetic: `DECK: ENERGETIC — build the energetic deck: ${DECK_SIZE} probes from Energetic-only and Both-ways genres, each testing the upbeat side of its genres.`,
  calm: `DECK: CALM — build the calm deck: ${DECK_SIZE} probes from Calm-only and Both-ways genres, each testing the calm side of its genres.`,
};

function formatPlaceContext(place) {
  if (!place || typeof place !== 'object') return null;
  const types = Array.isArray(place.types) && place.types.length ? place.types.join(', ') : 'none';
  const vibe = place.vibe && typeof place.vibe === 'object' ? place.vibe : {};
  const vibeLine = Object.entries(vibe).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  return [
    'Google Places context:',
    `  primary_type: ${place.primary_type || 'unknown'}`,
    `  types: ${types}`,
    `  editorial_summary: ${place.editorial_summary ? String(place.editorial_summary) : 'none'}`,
    `  price_level: ${place.price_level ? String(place.price_level) : 'unknown'}`,
    `  vibe: ${vibeLine}`,
  ].join('\n');
}

// Re-onboarding an existing owner (Ami's dashboard, 2026-11-02): what we
// already know about them. Empty for a real onboarding.
function knownTasteLines({ knownTaste, turnedDown }) {
  let s = '';
  if (typeof knownTaste === 'string' && knownTaste.trim()) s += `\nKnown taste (Rubin's portrait of this owner, from their conversations with us): ${knownTaste.trim()}`;
  const out = Array.isArray(turnedDown) ? turnedDown.filter((g) => typeof g === 'string' && g) : [];
  if (out.length) s += `\nGenres the owner turned down (exclude them): ${out.join(', ')}`;
  return s;
}

export function buildDeckUserMessage({ deck, bizName, bizDesc, atmospheres, musicalEmphases, place, knownTaste, turnedDown }) {
  const nameLine = (bizName && String(bizName).trim()) ? String(bizName).trim() : 'none';
  const atmLine = Array.isArray(atmospheres) && atmospheres.length ? atmospheres.join(', ') : 'none';
  let s = `Description: ${bizDesc}\nBusiness name: ${nameLine}\nAtmospheres: ${atmLine}`;
  if (typeof musicalEmphases === 'string' && musicalEmphases.trim().length) s += `\nMusical emphases: ${musicalEmphases.trim()}`;
  s += knownTasteLines({ knownTaste, turnedDown });
  const placeBlock = formatPlaceContext(place);
  if (placeBlock) s += `\n${placeBlock}`;
  return s + `\n\n${DECK_TASK[deck]}`;
}

// ---------- Validation & normalization ----------

const CANON = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
const PREFS = new Set(['none', 'soft', 'hard']);
const pref = (v) => (typeof v === 'string' && PREFS.has(v.trim().toLowerCase()) ? v.trim().toLowerCase() : 'none');
const hasHouse = (d) => d.genres.some((g) => /house/i.test(g));

// The model's deck → directions tagged with `deck`, ranked from the deck's
// start (energetic 1–6, calm 7–12; Round 2 passes its own start and max 4),
// house clusters last (same as R1). Drops genres not in the Genre Universe or
// not allowed on this deck, then directions left with no genre; keeps at most
// `max`.
// → { directions, dropped: ['Genre → calm', …] } or null.
export function normalizeDeckDirections(parsed, deck, { rankStart = DECK_RANK_START[deck], max = DECK_SIZE } = {}) {
  if (!parsed || typeof parsed !== 'object' || !DECK_RANK_START[deck]) return null;
  const dropped = [];
  const out = [];
  for (const d of Array.isArray(parsed.directions) ? parsed.directions : []) {
    if (!d || typeof d.title_en !== 'string' || !d.title_en.trim()) continue;
    if (typeof d.description_he !== 'string' || !d.description_he.trim()) continue;
    const genres = [];
    for (const g of Array.isArray(d.genres) ? d.genres : []) {
      const c = typeof g === 'string' ? CANON.get(g.trim().toLowerCase()) : null;
      if (!c || !allowedOnDeck(c, deck)) { dropped.push(`${g} → ${deck}`); continue; }
      if (!genres.includes(c)) genres.push(c);
    }
    if (!genres.length) continue;
    out.push({
      rank: Number(d.rank) || 999,
      title_en: d.title_en.trim(),
      genres,
      description_he: d.description_he.trim(),
      instrumentalness_preference: pref(d.instrumentalness_preference),
      popularity_preference: pref(d.popularity_preference),
      deck,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  out.sort((a, b) => (hasHouse(a) ? 1 : 0) - (hasHouse(b) ? 1 : 0));
  const directions = out.slice(0, max);
  directions.forEach((d, i) => { d.rank = rankStart + i; });
  return { directions, dropped };
}

// ---------- Onboarding entry point ----------

const MAX_TOKENS = 65536;
const SYSTEM_PROMPT = assembleDeckSystemPrompt(DECK_EDITABLE_PROMPT_SECTION);

async function callDeck(deck, inputs) {
  try {
    const { text } = await callModel({
      system: SYSTEM_PROMPT,
      userMessage: buildDeckUserMessage({ deck, ...inputs }),
      maxTokens: MAX_TOKENS,
      label: inputs.label || 'v7-onboarding',
      onboardingSessionId: inputs.onboardingSessionId,
    });
    const parsed = parseJSONFromText(text);
    if (parsed?.error) {
      return { error: String(parsed.error), reasoning_en: typeof parsed.reasoning_en === 'string' ? parsed.reasoning_en : '' };
    }
    const norm = normalizeDeckDirections(parsed, deck);
    if (!norm?.directions.length) return { error: 'matcher_error', reasoning_en: `no valid directions in the ${deck} deck` };
    return {
      directions: norm.directions,
      venuePhrase: normalizeVenuePhrase(parsed.venue_phrase_he),
      venueCategory: normalizeVenueCategory(parsed.venue_category),
    };
  } catch (e) {
    return { error: 'matcher_error', reasoning_en: e.message };
  }
}

// Both decks are requested at once. Resolves with the deck the owner swipes
// first (DECK_ORDER: calm) as `directions`; the other deck comes as
// `page2Promise` → { directions } | { error } — the same shape the swipe
// deck's preparePreview already takes for its second page. An error on the
// first deck fails the whole step (the venue-related codes —
// not_a_music_venue… — come back the same from both calls). The venue phrase
// and category come from the first deck's answer.
// knownTaste / turnedDown / label: re-onboarding an existing owner only.
export async function generateDeckDirections({ bizName, bizDesc, atmospheres, musicalEmphases, place, onboardingSessionId, knownTaste, turnedDown, label }) {
  if (!bizDesc || typeof bizDesc !== 'string' || bizDesc.trim().length < 3) {
    return { error: 'insufficient_description', reasoning_en: 'empty or too-short description' };
  }
  const inputs = { bizName, bizDesc, atmospheres, musicalEmphases, place, onboardingSessionId, knownTaste, turnedDown, label };
  const [firstDeck, secondDeck] = DECK_ORDER;
  const second = callDeck(secondDeck, inputs);
  const first = await callDeck(firstDeck, inputs);
  if (first.error) return first;
  return {
    directions: first.directions,
    page2Promise: second.then(({ directions, error, reasoning_en }) => (error ? { error, reasoning_en } : { directions })),
    venuePhrase: first.venuePhrase,
    venueCategory: first.venueCategory,
  };
}
