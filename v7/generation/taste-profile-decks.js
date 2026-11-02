// v7 taste profile for the two-deck onboarding (Ami, 2026-11-02) — the deck
// version of taste-profile.js, run by the onboarding (generateDeckTasteProfile,
// label 'v7-taste-profile') and by Ami's prompt dashboard.
//
// What's new against taste-profile.js:
//   - The profile has a calm side (the lower half of the owner's energy scale)
//     and an energetic side (the upper half). Liked energetic-deck directions
//     feed the energetic side, liked calm-deck directions the calm side, so
//     Option 1's tiers (tierOfLevel: level > N/2 = high) follow the decks.
//   - Ami's genre sides (shared/genre-sides.js): a calm-only genre sits on the
//     calm side, an energetic-only one on the energetic side, and a both-ways
//     genre may be listed TWICE — once per side.
//   - Energy floors (Roni, 2026-11-02): Organic House is out of the House
//     rule (it goes both ways now); the groove rule applies to the energetic
//     side only.
//   - One deck with no likes: no sides — genres are placed across the whole
//     scale as before (so both calm and energetic playlists stay possible),
//     and nothing is listed twice.
//
// Output shape = taste-profile.js's, except that a both-ways genre may appear
// twice in approved / conditional (different halves). Bare imports only.
import { callModel, parseJSONFromText } from './ai-provider.js';
import { GENRE_UNIVERSE_SECTION, GENRES } from '../../shared/genre-universe.js';
import { genreSide, genreSidesList } from '../../shared/genre-sides.js';
import {
  CORE_PHILOSOPHY_SECTION,
  HARD_BOUNDARY_RULES_SECTION,
  PROCESSING_RULES_SECTION,
  DEDUCTION_LOGIC_SECTION,
  GENRE_NAMING_DISCIPLINE,
  WHEN_NOT_TO_RETURN_A_PROFILE,
  canonicalGenreList,
  forceRequestedIntoApproved,
} from './taste-profile.js';
import { DECK_RANK_START, DECK_SIZE } from './deck-directions.js';

// ---------- Prompt sub-constants ----------

const INTRO = `You classify a user's music taste for a public-facing-business playlist tool. The user has swiped two decks of tightly-clustered "musical direction" probes: an ENERGETIC deck (ranks ${DECK_RANK_START.energetic}–${DECK_RANK_START.energetic + DECK_SIZE - 1}; each card played a song from the genres' energetic side) and a CALM deck (ranks ${DECK_RANK_START.calm}–${DECK_RANK_START.calm + DECK_SIZE - 1}; each card played a song from their calm side). You will receive the probes plus the user's per-direction decisions (like / dislike) and the genres they super-liked on each deck. Your job is to extrapolate that sparse signal to a full-catalog taste profile with a CALM SIDE and an ENERGETIC SIDE: for each of the ${GENRES.length} canonical genres — and, for genres that go both ways, for each side — decide whether it belongs in the user's approved list, a conditional list, or neither. You only output the approved and conditional lists — every genre you leave out of both is treated as excluded. Then place every approved and conditional entry on the user's energy scale of N levels (2–6, dynamic per user): calm-side entries in the lower half, energetic-side entries in the upper half. The energetic side feeds the owner's energetic daily playlists, the calm side their calm ones.`;

const SIDES_SECTION = `## Genre Energy Sides & Families

Every genre in the Genre Universe has an energy side, set by our music curator:
- **Both ways** — the genre has a real calm side AND a real energetic side (calm R&B and upbeat R&B are different listening experiences). Judge each side on its own, and list the genre twice — once per side — when the evidence supports both.
- **Energetic only** — only ever on the energetic side.
- **Calm only** — only ever on the calm side.

${genreSidesList()}`;

