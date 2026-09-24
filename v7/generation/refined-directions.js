// v7 refined-directions generator — Round 2 refinement.
//
// Fires from v7/app.js only when R1's swipe deck yielded fewer than 3 liked
// directions. Inputs: every R1 input + the R1 probes the owner saw + their
// liked / disliked / super-liked-genre decisions + optional R2 refinement
// emphases. Output: 4 new diagnostic probes for a second swipe deck.
//
// Relationship to R1 — the same pattern v6 R2 follows with v6 R1:
//   - Every shared R1 rule section is IMPORTED verbatim (Genre Universe,
//     Processing Rules, Cluster Homogeneity, Energy & Pairing Constraints,
//     Output Language, Title rules, Hebrew Description rules, When-Not-To-
//     Return), so edits Ami makes to R1 flow into R2 automatically.
//   - R1's round-specific sections (intro, inputs, distinctness, task
//     workflow, output format) are re-authored for Round 2 but keep R1's
//     concrete parameters (3–6 genres, the standalone-genre list, 3–6-word
//     titles, same output fields, same rule list).
//   - A Round-2-only Learning section applies R1's design philosophy to the
//     owner's decisions. v6 R2 (blend world) looked for "bridge genres" sharing
//     ANY axis with the likes. v7 R2 (probe world) maps the NEIGHBOURHOOD of
//     each liked probe: re-confirm it with fresh tight-cluster neighbours, and
//     test adjacent archetypes that move one or two of its four axes — while
//     every individual probe stays internally homogeneous.
//   - R1's Direction Distinctness (differ on ≥ 2 axes) is replaced by a Round-2
//     version (differ on ≥ 1 axis when refining around likes; ≥ 2 when there
//     are zero likes and Round 2 is exploring). Importing R1's rule as-is made
//     4 probes impossible to build around 1–2 liked probes.
//
// Success return:
//   { directions: [4 objects, ranks 9-12] }   (see R2_RANK_START below)
//
// Error return:
//   { error: 'not_a_music_venue' | 'insufficient_description' |
//            'off_topic' | 'insufficient_signal' | 'matcher_error',
//     reasoning_en: '...' }

import { callModel, parseJSONFromText } from './ai-provider.js';
import {
  GENRE_UNIVERSE_SECTION,
  PROCESSING_RULES_SECTION,
  HOMOGENEITY_SECTION,
  ENERGY_PAIRING_SECTION,
  OUTPUT_LANGUAGE_SECTION,
  TITLE_RULES_SECTION,
  HEBREW_DESCRIPTION_SECTION,
  WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION,
  injectPlaces,
} from './musical-directions.js';

const MAX_TOKENS = 65536;

// ---------- Round 2 prompt sections ----------

const REFINED_INTRO = `You are refining a previously generated set of diagnostic taste probes for a public-facing-business playlist tool. In Round 1 the owner was shown up to 8 tightly-clustered "musical directions" — each a small group of near-identical genres (same energy tier, same instrumentation family, same cultural register, same mood) — heard one representative song from each, and liked fewer than 3. Your task now is to analyze their decisions — including which specific genres they super-liked a track from — and produce 4 brand-new diagnostic probes that pin down the parts of their taste Round 1 didn't. Each new probe is still a tight cluster, not a blended playlist. Downstream, every liked probe from either round dissolves into a flat liked-genres list — overlapping genres across two liked probes become a stronger signal, not a bug.`;

const REFINED_INPUTS_SECTION = `## Inputs

You will receive all Round 1 inputs plus the full Round 1 model output and the owner's per-direction decisions.

- Free-text description of the business (any language).
- Optionally: Business name.
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases (from Round 1 onboarding)** — the initial free-text preferences the owner supplied before seeing any tracks.
- Optionally: **Round 2 refinement emphases** — free-text feedback the owner typed AFTER seeing Round 1's preview tracks and choosing fewer than 3. Their freshest, most context-aware guidance. When present, this is the SINGLE STRONGEST signal you have — see Learning step 6. May be empty.
- Optionally: Google Places context — factual metadata about the venue, same shape as Round 1.
- **Round 1 directions** — the Round 1 probes the owner saw, each with rank (1–8), title, genres, description, and instrumentalness_preference. The Liked / Disliked lists below refer to these ranks.
- **Liked directions** — the 0, 1, or 2 probes the owner liked (may be empty).
- **Disliked directions** — the probes the owner swiped away.
- **Super-liked genres** — a deduped list of specific GENRES (not whole directions) that the owner super-liked at least one track from. Each entry is a single genre string from the Genre Universe. Super-liking is a sharper signal than merely liking a direction: the owner reacted specifically to a track drawn from that genre, so that genre carries extra positive weight beyond what its containing direction alone would suggest. May be empty.`;

