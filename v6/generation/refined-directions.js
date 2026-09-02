// v6 refined-directions generator — the Round-2 refinement step.
//
// Fires only when Round 1's preview swipe deck yielded fewer than 3 liked
// directions. Uses the same inputs as Round 1 PLUS the full Round 1 model
// output and the owner's per-direction decisions (liked / super-liked /
// disliked) to generate 4 brand-new directions that should be tighter
// matches to the owner's taste.
//
// Provider (Anthropic vs Gemini) is selected in ai-provider.js — same as
// Round 1. Round-2 calls are labeled 'onboarding-refined' in gemini_call_log
// so the admin API can break them out from the Round-1 spend.
//
// Success return:
//   { directions: [4 objects, ranks 1-4] }
//
// Error return:
//   { error: 'not_a_music_venue' | 'insufficient_description' |
//            'off_topic' | 'insufficient_signal' | 'matcher_error',
//     reasoning_en: '...' }
//
// insufficient_signal is Round-2-specific: fired when the owner liked 0
// directions AND the description/atmospheres/emphases give too little
// positive signal AND the dislikes are internally contradictory. Clients
// should treat it identically to "R2 finished with 0 likes" — jump the
// user to the restart-onboarding screen rather than fabricating output.

// Relative paths (not `/v6/...`) so Node's ESM resolver can load this file
// server-side. Browsers resolve `./ai-provider.js` and `./musical-directions.js`
// against this file's URL, so the resolved URLs are identical to what the
// old absolute paths produced. Cache-bust `?v=` still bumps the browser
// cache when the imports' contents change.
import { callModel, parseJSONFromText } from './ai-provider.js?v=25082026a';
import {
  GENRE_UNIVERSE_SECTION,
  PROCESSING_RULES_SECTION,
  ENERGY_PAIRING_SECTION,
  OUTPUT_LANGUAGE_SECTION,
  TITLE_RULES_SECTION,
  HEBREW_DESCRIPTION_SECTION,
  WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION,
  injectPlaces,
} from './musical-directions.js?v=02092026a';

// Same output cap as Round 1 — Gemini 3.6-flash hard limit. Only 4
// directions expected, so we're well under real usage; the ceiling
// prevents thinking-heavy responses from truncating.
const MAX_TOKENS = 65536;

// ---------- Round 2 prompt sections ----------

const REFINED_INTRO = `You are refining a previously generated set of musical directions for a public-facing business playlist tool. The business owner was presented with up to 8 musical directions in Round 1 and liked fewer than 3. Your task now is to analyze their picks — including which directions they super-liked — and produce 4 brand-new directions that are higher-precision matches to their taste.`;

const REFINED_INPUTS_SECTION = `## Inputs

You will receive all Round 1 inputs plus the full Round 1 model output and the owner's per-direction decisions.

- Free-text description of the business (any language).
- Optionally: Business name.
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases (from Round 1 onboarding)** — the initial free-text preferences the owner supplied before seeing any tracks.
- Optionally: **Round 2 refinement emphases** — free-text feedback the owner typed AFTER seeing Round 1's 8 preview tracks and choosing fewer than 3. Their freshest, most context-aware guidance. When present, this is the SINGLE STRONGEST signal you have — see Learning step 6. May be empty.
- Optionally: Google Places context — factual metadata about the venue, same shape as Round 1.
- **Round 1 directions** — the full set the model produced, each with rank, title, genres, bpm_range, description, and instrumentalness_preference.
- **Liked directions** — the 0, 1, or 2 directions the owner selected (may be empty).
- **Disliked directions** — the directions the owner rejected.
- **Super-liked genres** — a deduped list of specific GENRES (not whole directions) that the owner super-liked at least one track from. Each entry is a single genre string from the Genre Universe. Super-liking is a sharper signal than merely liking a direction: the owner reacted specifically to a track drawn from that genre, so that genre carries extra positive weight beyond what its containing direction alone would suggest. May be empty.`;