const INPUTS_SECTION = `## Inputs

You will receive:

- Free-text description of the business (any language).
- Optionally: Business name.
- Optionally: Selected atmospheres (short adjectives from a fixed menu).
- Optionally: **Musical emphases** — free-text preferences the owner typed during onboarding.
- Optionally: **Round 2 refinement emphases** — free-text feedback the owner typed after hearing the cards. When present, it is the freshest and STRONGEST signal.
- **Instrumentalness preference** and **popularity preference** — already classified when the decks were built (\`"none"\` | \`"soft"\` | \`"hard"\`). Carried through unchanged. DO NOT re-classify; use them to shape your bucketing (see Processing Rules).
- **Energetic deck directions** and **Calm deck directions** — up to ${DECK_SIZE} diagnostic probes each, with rank, title, genres, description. Round 2 directions (extra cards for a deck the owner liked little of) may follow, each marked with its deck.
- **User's per-direction decisions:**
  - LIKED (ranks): the direction indices the user swiped right on.
  - DISLIKED (ranks): the direction indices the user swiped left on.
- **SUPER-LIKED GENRES, per deck:** the specific GENRES (not directions) the user super-liked a track from, on each deck. Super-liking is a sharper signal than merely liking a direction — the user reacted to a specific track drawn from that exact genre, on that side.
- Optionally: **Known taste** and **turned-down genres** — only when Rubin re-runs the onboarding for an existing owner: a short portrait of their taste, written from their conversations with us, and the genres they turned down. Treat the portrait like the musical emphases (just below them in priority), and treat turned-down genres as exclusions.`;

const SIDE_DEDUCTION_SECTION = `## Sides

- **Each deck speaks for its own side.** A genre in a liked ENERGETIC-deck direction → its energetic side; in a liked CALM-deck direction → its calm side. A genre super-liked on a deck → \`approved\` on that deck's side.
- **Dislikes are per side too.** Disliking the calm card of a Both-ways genre says nothing about its energetic side, and the reverse.
- **Infer per side.** Tight-cluster neighbours and cross-pattern bridges (Deduction Logic) are inferred on a side from the likes on THAT side. Liking calm \`Rnb\` does not by itself approve upbeat \`Rnb\`.
- **Calm-only and Energetic-only genres stay on their side**, wherever the evidence comes from.
- **Requested genres** (emphases): approve on the side the owner's words point to ("calm jazz", "upbeat funk"); when unclear, on the side where they liked the closest genres; when still unclear, on the side that suits the venue — or on both, for a Both-ways genre that clearly fits both.
- **One deck with no likes:** if the owner liked nothing on one deck (no liked direction, no super-like) and nothing in the emphases points to that side, don't build a one-sided scale. Ignore the sides: list every genre once and place all approved and conditional genres across the WHOLE scale relative to each other, as if there were no decks (Calm-only genres still below Energetic-only ones). This keeps both calm and energetic playlists possible.`;