const LEARNING_LOGIC_SECTION = `## Learning & Processing Logic (Round 2)

Perform this analysis BEFORE generating new clusters.

### 1. Extract Positive Seeds (Embrace)
- Collect all genres that appeared across the Liked directions. These form your Positive Genre Pool.
- Name the archetype of each liked probe — its energy tier, instrumentation family, cultural register, and mood. These liked archetypes are your **Positive Vectors**.
- **Super-liked genres carry extra weight.** Each is an individual genre (not a whole direction) that the owner super-liked a specific track from — a sharper positive signal than the composition of merely-liked directions. A super-liked genre is a Positive Vector in its own right, even when it came from a probe the owner otherwise disliked. Prioritize super-liked genres, or their neighbours from step 3, in your Working Pool.

### 2. Extract Negative Constraints (Strict Ban)
- Analyze the Disliked directions.
- Identify genres that appeared ONLY in disliked directions and NEVER in any liked direction or the super-liked list.
- Ban those genres (and their direct sub-genre equivalents) completely from your Round 2 output.
- Each disliked probe is also a rejected **archetype** (its energy tier + instrumentation family + cultural register + mood). Do not rebuild that archetype in Round 2 (see Direction Distinctness & Overlap — Round 2).

### 3. Map the Neighbourhood of the Positive Vectors
Round 1 told you roughly where the owner's taste lives; Round 2 probes find its edges. Cross-reference the Positive Genre Pool with the Genre Universe and collect two kinds of candidates:
- **Tight-cluster neighbours** — un-sampled genres that share ALL four axes (energy tier, instrumentation family, cultural register, mood) with a liked or super-liked genre, i.e. genres that could sit inside the same cluster as the seed. A probe built from them re-confirms a Positive Vector with fresh genres.
- **Adjacent-archetype genres** — genres whose archetype keeps most of a Positive Vector but moves ONE or TWO of its four axes (e.g. same cultural register and mood a step up or down in energy; same energy and mood with a different instrumentation family; a sibling cultural register with the same sound). This is the probe-world version of a "bridge": a probe built from them tests whether the owner's taste extends in that direction. Moving one axis is a safe refinement; moving two is a bolder exploration.
- Combine the Positive Genre Pool with these candidates to form your Round 2 Working Pool.
- Adjacency lives BETWEEN a probe and a Positive Vector — never inside a probe. Every probe you build from the pool must still pass Cluster Homogeneity on its own.

### 4. Honor Musical Emphases even in Round 2
- The Musical Emphases text from Round 1 still applies with its FULL priority — including any include-genre / exclude-genre / general-leaning rule, AND the Instrumentalness preference classification, AND the Popularity preference classification. If Round 1's likes contradict the Musical Emphases (rare), the Musical Emphases still win.
- Set every direction's \`instrumentalness_preference\` to the same value you would emit for Round 1 given the same emphases text (consistent across all 4 directions).
- Set every direction's \`popularity_preference\` the same way — same rule applies (uniform across the 4 directions unless the emphases text explicitly asked for per-direction variance).

### 5. Special case: zero Liked directions
If the Liked list is empty:
- Treat Description + Atmospheres + Musical Emphases + Round 2 refinement emphases (and any super-liked genres) as your positive signal.
- Use Disliked strictly as a negative filter — both its genres (step 2) and its archetypes.
- You are now exploring, not refining: build 4 archetypes that Round 1 did NOT test, consistent with the positive signal and away from every disliked archetype.
- If those positive inputs give too little signal AND the Disliked directions are internally contradictory (e.g., the owner disliked both a purely acoustic AND a purely electronic direction, offering no coherent negative filter), return \`{"error": "insufficient_signal", ...}\` rather than fabricating clusters from thin air.

### 6. Round 2 refinement emphases (highest priority when present)
When the owner supplied Round 2 refinement emphases, treat it as the STRONGEST signal available — above everything else, including the initial Round-1 Musical Emphases, the atmospheres, the super-liked genres, and the like/dislike buckets. It was written after they saw actual tracks and knew what they wanted more of or less of. When it contradicts any other signal, IT WINS.
- Genres or families explicitly requested: at least half of your 4 output clusters should center on them.
- Genres or families explicitly rejected: DROP them from every cluster, even if a Liked or super-liked genre would suggest them.
- General leanings ("more upbeat", "less electronic", "make them more surprising"): must shape every one of the 4 clusters, not just some.
- If empty or missing, fall back to steps 1–5 above.`;