const LEARNING_LOGIC_SECTION = `## Learning & Processing Logic (Round 2)

Perform this analysis BEFORE generating new directions.

### 1. Extract Positive Seeds (Embrace)
- Collect all genres that appeared across the Liked directions. These form your Positive Genre Pool.
- Identify shared traits across the Liked directions: energy tier, tempo range, vocal vs. instrumental leaning, organic vs. synthesized production, regional character.
- **Super-liked genres carry extra weight.** Each is an individual genre (not a whole direction) that the owner super-liked a specific track from — a sharper positive signal than the composition of merely-liked directions. Prioritize including super-liked genres, or close bridges from step 3 built off them, in your Working Pool.

### 2. Extract Negative Constraints (Strict Ban)
- Analyze the Disliked directions.
- Identify genres that appeared ONLY in disliked directions and NEVER in any liked direction.
- Ban those genres (and their direct sub-genre equivalents) completely from your Round 2 output.

### 3. Identify Bridge & Expansion Genres
- Cross-reference the Positive Genre Pool with the Genre Universe.
- Find un-sampled genres that share **any strong axis of similarity** with the liked genres — energy tier, tempo range, production style (organic vs. synthesized, acoustic vs. electronic), dynamic feel, cultural/regional adjacency, atmospheric character (matches the venue's selected atmospheres), vocal treatment, or emotional register. A candidate genre only needs to align on one or two of these axes to qualify as a bridge — but the more axes it aligns on, the stronger the bridge.
- Combine the Positive Genre Pool with these Bridge Genres to form your Round 2 Working Pool.

### 4. Honor Musical Emphases even in Round 2
- The Musical Emphases text from Round 1 still applies with its FULL priority — including any include-genre / exclude-genre / general-leaning rule, AND the Instrumentalness preference classification, AND the Popularity preference classification. If Round 1's likes contradict the Musical Emphases (rare), the Musical Emphases still win.
- Set every direction's \`instrumentalness_preference\` to the same value you would emit for Round 1 given the same emphases text (consistent across all 4 directions).
- Set every direction's \`popularity_preference\` the same way — same rule applies (uniform across the 4 directions unless the emphases text explicitly asked for per-direction variance).

### 5. Special case: zero Liked directions
If the Liked list is empty:
- Treat Description + Atmospheres + Musical Emphases + Round 2 refinement emphases as your positive signal.
- Use Disliked strictly as a negative filter.
- If those positive inputs give too little signal AND the Disliked directions are internally contradictory (e.g., the owner disliked both a purely acoustic AND a purely electronic direction, offering no coherent negative filter), return \`{"error": "insufficient_signal", ...}\` rather than fabricating directions from thin air.

### 6. Round 2 refinement emphases (highest priority when present)
When the owner supplied Round 2 refinement emphases, treat it as the STRONGEST signal available — above everything else, including the initial Round-1 Musical Emphases, the atmospheres, the super-liked genres, and the like/dislike buckets. It was written after they saw actual tracks and knew what they wanted more of or less of. When it contradicts any other signal, IT WINS.
- Genres or families explicitly requested: at least half of your 4 output directions should center on them.
- Genres or families explicitly rejected: DROP them from every direction, even if a Liked or super-liked genre would suggest them.
- General leanings ("more upbeat", "less electronic", "make them more surprising"): must shape every one of the 4 directions, not just some.
- If empty or missing, fall back to steps 1–5 above.`;

const REFINED_NON_OVERLAP_SECTION = `## Direction Diversity & Non-Overlap Rules (Round 2)

- **Within Round 2:** No two Round-2 directions may share more than one single genre. (Same rule as Round 1's Max Overlap Constraint.)
- **Vs. Round-1 Liked directions:** Round 2 directions MAY share multiple genres with the owner's liked directions and MAY be recognizably derived from them — similar is allowed and encouraged. Only IDENTICAL specs (same title + same exact genre list) are forbidden.
- **Vs. Round-1 Disliked directions:** Round 2 directions must NOT share the overall shape of a disliked direction. One common genre is fine; matching more than one is a signal you're drifting toward what the owner rejected.`;