const ENERGY_CALIBRATION_SECTION = `## Energy Calibration & Assignment

After bucketing, calibrate a per-user energy scale for the approved + conditional entries. This scale is RELATIVE to the user's own taste range — not an absolute ladder.

### Step 1: Determine N (number of energy levels)

Look at the highest-energy and lowest-energy entries in the user's approved + conditional set, across both sides. Estimate the spread:
- **Narrow spread** (no meaningful energy variation): \`N=2\`.
- **Moderate spread** (typical mixed profile — chill background + some upbeat): \`N=3\` or \`N=4\`.
- **Wide spread** (chill acoustic AND upbeat dance both present in the profile): \`N=5\`.
- **Very wide spread** (contemplative acoustic AND aggressive electronic both present): \`N=6\`.

Rules:
- \`N\` MUST be an integer between 2 and 6 inclusive.
- Prefer the SMALLEST \`N\` that meaningfully distinguishes operational contexts for this user. If two adjacent levels would contain genres that could easily be swapped between them, collapse them.

### Step 2: The two halves

- **Calm half** = levels 1 to ⌊N/2⌋. **Energetic half** = the levels above it. (N=2: calm 1, energetic 2. N=3: calm 1, energetic 2–3. N=4: calm 1–2, energetic 3–4. N=5: calm 1–2, energetic 3–5. N=6: calm 1–3, energetic 4–6.)
- Every calm-side entry sits in the calm half; every energetic-side entry in the energetic half. A Both-ways genre listed twice gets one level in each half.
- Within each half, place entries relative to each other: the calmest at the bottom of the half, the most energetic at its top; same-energy entries share a level. The calmest calm-side genres sit at Level 1.
- Exception: when one deck had no likes (see Sides), there are no halves — place everything across the whole scale relative to each other, Level 1 = calmest, Level N = most energetic.

### Step 3: Energy Floor Restrictions (STRICT ENFORCEMENT)

The **top two levels** are the highest and next-to-highest level (on a scale of 2 or 3 levels: only the top level). The **bottom two levels** are the lowest and next-to-lowest level (on a scale of 2 or 3 levels: only the lowest level).

- **House Genres Floor:** Every House genre except \`Organic House\` (\`Deep House\`, \`Tech House\`, \`Soulful House\`, \`Afro House\`, \`Jazz House\`, \`Hip House\`) MUST sit in the top two levels — never lower. \`Organic House\` goes both ways: its energetic side sits in the energetic half like any energetic entry, and its calm side may sit in the calm half. Calm electronic genres are not House and may sit in the bottom two levels: \`DownTempo\`, \`French DownTempo\`, \`Latin DownTempo\`, \`LoFi Beats\`, \`Trip Hop\`, and \`Electronic Chillout\`.
- **Electronic R&B Floor:** \`Electronic R&B\` is strictly a high-energy style and MUST sit in the top two levels.
- **Rhythmic & Groove Genres Floor (energetic side only):** Rhythmic, groove-driven genres carry inherent bounce: the R&B family (\`Rnb\`, \`Alternative R&B\`, \`French RnB\`, \`Japanese RnB\`, \`Korean RnB\`, \`Latin RnB\`), \`Neo Soul\`, \`Acid Jazz\`, \`AfroBeats\`, and the Funk family (\`Funk\`, \`Afro Funk\`, \`Italian Funk\`, \`French Funk\`, \`Greek Funk\`, \`Latin Funk\`, \`Arabic Funk\`, \`Brazilian Funk\`). Their ENERGETIC-side entries ALWAYS sit above the owner's calmer approved genres (acoustic, ballads, jazz, bossa and the like) — mid-to-high on the scale, never in the bottom two levels while calmer APPROVED genres exist to fill those levels. Their CALM-side entries (the genre liked on the calm deck) are exempt: calm R&B is calm, and sits in the calm half with the other calm genres.
  * **R&B Energy Level Exception:** On the energetic side, standard non-electronic R&B genres (\`Rnb\`, \`Alternative R&B\`, \`French RnB\`, \`Japanese RnB\`, \`Korean RnB\`, \`Latin RnB\`) **CAN** sit in the bottom two levels IF the top two levels are already heavily populated with distinctly higher-energy genres (e.g., House styles, \`Nu Disco\`, \`Future Funk\`, \`Electronic R&B\`, high-tempo Dance, etc.).
- **When the floors give way:** Only when the owner has no calmer approved genre (e.g. a profile built only around house and dance music, or around R&B, funk and club music) does the calmest of these genres take Level 1. The lowest level must never be left without an approved genre.

### Step 4: Excluded genres get NO energy level

Excluded genres are not in the output at all, so they carry no level.`;

