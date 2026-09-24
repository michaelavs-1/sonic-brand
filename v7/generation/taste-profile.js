// v7 taste-profile generator — the stage that runs AFTER the diagnostic
// swipe deck (R1 + optional R2) and BEFORE any playlist is built.
//
// Fired by v7/app.js once after the last swipe deck resolves (behind the
// post-registration progress bar). Its output is sent with the signup
// request and persisted into business_taste_profiles — v7's replacement
// for the v6-style business_directions rows.
//
// Job: take the sparse swipe-deck signal (up to 12 direction probes across
// R1 + R2, plus per-direction like/dislike, plus per-track super-likes) and
// extrapolate to a full-catalog taste profile. Output:
//   - Every one of the 116 canonical genres bucketed into approved /
//     conditional / excluded. The model only LISTS approved + conditional;
//     excluded is computed here as "every canonical genre the model didn't
//     list" (since 2026-09-24 — saves the output tokens the model used to
//     spend re-listing the remainder).
//   - For every approved and conditional genre, a per-user energy level
//     (1..N where N is dynamic 2-6 based on the SPREAD of the user's
//     taste — hip hop is level 6 for a mostly-chill user, level 3 for a
//     rave user who also picked dubstep).
//   - The R1/R2-classified instrumentalness_preference and
//     popularity_preference, carried through unchanged.
//
// Conditional bucket is KEPT AS DATA ONLY for now — downstream playlist
// builder ignores it in v7's initial cut. We keep the model computing it
// because (a) the signal it captures is real, (b) tuning "conditional" is
// cheap while the model is already reasoning over the full catalog, and
// (c) we may activate it later.
//
// Success return:
//   { profile: {
//       energy_levels_total: <2..6>,
//       approved_genres: [{ genre, energy_level }, ...],
//       conditional_genres: [{ genre, energy_level, note_en }, ...],
//       excluded_genres: [string, ...],
//       instrumentalness_preference: 'none' | 'soft' | 'hard',
//       popularity_preference:       'none' | 'soft' | 'hard',
//       reasoning_en: string,
//     } }
//
// Error return:
//   { error: 'insufficient_signal' | 'matcher_error',
//     reasoning_en: '...' }

import { callModel, parseJSONFromText } from './ai-provider.js';
import { GENRE_UNIVERSE_SECTION, GENRES, GENRE_SET } from '../../shared/genre-universe.js';
export { GENRE_UNIVERSE_SECTION };

// Same output cap as R1/R2. The response can grow — 116 approved+conditional
// entries each carrying a genre + energy_level + optional note runs a few
// thousand tokens on its own, plus reasoning + thinking. 65536 is Gemini
// 3.6-flash's hard cap so we take all of it.
const MAX_TOKENS = 65536;

// ---------- Prompt sub-constants ----------

const TASTE_PROFILE_INTRO = `You classify a user's music taste for a public-facing-business playlist tool. The user has completed a diagnostic swipe deck of up to 12 tightly-clustered "musical direction" probes (Round 1 + optional Round 2). You will receive the probes plus the user's per-direction decisions (like / dislike) and their super-liked genres. Your job is to extrapolate that sparse signal to a full-catalog taste profile: for each of the 116 canonical genres, decide whether it belongs in the user's approved list, a conditional list, or neither. You only output the approved and conditional lists — every genre you leave out of both is treated as excluded. Then partition the approved and conditional genres into N energy levels (2–6, dynamic per user based on the SPREAD of their taste) so downstream playlist builders can slot each genre into the right operational context.`;