const REFINED_TASK_WORKFLOW = `## Task Workflow (Round 2)

1. Run the Learning & Processing Logic above to produce your Round 2 Working Pool.
2. Generate exactly 4 new directions from the Working Pool. Follow every rule from the shared Energy & Pairing Constraints (Absolute Energy & Dynamic Cohesion, Jazz Isolation Rule, Multi-Cultural Fusion, Equal Genre Weight + Standalone allowances, Strict Pop Isolation with City Pop Exception, House & Techno Enclosure) AND the Japanese Folk Restriction from Processing Rules.
3. **Super-liked genre bias:** Ensure super-liked genres (or their close bridges identified in Learning step 3) appear in at least one of your 4 output directions. If multiple super-liked genres are supplied, prefer to spread them across separate output directions when the energy tiers and pairing rules allow — do NOT force every super-liked genre into a single direction. The super-like signal is genre-weighting, not slot-dedication: no output direction has to be a "variant" of a Round-1 direction.
4. Each direction must include:
   - **Genres list:** 4 to 6 genres from the Working Pool (or 1–3 for justified isolated niche genres / standalone allowed genres).
   - **BPM ceiling:** An upper BPM limit only. Every direction covers 0 BPM up to that ceiling — do NOT set a lower floor. Emit \`bpm_range\` as \`{"min": 0, "max": <ceiling>}\`. Same rule as Round 1.
   - **instrumentalness_preference:** Same value across all 4 directions, derived from the Musical Emphases text using the same rules as Round 1 (\`"none"\` | \`"soft"\` | \`"hard"\`).
   - **popularity_preference:** Same value across all 4 directions by default, derived from the Musical Emphases text using the same rules as Round 1 (\`"none"\` | \`"soft"\` | \`"hard"\`). If the emphases text explicitly asks for per-direction variance (time-of-day / context-based), vary it to match. When set to \`"hard"\` or \`"soft"\`, it also influences your GENRE picks — skew away from esoteric genres, lean toward hit-friendly catalogs (see the Round-1 sub-rule for the full lists).
5. Rank directions best-fit first based on strength of the taste signal.`;

const REFINED_OUTPUT_FORMAT = `## Output format

Return a single JSON object with exactly this shape, and NOTHING ELSE — no prose before or after, no markdown code fences around it. Do not add fields not listed here.

Normal case:
{
  "directions": [
    {
      "rank": 1,
      "title_en": "English title, 4-7 words (see Rules for English Titles)",
      "genres": ["...", "...", "..."],
      "description_he": "Hebrew description, 1-2 sentences, 10-25 words total (see Rules for Hebrew Descriptions)",
      "bpm_range": {"min": 0, "max": 115},
      "instrumentalness_preference": "none",
      "popularity_preference": "none"
    }
    // exactly 4 directions
  ]
}

The \`instrumentalness_preference\` field is one of \`"none"\` | \`"soft"\` | \`"hard"\`. Consistent across all 4 directions, derived from the Musical Emphases text.

The \`popularity_preference\` field is also one of \`"none"\` | \`"soft"\` | \`"hard"\`. Same default of uniformity across the 4 directions, with the per-direction variance exception when the emphases text explicitly requests it. See the Round-1 "Popularity preference" sub-rule for classification.

Error case (return instead of directions):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

const ROUND2_ADDITIONAL_ERROR = `## Additional Round-2 error code

Return \`{"error": "insufficient_signal", "reasoning_en": "..."}\` ONLY when ALL of the following hold:
- The Liked directions list is empty.
- Description + Atmospheres + Musical Emphases together give too little positive signal to design new directions.
- Disliked directions are internally contradictory (they don't point to a coherent negative filter).

Prefer this error over fabricating directions from thin air. If any ONE of the three positive inputs still gives usable signal, produce directions rather than erroring.`;

// Composed Round-2 system prompt. Injects Places blocks at the same
// anchors as Round 1 (see musical-directions.js:injectPlaces).
function assembleRefinedSystemPrompt() {
  const editable = [
    REFINED_INTRO,
    GENRE_UNIVERSE_SECTION,
    REFINED_INPUTS_SECTION,
    PROCESSING_RULES_SECTION,
    ENERGY_PAIRING_SECTION,
    REFINED_NON_OVERLAP_SECTION,
    LEARNING_LOGIC_SECTION,
    REFINED_TASK_WORKFLOW,
    OUTPUT_LANGUAGE_SECTION,
    TITLE_RULES_SECTION,
    HEBREW_DESCRIPTION_SECTION,
  ].join('\n\n');
  const fixed = [
    REFINED_OUTPUT_FORMAT,
    WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION,
    ROUND2_ADDITIONAL_ERROR,
  ].join('\n\n');
  return injectPlaces(editable) + '\n\n' + fixed;
}