export const DECK_TASTE_EDITABLE_PROMPT_SECTION = [
  INTRO,
  CORE_PHILOSOPHY_SECTION,
  HARD_BOUNDARY_RULES_SECTION,
  GENRE_UNIVERSE_SECTION,
  SIDES_SECTION,
  INPUTS_SECTION,
  PROCESSING_RULES_SECTION,
  SIDE_DEDUCTION_SECTION,
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
    {"genre": "Rnb",       "energy_level": 3},
    {"genre": "Rnb",       "energy_level": 2},
    {"genre": "Bossa Nova","energy_level": 1}
    // ... one entry per approved genre — per side for a Both-ways genre approved on both sides
  ],
  "conditional_genres": [
    {"genre": "Trap",       "energy_level": 4, "note_en": "Adjacent to Hip Hop but user's dislikes lean cleaner-produced — hold in reserve."}
    // ... one entry per conditional genre (per side, as above); note_en is one short English sentence
  ],
  "requested_genres": ["Neo Soul"],
  "instrumentalness_preference": "none",
  "popularity_preference": "none",
  "reasoning_en": "One paragraph explaining the overall taste profile, key positive/negative signals per side, and the energy calibration decision — why N=4 in this case, what the spread looks like."
}

Field contracts:
- \`energy_levels_total\`: integer 2..6. Total number of energy levels in this user's scale.
- \`approved_genres\`: array of \`{genre, energy_level}\`. \`energy_level\` is an integer 1..N; its half (calm or energetic) says which side the entry is.
- \`conditional_genres\`: array of \`{genre, energy_level, note_en}\`. \`energy_level\` is an integer 1..N. \`note_en\` is one short English sentence explaining why the entry is conditional (for developer audit — this bucket is data-only, not used by the initial playlist build).
- Do NOT output an \`excluded_genres\` field. Every canonical genre missing from both lists above is excluded automatically.
- \`requested_genres\`: array of genre strings — the genres the owner explicitly asked for in their Musical emphases or Round 2 refinement emphases (see Processing Rules). \`[]\` when they asked for none. Super-liked genres are added downstream; don't repeat them here.
- \`instrumentalness_preference\`: carried through verbatim (\`"none"\` | \`"soft"\` | \`"hard"\`).
- \`popularity_preference\`: carried through verbatim (\`"none"\` | \`"soft"\` | \`"hard"\`).
- \`reasoning_en\`: one paragraph in English for developer audit.

Hard invariants:
- A Both-ways genre may appear at most twice in total across the two lists — once at a calm-half level and once at an energetic-half level. Any other genre appears at most once. (When one deck had no likes, every genre appears at most once.)
- No genre appears in both lists on the SAME side.
- Every genre string must be VERBATIM from the Genre Universe.
- Every approved/conditional entry has an \`energy_level\` between 1 and \`energy_levels_total\`.
- Every genre in \`requested_genres\` is also in \`approved_genres\`.

Error case (return instead of a profile):
{"error": "<code>", "reasoning_en": "one short English sentence"}`;

export const DECK_TASTE_FIXED_PROMPT_SECTION = [OUTPUT_FORMAT, WHEN_NOT_TO_RETURN_A_PROFILE].join('\n\n');

export function assembleDeckTasteSystemPrompt(editable) {
  return editable + '\n\n' + DECK_TASTE_FIXED_PROMPT_SECTION;
}

// ---------- User message ----------