const REFINED_DISTINCTNESS_SECTION = `## Direction Distinctness & Overlap (Round 2)

Round 1 required its 8 clusters to differ on at least two of the four axes. Round 2 deliberately works closer to the owner's positive signal, so the rule is adjusted:

- **Between your 4 Round 2 probes:** each must test a different taste vector — any two probes must differ on at least ONE of energy tier, instrumentation family, cultural register, mood. When the Liked list is empty (you are exploring, not refining), use Round 1's stricter rule: differ on at least TWO axes.
- **Probe mix when there are likes:** spend at most ONE probe per Positive Vector on a tight-cluster re-confirmation; use the rest on adjacent archetypes (Learning step 3). Four re-confirmations of the same liked probe waste the round.
- **Vs. Round 1 liked probes:** a Round 2 probe may share genres with a liked probe and be recognizably derived from it, but must not repeat it — at least half of its genres must be genres the owner wasn't already probed on in Round 1.
- **Vs. Round 1 disliked probes:** never rebuild a disliked probe's archetype (same energy tier + instrumentation family + cultural register + mood — that is exactly what the owner rejected). Sharing an individual genre with a disliked probe is fine only when that genre survived the ban in Learning step 2.
- **Overlapping genres between your Round 2 probes are allowed**, same as Round 1: if a genre legitimately sits inside two of your new archetypes, ship it in both — the overlap becomes a stronger genre-level taste signal downstream.`;

const REFINED_TASK_WORKFLOW = `## Task Workflow (Round 2)

1. Run the Learning & Processing Logic above to produce your Round 2 Working Pool.
2. Generate exactly 4 new diagnostic clusters from the Working Pool. Every cluster must satisfy every rule from the shared sections imported above:
   - Cluster Homogeneity (single unified vibe per cluster — energy / instrumentation / cultural register / mood)
   - Direction Distinctness & Overlap (Round 2) — 4 different taste vectors; overlapping genres allowed
   - Beat & Percussion Pairing
   - Jazz Isolation Rule
   - Pop Isolation Rule
   - House & Techno Containment Rule
   - Japanese Folk Restriction (from Processing Rules)
3. **Super-liked genre bias:** Ensure super-liked genres (or their neighbours from Learning step 3) appear in at least one of your 4 output clusters. If multiple super-liked genres are supplied, prefer to spread them across separate output clusters when the homogeneity rules allow — do NOT force every super-liked genre into a single cluster.
4. Each cluster must include:
   - **Genres list:** 3 to 6 genres from the Working Pool that form a tight, near-identical cluster. Certain genres may form a 1–2 genre standalone cluster (\`Nu Metal\`, \`Indie Rock\`, \`Punk\`, \`Blues\`, \`Folk\`, \`Jazz House\`) if that best fits the owner's taste.
   - **instrumentalness_preference:** Same value across all 4 clusters, derived from the Musical Emphases text using the same rules as Round 1 (\`"none"\` | \`"soft"\` | \`"hard"\`).
   - **popularity_preference:** Same value across all 4 clusters by default, derived from the Musical Emphases text using the same rules as Round 1 (\`"none"\` | \`"soft"\` | \`"hard"\`). If the emphases text explicitly asks for per-cluster variance (time-of-day / context-based), vary it to match. When set to \`"hard"\` or \`"soft"\`, it also influences your GENRE picks — skew away from esoteric genres, lean toward hit-friendly catalogs (see the Round-1 sub-rule for the full lists).
5. Rank clusters best-fit first based on strength of the taste signal.`;