const REFINED_SYSTEM_PROMPT = assembleRefinedSystemPrompt();

// ---------- helpers ----------

function directionGenres(d) {
  if (Array.isArray(d.genres) && d.genres.length) return d.genres;
  return [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])]
    .filter((g) => typeof g === 'string' && g.length);
}

// Places context block matches the Round-1 formatter shape exactly so the
// model sees the same input format across both rounds.
function formatPlaceContext(place) {
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
    'Google Places context:',
    `  primary_type: ${place.primary_type || 'unknown'}`,
    `  types: ${types}`,
    `  editorial_summary: ${editorial}`,
    `  price_level: ${priceLevel}`,
    `  vibe: ${vibeLine}`,
  ].join('\n');
}

// Renders a single R1 direction as a labeled multi-line block referenced
// by its rank number, so the buckets below (LIKED / SUPER-LIKED / DISLIKED)
// can point back at them unambiguously.
function formatDirection(d) {
  const genres = directionGenres(d);
  const bpm = d.bpm_range || {};
  const bpmStr = (typeof bpm.min === 'number' && typeof bpm.max === 'number')
    ? `${bpm.min}-${bpm.max}` : '?-?';
  const inst = d.instrumentalness_preference || 'none';
  const desc = d.description_he || '';
  return [
    `${d.rank}. "${d.title_en || '(no title)'}"`,
    `   genres: ${genres.join(', ') || '(none)'}`,
    `   bpm_range: ${bpmStr}  |  inst_pref: ${inst}`,
    `   description_he: "${desc}"`,
  ].join('\n');
}

function buildRefinedUserMessage({
  bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases, place,
  round1Directions, likedDirections, dislikedDirections, superLikedGenres,
}) {
  const nameLine = (bizName && String(bizName).trim()) ? String(bizName).trim() : 'none';
  const atmLine = Array.isArray(atmospheres) && atmospheres.length ? atmospheres.join(', ') : 'none';
  let base = `Description: ${bizDesc}\nBusiness name: ${nameLine}\nAtmospheres: ${atmLine}`;
  if (typeof musicalEmphases === 'string' && musicalEmphases.trim().length) {
    base += `\nMusical emphases (from Round 1 onboarding): ${musicalEmphases.trim()}`;
  }
  if (typeof round2Emphases === 'string' && round2Emphases.trim().length) {
    base += `\nRound 2 refinement emphases (after seeing R1 tracks — HIGHEST PRIORITY): ${round2Emphases.trim()}`;
  }
  const placeBlock = formatPlaceContext(place);
  if (placeBlock) base += `\n${placeBlock}`;

  const round1Block = (Array.isArray(round1Directions) && round1Directions.length)
    ? round1Directions.map(formatDirection).join('\n\n')
    : '(none)';

  const rankList = (arr) => (Array.isArray(arr) && arr.length)
    ? arr.map((d) => d.rank).join(', ')
    : '(none)';

  const likedList = rankList(likedDirections);
  const dislikedList = rankList(dislikedDirections);
  const superLikedGenresList = (Array.isArray(superLikedGenres) && superLikedGenres.length)
    ? superLikedGenres.join(', ')
    : '(none)';

  return base
    + `\n\nRound 1 produced these directions:\n\n${round1Block}`
    + `\n\nOwner's decisions:`
    + `\n- LIKED (ranks): ${likedList}`
    + `\n- DISLIKED (ranks): ${dislikedList}`
    + `\n- SUPER-LIKED GENRES: ${superLikedGenresList}`
    + `\n\nGenerate 4 refined directions per the Round-2 Task Workflow.`;
}

// ---------- validation & normalization (mirror of musical-directions.js) ----------