function formatDirection(d) {
  return [
    `${d.rank}. "${d.title_en || '(no title)'}"`,
    `   genres: ${(d.genres || []).join(', ') || '(none)'}`,
    `   description_he: "${d.description_he || ''}"`,
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

// directions: every card the owner saw, each with `deck` ('energetic' |
// 'calm') and `round` (1, or 2 for a Round 2 card). superLikedByDeck:
// { energetic: [genre], calm: [genre] }.
export function buildDeckTasteUserMessage({
  bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases,
  directions, likedDirections, dislikedDirections, superLikedByDeck,
  instrumentalnessPreference, popularityPreference, knownTaste, turnedDown,
}) {
  const nameLine = (bizName && String(bizName).trim()) ? String(bizName).trim() : 'none';
  const atmLine = Array.isArray(atmospheres) && atmospheres.length ? atmospheres.join(', ') : 'none';
  let s = `Description: ${bizDesc}\nBusiness name: ${nameLine}\nAtmospheres: ${atmLine}`;
  if (typeof musicalEmphases === 'string' && musicalEmphases.trim().length) {
    s += `\nMusical emphases (from onboarding): ${musicalEmphases.trim()}`;
  }
  if (typeof round2Emphases === 'string' && round2Emphases.trim().length) {
    s += `\nRound 2 refinement emphases (after hearing the cards — HIGHEST PRIORITY): ${round2Emphases.trim()}`;
  }
  s += knownTasteLines({ knownTaste, turnedDown });
  s += `\nInstrumentalness preference (carry-through): ${instrumentalnessPreference || 'none'}`;
  s += `\nPopularity preference (carry-through): ${popularityPreference || 'none'}`;

  const all = Array.isArray(directions) ? directions : [];
  const block = (deck, round) => {
    const ds = all.filter((d) => d.deck === deck && (d.round || 1) === round);
    return ds.length ? ds.map(formatDirection).join('\n\n') : null;
  };
  s += `\n\nEnergetic deck directions (energetic side):\n\n${block('energetic', 1) || '(none)'}`;
  s += `\n\nCalm deck directions (calm side):\n\n${block('calm', 1) || '(none)'}`;
  for (const deck of ['energetic', 'calm']) {
    const r2 = block(deck, 2);
    if (r2) s += `\n\nRound 2 — extra ${deck} deck directions (${deck} side):\n\n${r2}`;
  }

  const ranks = (arr) => (Array.isArray(arr) && arr.length ? arr.map((d) => d.rank).join(', ') : '(none)');
  const sl = (deck) => (superLikedByDeck?.[deck]?.length ? superLikedByDeck[deck].join(', ') : '(none)');
  return s
    + `\n\nOwner's decisions:`
    + `\n- LIKED (ranks): ${ranks(likedDirections)}`
    + `\n- DISLIKED (ranks): ${ranks(dislikedDirections)}`
    + `\n- SUPER-LIKED GENRES on the energetic deck: ${sl('energetic')}`
    + `\n- SUPER-LIKED GENRES on the calm deck: ${sl('calm')}`
    + `\n\nProduce the taste profile per the Sides, Deduction Logic and Energy Calibration sections.`;
}

// ---------- Validation & normalization ----------

const CANON = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
const canonical = (g) => (typeof g === 'string' ? CANON.get(g.trim().toLowerCase()) || null : null);
const PREFS = new Set(['none', 'soft', 'hard']);
const pref = (v) => (typeof v === 'string' && PREFS.has(v.trim().toLowerCase()) ? v.trim().toLowerCase() : 'none');

// The last calm level: levels 1..calmTop are the calm half (same split as
// option1-draw.js tierOfLevel, where level > N/2 is high).
export const calmTop = (n) => Math.floor(n / 2);
export const sideOfLevel = (level, n) => (level > n / 2 ? 'energetic' : 'calm');
const middleOf = (side, n) => (side === 'calm' ? Math.ceil(calmTop(n) / 2) : calmTop(n) + Math.ceil((n - calmTop(n)) / 2));

// Coerce the model's response into a profile. decksLiked = { energetic, calm }
// (a liked direction or a super-like on that deck). With likes on both decks
// the profile has sides:
//   - a calm-only genre on the energetic side moves to the top of the calm
//     half, an energetic-only one on the calm side to the bottom of the
//     energetic half;
//   - a both-ways genre keeps at most one entry per side (approved wins over
//     conditional on the same side); every other genre at most one entry;
//   - each super-liked genre is approved on its deck's side, each requested
//     one on some side;
//   - calm-side levels shift down so the calmest approved calm entry is at 1.
// Without likes on both decks: taste-profile.js's rules (one entry per genre,
// all super-likes + requested forced in, levels shifted so level 1 isn't empty).
export function normalizeDeckTasteProfile(parsed, { superLikedByDeck = {}, decksLiked = {} } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  let n = Number(parsed.energy_levels_total);
  if (!Number.isFinite(n)) return null;
  n = Math.max(2, Math.min(6, Math.round(n)));
  const sides = !!(decksLiked.energetic && decksLiked.calm);

  const clamp = (l) => {
    const x = Number(l);
    return Number.isFinite(x) ? Math.max(1, Math.min(n, Math.round(x))) : null;
  };
  const place = (genre, level) => {
    if (!sides) return level;
    const own = genreSide(genre);
    if (own === 'calm' && level > calmTop(n)) return calmTop(n);
    if (own === 'energetic' && level <= calmTop(n)) return calmTop(n) + 1;
    return level;
  };
  const keyOf = (genre, level) => (sides && genreSide(genre) === 'both' ? `${genre}|${sideOfLevel(level, n)}` : genre);

  const seen = new Set();
  const approved = [];
  const conditional = [];
  for (const [list, out, isCond] of [[parsed.approved_genres, approved, false], [parsed.conditional_genres, conditional, true]]) {
    for (const e of Array.isArray(list) ? list : []) {
      const genre = canonical(e?.genre);
      const raw = clamp(e?.energy_level);
      if (!genre || raw == null) continue;
      const level = place(genre, raw);
      const key = keyOf(genre, level);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(isCond
        ? { genre, energy_level: level, note_en: typeof e.note_en === 'string' ? e.note_en.trim() : '' }
        : { genre, energy_level: level });
    }
  }

  const byDeck = {
    energetic: canonicalGenreList(superLikedByDeck.energetic),
    calm: canonicalGenreList(superLikedByDeck.calm),
  };
  const fromModel = canonicalGenreList(parsed.requested_genres);
  const requested = canonicalGenreList([...fromModel, ...byDeck.energetic, ...byDeck.calm]);

  if (sides) {
    // On a given side: approved already → nothing; conditional there → moved;
    // else added at the middle of that half.
    const ensure = (genre, side) => {
      const onSide = (e) => e.genre === genre && sideOfLevel(e.energy_level, n) === side;
      if (approved.some(onSide)) return;
      const i = conditional.findIndex(onSide);
      const level = i >= 0 ? conditional[i].energy_level : middleOf(side, n);
      if (i >= 0) conditional.splice(i, 1);
      approved.push({ genre, energy_level: level });
    };
    for (const deck of ['energetic', 'calm']) for (const g of byDeck[deck]) ensure(g, genreSide(g) === 'both' ? deck : genreSide(g));
    for (const g of fromModel) {
      if (approved.some((e) => e.genre === g)) continue;
      const c = conditional.find((e) => e.genre === g);
      ensure(g, c ? sideOfLevel(c.energy_level, n) : (genreSide(g) === 'both' ? sideOfLevel(Math.ceil(n / 2), n) : genreSide(g)));
    }
    // The calmest approved calm entry sits at level 1.
    const calmLevels = approved.filter((e) => e.energy_level <= calmTop(n)).map((e) => e.energy_level);
    const shift = calmLevels.length ? Math.min(...calmLevels) - 1 : 0;
    if (shift > 0) {
      for (const e of [...approved, ...conditional]) if (e.energy_level <= calmTop(n)) e.energy_level -= shift;
    }
  } else {
    forceRequestedIntoApproved(approved, conditional, requested, n);
    const minApproved = approved.length ? Math.min(...approved.map((e) => e.energy_level)) : 1;
    const shift = Math.min(minApproved - 1, n - 2);
    if (shift > 0) {
      n -= shift;
      for (const e of [...approved, ...conditional]) e.energy_level = Math.max(1, e.energy_level - shift);
    }
  }

  const listed = new Set([...approved, ...conditional].map((e) => e.genre));
  return {
    energy_levels_total: n,
    approved_genres: approved,
    conditional_genres: conditional,
    excluded_genres: GENRES.filter((g) => !listed.has(g)),
    requested_genres: requested,
    // Stored as business_taste_profiles.two_sided: the taste chat and admin
    // edits keep the sides apart only when this is true.
    two_sided: sides,
    instrumentalness_preference: pref(parsed.instrumentalness_preference),
    popularity_preference: pref(parsed.popularity_preference),
    reasoning_en: typeof parsed.reasoning_en === 'string' ? parsed.reasoning_en : '',
  };
}

// ---------- Onboarding entry point ----------

const MAX_TOKENS = 65536;
const SYSTEM_PROMPT = assembleDeckTasteSystemPrompt(DECK_TASTE_EDITABLE_PROMPT_SECTION);

// directions = every card the owner saw (both decks, Round 2 included), each
// with `deck`; superLikedByDeck = { energetic: [genre], calm: [genre] }.
// knownTaste / turnedDown / label: re-onboarding an existing owner only. A
// turned-down genre is kept out of the profile unless the owner super-liked
// it in this run.
// → { profile } | { error, reasoning_en }.
export async function generateDeckTasteProfile({
  bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases,
  directions, likedDirections, dislikedDirections, superLikedByDeck,
  instrumentalnessPreference, popularityPreference, onboardingSessionId,
  knownTaste, turnedDown, label = 'v7-taste-profile',
}) {
  if (!bizDesc || typeof bizDesc !== 'string' || bizDesc.trim().length < 3) {
    return { error: 'insufficient_signal', reasoning_en: 'empty or too-short description' };
  }
  if (!Array.isArray(directions) || !directions.length) {
    return { error: 'matcher_error', reasoning_en: 'taste-profile called with no directions' };
  }
  // A super-like also counts as a like, so the liked list covers both.
  const liked = Array.isArray(likedDirections) ? likedDirections : [];
  const decksLiked = {
    energetic: liked.some((d) => d?.deck === 'energetic'),
    calm: liked.some((d) => d?.deck === 'calm'),
  };
  let parsed;
  try {
    const { text } = await callModel({
      system: SYSTEM_PROMPT,
      userMessage: buildDeckTasteUserMessage({
        bizName, bizDesc, atmospheres, musicalEmphases, round2Emphases,
        directions, likedDirections, dislikedDirections, superLikedByDeck,
        instrumentalnessPreference, popularityPreference, knownTaste, turnedDown,
      }),
      maxTokens: MAX_TOKENS,
      label,
      onboardingSessionId,
    });
    parsed = parseJSONFromText(text);
  } catch (e) {
    return { error: 'matcher_error', reasoning_en: e.message };
  }
  if (parsed?.error) {
    return { error: String(parsed.error), reasoning_en: typeof parsed.reasoning_en === 'string' ? parsed.reasoning_en : '' };
  }
  const profile = normalizeDeckTasteProfile(parsed, { superLikedByDeck, decksLiked });
  if (!profile) return { error: 'matcher_error', reasoning_en: 'taste profile could not be parsed' };
  const out = new Set((Array.isArray(turnedDown) ? turnedDown : []).filter((g) => !profile.requested_genres.includes(g)));
  if (out.size) {
    profile.approved_genres = profile.approved_genres.filter((e) => !out.has(e.genre));
    profile.conditional_genres = profile.conditional_genres.filter((e) => !out.has(e.genre));
    const listed = new Set([...profile.approved_genres, ...profile.conditional_genres].map((e) => e.genre));
    profile.excluded_genres = GENRES.filter((g) => !listed.has(g));
  }
  if (!profile.approved_genres.length && !profile.conditional_genres.length) {
    return { error: 'matcher_error', reasoning_en: 'taste profile returned zero approved/conditional genres' };
  }
  return { profile };
}