const TASTE_PROFILE_INPUTS_SECTION = `## Inputs

You will receive:

- Free-text description of the business (any language).
- Optionally: Business name.
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases** — free-text preferences the owner typed during onboarding.
- Optionally: **Round 2 refinement emphases** — free-text feedback the owner typed after seeing R1 tracks. When present, it is the freshest and STRONGEST signal.
- **Instrumentalness preference** and **popularity preference** — already classified in R1/R2 (\`"none"\` | \`"soft"\` | \`"hard"\`). Carried through unchanged. DO NOT re-classify; use them to shape your bucketing (see Processing Rules).
- **Round 1 directions** — up to 8 diagnostic probes, each with rank, title, genres, description.
- **Round 2 directions** (may be absent) — up to 4 additional refined probes if R2 fired.
- **User's per-direction decisions:**
  - LIKED (ranks): the direction indices the user swiped right on.
  - DISLIKED (ranks): the direction indices the user swiped left on.
- **SUPER-LIKED GENRES:** a deduped list of specific GENRES (not directions) the user super-liked at least one track from. Each entry is a single genre string from the Genre Universe. Super-liking is a sharper signal than merely liking a direction — the user reacted to a specific track drawn from that exact genre, so it carries extra positive weight.`;

const PROCESSING_RULES_SECTION = `### Processing Rules:

- **Musical Emphases (highest priority):** Treat the emphases text as the strongest signal — above description, atmospheres, and Google context. Genres or families the owner named to INCLUDE: bias toward \`approved\`. Genres or families they named to EXCLUDE: leave them out of both lists (excluded) even if they appear in a liked direction. General leanings ("adventurous", "hits only", "familiar", "not too energetic") shape the whole profile, not just some genres.
- **Round 2 refinement emphases (when present, HIGHEST priority):** Written after the user saw actual tracks — knows what they wanted more or less of. When it contradicts anything else (Round 1 emphases, atmospheres, direction-level likes/dislikes), IT WINS.
- **Instrumentalness preference (carry-through, do NOT re-classify):** Already set in R1/R2 and threaded into the input. It does NOT change your genre bucketing at this stage — downstream filters the track pool at query time. Just carry the value into the output verbatim.
- **Popularity preference (carry-through, do NOT re-classify):** Already set in R1/R2 and threaded into the input. When \`"hard"\` or \`"soft"\`, it DOES shape bucketing: esoteric / niche-only genres (e.g. \`Peruvian Chicha\`, \`Anatolian Psychedelic Rock\`, \`Tishoumaren\`, \`Dabke\`, \`Neo Exotica\`, \`Ethio-Jazz\`, \`Rebetiko\`, \`Laiko\`, \`Turk Arabesk\`, \`Medieval Music\`, \`Piano Impressionism\`) go to \`conditional\` at most — unless a direct like or super-like on that specific genre puts them in \`approved\`. When \`"none"\`: no effect on bucketing. Carry the value into the output verbatim regardless.
- **Japanese Folk Restriction:** Leave \`Japanese Folk\` out of both lists (excluded) UNLESS the venue is explicitly a Japanese business needing particularly calm/relaxing music OR the owner explicitly requested it in emphases.
- **Atmospheres vs. Text:** Treat selected atmospheres as strong, authoritative signals. If the free-text description directly contradicts, prioritize the description and note the tension in \`reasoning_en\`.`;