function validateBpmRange(bpm) {
  return bpm && typeof bpm === 'object'
    && Number.isFinite(bpm.min) && Number.isFinite(bpm.max)
    && bpm.min <= bpm.max;
}

function validateDirection(d) {
  if (!d) return false;
  if (typeof d.title_en !== 'string' || !d.title_en.length) return false;
  if (typeof d.description_he !== 'string' || !d.description_he.length) return false;
  if (!validateBpmRange(d.bpm_range)) return false;
  const hasNew = Array.isArray(d.genres) && d.genres.length
    && d.genres.every((g) => typeof g === 'string' && g.length);
  const hasLegacy = typeof d.anchor_genre === 'string' && d.anchor_genre.length;
  return hasNew || hasLegacy;
}

const INST_PREFS = new Set(['none', 'soft', 'hard']);
const POP_PREFS  = new Set(['none', 'soft', 'hard']);
function normalizeInstPref(raw) {
  if (typeof raw !== 'string') return 'none';
  const v = raw.trim().toLowerCase();
  return INST_PREFS.has(v) ? v : 'none';
}
function normalizePopPref(raw) {
  if (typeof raw !== 'string') return 'none';
  const v = raw.trim().toLowerCase();
  return POP_PREFS.has(v) ? v : 'none';
}

function containsHouseGenre(d) {
  return Array.isArray(d.genres) && d.genres.some((g) => typeof g === 'string' && /house/i.test(g));
}

function normalizeDirections(parsed, rankStart) {
  if (!Array.isArray(parsed?.directions)) return [];
  const valid = parsed.directions.filter(validateDirection);
  valid.forEach((d) => {
    if (!Array.isArray(d.genres) || !d.genres.length) {
      d.genres = [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])]
        .filter((g) => typeof g === 'string' && g.length);
    }
    d.instrumentalness_preference = normalizeInstPref(d.instrumentalness_preference);
    d.popularity_preference       = normalizePopPref(d.popularity_preference);
    delete d.anchor_genre;
    delete d.secondary_genres;
  });
  valid.sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999));
  valid.sort((a, b) => (containsHouseGenre(a) ? 1 : 0) - (containsHouseGenre(b) ? 1 : 0));
  valid.forEach((d, idx) => { d.rank = rankStart + idx; });
  return valid;
}

// ---------- public entry point ----------

async function callRefined({ userMessage, label, onboardingSessionId }) {
  const { text } = await callModel({
    system: REFINED_SYSTEM_PROMPT,
    userMessage,
    maxTokens: MAX_TOKENS,
    // Round 2's system prompt is stable across users, same as Round 1's,
    // so Anthropic ephemeral cache kicks in if PROVIDER='anthropic'.
    // No-op on Gemini.
    cache: true,
    label,
    onboardingSessionId,
  });
  return parseJSONFromText(text);
}

// Ranks in the returned directions start at 1 — Round 2 is a separate
// picking round, not a continuation of Round 1's rank sequence. The
// caller (app.js) merges Round 2 picks into state.picked, and signup.js
// renumbers ranks 1..N at persistence time.
export async function generateRefinedMusicalDirections({
  bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases, place,
  round1Directions, likedDirections, dislikedDirections, superLikedGenres,
  onboardingSessionId,
}) {
  if (!bizDesc || typeof bizDesc !== 'string' || bizDesc.trim().length < 3) {
    return { error: 'insufficient_description', reasoning_en: 'empty or too-short description' };
  }
  if (!Array.isArray(round1Directions) || !round1Directions.length) {
    return { error: 'matcher_error', reasoning_en: 'Round 2 called with empty Round 1 directions' };
  }

  const userMessage = buildRefinedUserMessage({
    bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases, place,
    round1Directions, likedDirections, dislikedDirections, superLikedGenres,
  });

  let parsed;
  try {
    parsed = await callRefined({
      userMessage,
      label: 'onboarding-refined',
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
  const directions = normalizeDirections(parsed, 1);
  if (!directions.length) {
    return { error: 'matcher_error', reasoning_en: 'no valid directions returned' };
  }
  return { directions };
}