const REFINED_OUTPUT_FORMAT = `## Output format

Return a single JSON object with exactly this shape, and NOTHING ELSE — no prose before or after, no markdown code fences around it. Do not add fields not listed here.

Normal case:
{
  "directions": [
    {
      "rank": 1,
      "title_en": "English title, 3-6 words (see Rules for English Titles)",
      "genres": ["...", "...", "..."],
      "description_he": "Hebrew description, 1-2 sentences, 10-25 words total (see Rules for Hebrew Descriptions)",
      "instrumentalness_preference": "none",
      "popularity_preference": "none"
    }
    // exactly 4 directions
  ]
}

The \`instrumentalness_preference\` field is one of \`"none"\` | \`"soft"\` | \`"hard"\`. Consistent across all 4 clusters, derived from the Musical Emphases text.

The \`popularity_preference\` field is also one of \`"none"\` | \`"soft"\` | \`"hard"\`. Same default of uniformity across the 4 clusters, with the per-cluster variance exception when the emphases text explicitly requests it. See the Round-1 "Popularity preference" sub-rule for classification.

Error case (return instead of directions):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

const ROUND2_ADDITIONAL_ERROR = `## Additional Round-2 error code

Return \`{"error": "insufficient_signal", "reasoning_en": "..."}\` ONLY when ALL of the following hold:
- The Liked directions list is empty.
- Description + Atmospheres + Musical Emphases together give too little positive signal to design new clusters.
- Disliked directions are internally contradictory (they don't point to a coherent negative filter).

Prefer this error over fabricating clusters from thin air. If any ONE of the three positive inputs still gives usable signal, produce clusters rather than erroring.`;

// Composed Round-2 system prompt. Places blocks are injected at the same
// anchors as Round 1 (see musical-directions.js:injectPlaces).
function assembleRefinedSystemPrompt() {
  const editable = [
    REFINED_INTRO,
    GENRE_UNIVERSE_SECTION,
    REFINED_INPUTS_SECTION,
    PROCESSING_RULES_SECTION,
    HOMOGENEITY_SECTION,
    ENERGY_PAIRING_SECTION,
    LEARNING_LOGIC_SECTION,
    REFINED_DISTINCTNESS_SECTION,
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

// Renders a single R1 direction as a labeled multi-line block referenced by
// its rank number, so the LIKED / DISLIKED / SUPER-LIKED buckets below can
// point back at them unambiguously.
function formatDirection(d) {
  const genres = directionGenres(d);
  const inst = d.instrumentalness_preference || 'none';
  const desc = d.description_he || '';
  return [
    `${d.rank}. "${d.title_en || '(no title)'}"`,
    `   genres: ${genres.join(', ') || '(none)'}`,
    `   inst_pref: ${inst}`,
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
    + `\n\nGenerate 4 refined diagnostic clusters per the Round-2 Task Workflow.`;
}

// ---------- validation & normalization (mirror of musical-directions.js) ----------

function validateDirection(d) {
  if (!d) return false;
  if (typeof d.title_en !== 'string' || !d.title_en.length) return false;
  if (typeof d.description_he !== 'string' || !d.description_he.length) return false;
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
    cache: true,
    label,
    onboardingSessionId,
  });
  return parseJSONFromText(text);
}

// Ranks in the returned directions are 9-12 (R2_RANK_START), continuing after
// Round 1's 1-8. v7 merges R2 picks into state.picked and the taste-profile
// prompt lists LIKED / DISLIKED ranks "combined R1+R2" — with R2 numbered
// 1-4 those ranks collided with R1's page 1 and the model couldn't tell which
// direction a rank meant. The model still emits 1-4; normalizeDirections
// renumbers. Preview keys anchors by rank, so any unique rank works there.
const R2_RANK_START = 9;
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
      label: 'v7-onboarding-refined',
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
  const directions = normalizeDirections(parsed, R2_RANK_START);
  if (!directions.length) {
    return { error: 'matcher_error', reasoning_en: 'no valid directions returned' };
  }
  return { directions };
}