const DEDUCTION_LOGIC_SECTION = `## Deduction Logic

Walk through all 116 canonical genres and assign each to EXACTLY ONE bucket: \`approved\`, \`conditional\`, or \`excluded\`. Only \`approved\` and \`conditional\` are written to the output. \`excluded\` is implicit: to exclude a genre, simply leave it out of both lists. This means a genre you forget to list is silently excluded — so make sure every genre that deserves \`approved\` or \`conditional\` (including the "no signal → conditional" default in step 4) is actually listed.

### 1. Aggregate positive signal per genre

Positive signal sources, strongest → weakest:
- **Super-liked genre.** The owner super-liked a specific track drawn from this genre. Strongest positive signal. → \`approved\`.
- **Genre appears in a liked direction.** → \`approved\`, unless a stronger negative signal overrides.
- **Musical emphases explicitly requested this genre or its family.** → \`approved\`.
- **Tight-cluster neighbour.** The genre shares energy tier, instrumentation family, cultural register, and mood with a super-liked or liked genre. → \`approved\` if all four axes match; → \`conditional\` if 2–3 axes match.

### 2. Aggregate negative signal per genre

Negative signal sources:
- **Genre appears ONLY in disliked directions and NEVER in any liked direction.** → \`excluded\`.
- **Musical emphases explicitly excluded this genre or its family.** → \`excluded\`.
- **Japanese Folk Restriction triggers.** → \`excluded\`.

### 3. Cross-check and resolve conflicts

Priority order when a genre has multiple signals:
1. Super-like beats everything. → \`approved\`.
2. Round 2 refinement emphases beats everything below.
3. Round 1 musical emphases (explicit include or exclude) beats direction-level signals.
4. Direction-level like beats direction-level dislike ONLY if the like is consistent with another positive signal elsewhere in the profile. Otherwise → \`conditional\`.

### 4. Untouched genres (never appeared in any R1/R2 direction)

For the many genres the user never saw:
- Tight-cluster neighbour (all four axes match) of a super-liked genre → \`approved\`.
- Tight-cluster neighbour of a liked (non-super) genre → \`conditional\` (default) or \`approved\` (if multiple liked directions independently point at it).
- Semantic distant-relative of a liked genre with no negative counterweight → \`conditional\`.
- Semantic distant-relative of a disliked genre with no positive counterweight → \`excluded\` if the negative signal is coherent; \`conditional\` if it's noisy.
- No signal in either direction → \`conditional\` (default for "we don't know").

### 5. No blanket exclusions

Do NOT apply family-level bans based on a single dislike. Example: the owner disliked a direction containing \`Deep House\` but super-liked a \`Nu Disco\` track — \`Deep House\` itself is NOT automatically \`approved\` (the dislike matters) but the broader "electronic dance" family is NOT excluded either. Each electronic genre must be evaluated on its own signal aggregate.`;

const ENERGY_CALIBRATION_SECTION = `## Energy Calibration & Assignment

After bucketing, calibrate a per-user energy scale for the approved + conditional genres. This scale is RELATIVE to the user's own taste range — not an absolute ladder.

### Step 1: Determine N (number of energy levels)

Look at the highest-energy and lowest-energy genres in the user's approved + conditional set. Estimate the spread:
- **Narrow spread** (all mid-energy chill OR all high-energy dance — no meaningful energy variation): \`N=2\`.
- **Moderate spread** (typical mixed profile — chill background + some upbeat): \`N=3\` or \`N=4\`.
- **Wide spread** (chill acoustic AND upbeat dance both present in the profile): \`N=5\`.
- **Very wide spread** (contemplative acoustic AND aggressive electronic both present): \`N=6\`.

Rules:
- \`N\` MUST be an integer between 2 and 6 inclusive.
- Prefer the SMALLEST \`N\` that meaningfully distinguishes operational contexts for this user. If two adjacent levels would contain genres that could easily be swapped between them, collapse them.

### Step 2: Assign each approved and conditional genre a level 1..N

- Level \`N\` = the highest-energy genres in the user's set.
- Level \`1\` = the lowest-energy genres in the user's set.
- Everything else is bucketed relatively.
- Same-energy genres get the same level.
- Assignment is RELATIVE. Concrete illustration:
  - User A likes acoustic chill + hip hop. Hip Hop is their ceiling → \`Hip Hop\` gets level \`N\`.
  - User B likes hip hop + house + dubstep. Hip Hop is mid-range for them → \`Hip Hop\` gets level 3 (out of 5 or 6).

### Step 3: Excluded genres get NO energy level

Excluded genres are not in the output at all, so they carry no level.`;

const GENRE_NAMING_DISCIPLINE = `## Genre Naming Discipline

You must NEVER invent, modify, rename, translate, add qualifiers to, or otherwise alter any genre name. Use ONLY the exact strings as they appear in the Genre Universe above. Any string that is not verbatim in the Genre Universe will be silently dropped by downstream code — the user will lose those genres from their profile.

Examples of WRONG (will be dropped):
- "Slow Funk" (added qualifier)
- "Acoustic Pop" (added qualifier)
- "Instrumental Neo Soul" (added qualifier)
- "Hebrew Ballads" (translated)
- "Latin Music" (family name, not a specific genre)

Examples of RIGHT:
- \`Funk\`
- \`Neo Soul\`
- \`בלדות ישראליות\`
- \`Latin Boogaloo\``;

// Composed editable prompt.
export const EDITABLE_PROMPT_SECTION = [
  TASTE_PROFILE_INTRO,
  GENRE_UNIVERSE_SECTION,
  TASTE_PROFILE_INPUTS_SECTION,
  PROCESSING_RULES_SECTION,
  DEDUCTION_LOGIC_SECTION,
  ENERGY_CALIBRATION_SECTION,
  GENRE_NAMING_DISCIPLINE,
].join('\n\n');

const OUTPUT_FORMAT = `## Output format

Return a single JSON object with exactly this shape, and NOTHING ELSE — no prose before or after, no markdown code fences around it. Do not add fields not listed here.

Normal case:
{
  "energy_levels_total": 4,
  "approved_genres": [
    {"genre": "Hip Hop",   "energy_level": 4},
    {"genre": "Neo Soul",  "energy_level": 2},
    {"genre": "Bossa Nova","energy_level": 1}
    // ... one entry per approved genre
  ],
  "conditional_genres": [
    {"genre": "Trap",       "energy_level": 4, "note_en": "Adjacent to Hip Hop but user's dislikes lean cleaner-produced — hold in reserve."}
    // ... one entry per conditional genre; note_en is one short English sentence
  ],
  "instrumentalness_preference": "none",
  "popularity_preference": "none",
  "reasoning_en": "One paragraph explaining the overall taste profile, key positive/negative signals, and the energy calibration decision — why N=4 in this case, what the spread looks like."
}

Field contracts:
- \`energy_levels_total\`: integer 2..6. Total number of energy levels in this user's scale.
- \`approved_genres\`: array of \`{genre, energy_level}\`. \`energy_level\` is an integer 1..N.
- \`conditional_genres\`: array of \`{genre, energy_level, note_en}\`. \`energy_level\` is an integer 1..N. \`note_en\` is one short English sentence explaining why the genre is conditional (for developer audit — this bucket is data-only, not used by the initial playlist build).
- Do NOT output an \`excluded_genres\` field. Every canonical genre missing from both lists above is excluded automatically.
- \`instrumentalness_preference\`: carried through verbatim from R1/R2 (\`"none"\` | \`"soft"\` | \`"hard"\`).
- \`popularity_preference\`: carried through verbatim from R1/R2 (\`"none"\` | \`"soft"\` | \`"hard"\`).
- \`reasoning_en\`: one paragraph in English for developer audit.

Hard invariants:
- No genre may appear in both \`approved_genres\` and \`conditional_genres\`, or twice in the same list.
- Every genre string must be VERBATIM from the Genre Universe.
- Every approved/conditional genre has an \`energy_level\` between 1 and \`energy_levels_total\`.

Error case (return instead of a profile):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

const WHEN_NOT_TO_RETURN_A_PROFILE = `## When NOT to return a taste profile

If the input signal is genuinely too thin or internally contradictory to produce a meaningful profile, return an error instead of forcing an output.

Return \`{"error": "insufficient_signal", "reasoning_en": "..."}\` ONLY when ALL of the following hold:
- The user liked zero directions across R1 and R2 combined (no positive direction-level signal).
- No super-liked genres either (no positive track-level signal).
- The dislikes contradict each other (e.g., a purely acoustic direction AND a purely electronic direction both disliked — no coherent negative filter).
- The description, atmospheres, and emphases together give too little positive signal to synthesize from.

Do NOT emit this error just because signal is SPARSE — even one liked direction, or one super-liked genre, or a strong emphases text is enough to profile from. Only error when there is genuinely nothing to work with.

Note: this error path is a safety net. Upstream the R2 flow already routes users with zero picks to a restart screen, so in practice this taste-profile stage should never see the "zero everything" case. Emit the error if it happens anyway rather than fabricating a random profile.`;

export const FIXED_PROMPT_SECTION = [
  OUTPUT_FORMAT,
  WHEN_NOT_TO_RETURN_A_PROFILE,
].join('\n\n');

// No Places injection at this stage. Google Places is venue context, and
// the venue context was already baked into R1/R2 when the user swiped on
// their probes. Reusing it here to shape "which genres does this user
// like" would mix venue-appropriateness signal into a user-taste
// extrapolation — the two are orthogonal and should stay so. Places
// belongs in R1/R2 (already there) and in the eventual downstream
// playlist builder, not in this stage.
export function assembleSystemPrompt(editable) {
  return editable + '\n\n' + FIXED_PROMPT_SECTION;
}

const SYSTEM_PROMPT = assembleSystemPrompt(EDITABLE_PROMPT_SECTION);

// ---------- Helpers ----------

function directionGenres(d) {
  if (Array.isArray(d.genres) && d.genres.length) return d.genres;
  return [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])]
    .filter((g) => typeof g === 'string' && g.length);
}

function formatDirection(d) {
  const genres = directionGenres(d);
  const desc = d.description_he || '';
  return [
    `${d.rank}. "${d.title_en || '(no title)'}"`,
    `   genres: ${genres.join(', ') || '(none)'}`,
    `   description_he: "${desc}"`,
  ].join('\n');
}

function buildUserMessage({
  bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases,
  round1Directions, round2Directions,
  likedDirections, dislikedDirections, superLikedGenres,
  instrumentalnessPreference, popularityPreference,
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
  base += `\nInstrumentalness preference (carry-through): ${instrumentalnessPreference || 'none'}`;
  base += `\nPopularity preference (carry-through): ${popularityPreference || 'none'}`;

  const round1Block = (Array.isArray(round1Directions) && round1Directions.length)
    ? round1Directions.map(formatDirection).join('\n\n')
    : '(none)';
  const round2Block = (Array.isArray(round2Directions) && round2Directions.length)
    ? round2Directions.map(formatDirection).join('\n\n')
    : '(not fired)';

  const rankList = (arr) => (Array.isArray(arr) && arr.length)
    ? arr.map((d) => d.rank).join(', ')
    : '(none)';
  const likedList = rankList(likedDirections);
  const dislikedList = rankList(dislikedDirections);
  const superLikedGenresList = (Array.isArray(superLikedGenres) && superLikedGenres.length)
    ? superLikedGenres.join(', ')
    : '(none)';

  return base
    + `\n\nRound 1 directions:\n\n${round1Block}`
    + `\n\nRound 2 directions:\n\n${round2Block}`
    + `\n\nOwner's decisions:`
    + `\n- LIKED (ranks, combined R1+R2): ${likedList}`
    + `\n- DISLIKED (ranks, combined R1+R2): ${dislikedList}`
    + `\n- SUPER-LIKED GENRES: ${superLikedGenresList}`
    + `\n\nProduce the taste profile per the Deduction Logic and Energy Calibration sections.`;
}

// ---------- Validation & normalization ----------

const PREF_SET = new Set(['none', 'soft', 'hard']);
function normalizePref(raw) {
  if (typeof raw !== 'string') return 'none';
  const v = raw.trim().toLowerCase();
  return PREF_SET.has(v) ? v : 'none';
}

// Build a case-insensitive lookup so we can accept minor casing drift from
// the model ("hip hop" → "Hip Hop") while still writing back the canonical
// spelling. GENRE_SET itself is case-sensitive.
const CANONICAL_BY_LOWER = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
function canonicalize(genreString) {
  if (typeof genreString !== 'string') return null;
  return CANONICAL_BY_LOWER.get(genreString.trim().toLowerCase()) || null;
}

function clampEnergyLevel(level, total) {
  const n = Number(level);
  if (!Number.isFinite(n)) return null;
  const int = Math.max(1, Math.min(total, Math.round(n)));
  return int;
}

// Coerce a raw model response into a well-formed profile. Drops:
// - Genre strings not in the shared Genre Universe (case-normalised first).
// - Duplicates across buckets (approved wins over conditional).
// - Approved/conditional entries missing a valid energy_level.
// `excluded_genres` is then COMPUTED as every canonical genre not in
// approved or conditional — the model is told not to output it (any
// excluded list it sends anyway is ignored), so the three buckets always
// partition all 116 genres.
function normalizeTasteProfile(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  let energyLevelsTotal = Number(parsed.energy_levels_total);
  if (!Number.isFinite(energyLevelsTotal)) return null;
  energyLevelsTotal = Math.max(2, Math.min(6, Math.round(energyLevelsTotal)));

  const seen = new Set();
  const approved = [];
  const conditional = [];

  const takeApproved = Array.isArray(parsed.approved_genres) ? parsed.approved_genres : [];
  const takeConditional = Array.isArray(parsed.conditional_genres) ? parsed.conditional_genres : [];

  for (const entry of takeApproved) {
    const genre = canonicalize(entry?.genre);
    if (!genre || seen.has(genre)) continue;
    const level = clampEnergyLevel(entry.energy_level, energyLevelsTotal);
    if (level == null) continue;
    approved.push({ genre, energy_level: level });
    seen.add(genre);
  }
  for (const entry of takeConditional) {
    const genre = canonicalize(entry?.genre);
    if (!genre || seen.has(genre)) continue;
    const level = clampEnergyLevel(entry.energy_level, energyLevelsTotal);
    if (level == null) continue;
    const note = typeof entry.note_en === 'string' ? entry.note_en.trim() : '';
    conditional.push({ genre, energy_level: level, note_en: note });
    seen.add(genre);
  }
  const excludedList = GENRES.filter((g) => !seen.has(g));

  return {
    energy_levels_total: energyLevelsTotal,
    approved_genres:     approved,
    conditional_genres:  conditional,
    excluded_genres:     excludedList,
    instrumentalness_preference: normalizePref(parsed.instrumentalness_preference),
    popularity_preference:       normalizePref(parsed.popularity_preference),
    reasoning_en: typeof parsed.reasoning_en === 'string' ? parsed.reasoning_en : '',
  };
}

// ---------- Model call ----------

async function callTasteProfile({ userMessage, label, onboardingSessionId }) {
  const { text } = await callModel({
    system: SYSTEM_PROMPT,
    userMessage,
    maxTokens: MAX_TOKENS,
    // System prompt is stable across users (~3-4k tokens), so on Anthropic
    // the ephemeral cache kicks in after the first call. No-op on Gemini.
    cache: true,
    label,
    onboardingSessionId,
  });
  return parseJSONFromText(text);
}

// ---------- Public entry point ----------

export async function generateTasteProfile({
  bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases,
  round1Directions, round2Directions,
  likedDirections, dislikedDirections, superLikedGenres,
  instrumentalnessPreference, popularityPreference,
  onboardingSessionId,
}) {
  if (!bizDesc || typeof bizDesc !== 'string' || bizDesc.trim().length < 3) {
    return { error: 'insufficient_signal', reasoning_en: 'empty or too-short description' };
  }
  if (!Array.isArray(round1Directions) || !round1Directions.length) {
    return { error: 'matcher_error', reasoning_en: 'taste-profile called with empty Round 1 directions' };
  }

  const userMessage = buildUserMessage({
    bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases,
    round1Directions, round2Directions,
    likedDirections, dislikedDirections, superLikedGenres,
    instrumentalnessPreference, popularityPreference,
  });

  let parsed;
  try {
    parsed = await callTasteProfile({
      userMessage,
      label: 'v7-taste-profile',
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

  const profile = normalizeTasteProfile(parsed);
  if (!profile) {
    return { error: 'matcher_error', reasoning_en: 'taste profile could not be parsed' };
  }
  // Post-normalization sanity — if the model returned nothing approved AND
  // nothing conditional, the profile is unusable regardless of what shape
  // it took. Treat as matcher_error so the caller can retry or restart.
  if (!profile.approved_genres.length && !profile.conditional_genres.length) {
    return { error: 'matcher_error', reasoning_en: 'taste profile returned zero approved/conditional genres' };
  }
  return { profile };
}

// Utility export — mostly for tests. Rebuilds a set of all canonical
// genres this profile touches (should equal GENRES.length once
// normalization has run).
export function profileCoverage(profile) {
  if (!profile) return new Set();
  const s = new Set();
  (profile.approved_genres || []).forEach((e) => s.add(e.genre));
  (profile.conditional_genres || []).forEach((e) => s.add(e.genre));
  (profile.excluded_genres || []).forEach((g) => s.add(g));
  return s;
}
