# Musical Directions Prompts — History (v7)

Audit log for the v7 onboarding prompts. Sibling to `prompt-history.md` (which
tracks v6). v7 is designed to work independently of v6 — same rationale as
having two separate `v7/generation/` and `v6/generation/` trees.

v7's onboarding pipeline (as designed; UI not built yet) uses three prompts:

**Round 1** — diagnostic taste probes. Up to 8 tightly-clustered "musical
directions" from a fixed genre universe. Each direction is a small group of
near-identical genres testing one taste vector. Prompt lives in
`v7/generation/musical-directions.js`. Sub-constants make up
`EDITABLE_PROMPT_SECTION` + `FIXED_PROMPT_SECTION`.

**Round 2** — refinement, fires when Round 1 yields fewer than 3 liked
directions. Produces 4 refined probes. Prompt lives in
`v7/generation/refined-directions.js`. Composed from R2-specific sections
plus shared sub-constants imported from R1 (Genre Universe, Processing Rules,
Homogeneity, Distinctness, Energy & Pairing Constraints, Output Language,
Title Rules, Hebrew Description rules, When-Not-To-Return error contract).

**Taste profile** — runs once after the swipe deck resolves. Extrapolates
from the sparse R1/R2 signal to a full-catalog taste profile: every one of
the 116 canonical genres bucketed into approved / conditional / excluded,
plus a per-user energy scale (2–6 levels, dynamic per user based on the
spread of their taste). Prompt lives in `v7/generation/taste-profile.js`.

**Key design shift from v6:** v6 directions were curated blends that became
playlist seeds post-signup. v7 directions are diagnostic PROBES that dissolve
into a flat liked-genres list downstream. Playlists in v7 are built off the
liked-genres list + energy-level tags, NOT off individual directions.
Overlapping genres across two liked directions become a stronger signal, not
a duplicate.

**Update this file every time any v7 prompt changes.** New entries at the TOP.
Each entry starts with an **Applies to:** line
(`Round 1` / `Round 2` / `taste profile` / `R1+R2` / `all v7`). Include:
date, one-line summary of what changed and why, full text of new or edited
sub-constants (or a clear diff description for structural refactors). Never
delete old entries.

The `FIXED_PROMPT_SECTION` / R2's output-format contract / taste-profile
output schema are tracked here whenever they change — tight coupling to
downstream parsing means schema history matters for debugging old rows.

---

## 2026-09-24 (latest) — Taste profile: model lists approved + conditional only; excluded computed in code

**Applies to:** taste profile

Roni asked why Gemini spends output tokens listing the disliked genres when they can be derived. The model now outputs only `approved_genres` and `conditional_genres`; `excluded_genres` is computed in `normalizeTasteProfile` as every canonical genre not in either list (any `excluded_genres` the model sends anyway is ignored). Bucketing logic is unchanged — "excluded" is still a decision the model makes, it is just expressed by leaving the genre out. The persisted row shape (`business_taste_profiles.excluded_genres`) is unchanged, and the three buckets still partition all 116 genres. Saves ~70 genre strings of output per onboarding (~500 tokens, a few seconds of generation).

Changes, by sub-constant:
- `TASTE_PROFILE_INTRO` — "approved list, a conditional list, or the excluded list" → "approved list, a conditional list, or neither"; adds that only approved + conditional are output and everything left out is excluded.
- `PROCESSING_RULES_SECTION` — Musical Emphases exclude-rule and Japanese Folk Restriction now say "leave it out of both lists (excluded)" instead of "put it in `excluded`".
- `DEDUCTION_LOGIC_SECTION` — opening paragraph rewritten: `excluded` is implicit (leave the genre out); a forgotten genre is silently excluded, so every genre that deserves approved/conditional (including the "no signal → conditional" default) must actually be listed. The `→ excluded` arrows in steps 2 and 4 are kept — they now mean "leave it out".
- `ENERGY_CALIBRATION_SECTION` Step 3 — "Do NOT assign a level to excluded genres. They are not in the pipeline." → "Excluded genres are not in the output at all, so they carry no level."
- `OUTPUT_FORMAT` — removed the `excluded_genres` example line and field contract; added "Do NOT output an `excluded_genres` field…". Hard invariant "sum approved + conditional + excluded must equal 116" replaced with "No genre may appear in both lists, or twice in the same list."

Full text of the changed sub-constants after this edit:

#### `TASTE_PROFILE_INTRO`

```
You classify a user's music taste for a public-facing-business playlist tool. The user has completed a diagnostic swipe deck of up to 12 tightly-clustered "musical direction" probes (Round 1 + optional Round 2). You will receive the probes plus the user's per-direction decisions (like / dislike) and their super-liked genres. Your job is to extrapolate that sparse signal to a full-catalog taste profile: for each of the 116 canonical genres, decide whether it belongs in the user's approved list, a conditional list, or neither. You only output the approved and conditional lists — every genre you leave out of both is treated as excluded. Then partition the approved and conditional genres into N energy levels (2–6, dynamic per user based on the SPREAD of their taste) so downstream playlist builders can slot each genre into the right operational context.
```

#### `PROCESSING_RULES_SECTION`

```
### Processing Rules:

- **Musical Emphases (highest priority):** Treat the emphases text as the strongest signal — above description, atmospheres, and Google context. Genres or families the owner named to INCLUDE: bias toward `approved`. Genres or families they named to EXCLUDE: leave them out of both lists (excluded) even if they appear in a liked direction. General leanings ("adventurous", "hits only", "familiar", "not too energetic") shape the whole profile, not just some genres.
- **Round 2 refinement emphases (when present, HIGHEST priority):** Written after the user saw actual tracks — knows what they wanted more or less of. When it contradicts anything else (Round 1 emphases, atmospheres, direction-level likes/dislikes), IT WINS.
- **Instrumentalness preference (carry-through, do NOT re-classify):** Already set in R1/R2 and threaded into the input. It does NOT change your genre bucketing at this stage — downstream filters the track pool at query time. Just carry the value into the output verbatim.
- **Popularity preference (carry-through, do NOT re-classify):** Already set in R1/R2 and threaded into the input. When `"hard"` or `"soft"`, it DOES shape bucketing: esoteric / niche-only genres (e.g. `Peruvian Chicha`, `Anatolian Psychedelic Rock`, `Tishoumaren`, `Dabke`, `Neo Exotica`, `Ethio-Jazz`, `Rebetiko`, `Laiko`, `Turk Arabesk`, `Medieval Music`, `Piano Impressionism`) go to `conditional` at most — unless a direct like or super-like on that specific genre puts them in `approved`. When `"none"`: no effect on bucketing. Carry the value into the output verbatim regardless.
- **Japanese Folk Restriction:** Leave `Japanese Folk` out of both lists (excluded) UNLESS the venue is explicitly a Japanese business needing particularly calm/relaxing music OR the owner explicitly requested it in emphases.
- **Atmospheres vs. Text:** Treat selected atmospheres as strong, authoritative signals. If the free-text description directly contradicts, prioritize the description and note the tension in `reasoning_en`.
```

#### `DEDUCTION_LOGIC_SECTION`

```
## Deduction Logic

Walk through all 116 canonical genres and assign each to EXACTLY ONE bucket: `approved`, `conditional`, or `excluded`. Only `approved` and `conditional` are written to the output. `excluded` is implicit: to exclude a genre, simply leave it out of both lists. This means a genre you forget to list is silently excluded — so make sure every genre that deserves `approved` or `conditional` (including the "no signal → conditional" default in step 4) is actually listed.

### 1. Aggregate positive signal per genre

Positive signal sources, strongest → weakest:
- **Super-liked genre.** The owner super-liked a specific track drawn from this genre. Strongest positive signal. → `approved`.
- **Genre appears in a liked direction.** → `approved`, unless a stronger negative signal overrides.
- **Musical emphases explicitly requested this genre or its family.** → `approved`.
- **Tight-cluster neighbour.** The genre shares energy tier, instrumentation family, cultural register, and mood with a super-liked or liked genre. → `approved` if all four axes match; → `conditional` if 2–3 axes match.

### 2. Aggregate negative signal per genre

Negative signal sources:
- **Genre appears ONLY in disliked directions and NEVER in any liked direction.** → `excluded`.
- **Musical emphases explicitly excluded this genre or its family.** → `excluded`.
- **Japanese Folk Restriction triggers.** → `excluded`.

### 3. Cross-check and resolve conflicts

Priority order when a genre has multiple signals:
1. Super-like beats everything. → `approved`.
2. Round 2 refinement emphases beats everything below.
3. Round 1 musical emphases (explicit include or exclude) beats direction-level signals.
4. Direction-level like beats direction-level dislike ONLY if the like is consistent with another positive signal elsewhere in the profile. Otherwise → `conditional`.

### 4. Untouched genres (never appeared in any R1/R2 direction)

For the many genres the user never saw:
- Tight-cluster neighbour (all four axes match) of a super-liked genre → `approved`.
- Tight-cluster neighbour of a liked (non-super) genre → `conditional` (default) or `approved` (if multiple liked directions independently point at it).
- Semantic distant-relative of a liked genre with no negative counterweight → `conditional`.
- Semantic distant-relative of a disliked genre with no positive counterweight → `excluded` if the negative signal is coherent; `conditional` if it's noisy.
- No signal in either direction → `conditional` (default for "we don't know").

### 5. No blanket exclusions

Do NOT apply family-level bans based on a single dislike. Example: the owner disliked a direction containing `Deep House` but super-liked a `Nu Disco` track — `Deep House` itself is NOT automatically `approved` (the dislike matters) but the broader "electronic dance" family is NOT excluded either. Each electronic genre must be evaluated on its own signal aggregate.
```

#### `ENERGY_CALIBRATION_SECTION`

```
## Energy Calibration & Assignment

After bucketing, calibrate a per-user energy scale for the approved + conditional genres. This scale is RELATIVE to the user's own taste range — not an absolute ladder.

### Step 1: Determine N (number of energy levels)

Look at the highest-energy and lowest-energy genres in the user's approved + conditional set. Estimate the spread:
- **Narrow spread** (all mid-energy chill OR all high-energy dance — no meaningful energy variation): `N=2`.
- **Moderate spread** (typical mixed profile — chill background + some upbeat): `N=3` or `N=4`.
- **Wide spread** (chill acoustic AND upbeat dance both present in the profile): `N=5`.
- **Very wide spread** (contemplative acoustic AND aggressive electronic both present): `N=6`.

Rules:
- `N` MUST be an integer between 2 and 6 inclusive.
- Prefer the SMALLEST `N` that meaningfully distinguishes operational contexts for this user. If two adjacent levels would contain genres that could easily be swapped between them, collapse them.

### Step 2: Assign each approved and conditional genre a level 1..N

- Level `N` = the highest-energy genres in the user's set.
- Level `1` = the lowest-energy genres in the user's set.
- Everything else is bucketed relatively.
- Same-energy genres get the same level.
- Assignment is RELATIVE. Concrete illustration:
  - User A likes acoustic chill + hip hop. Hip Hop is their ceiling → `Hip Hop` gets level `N`.
  - User B likes hip hop + house + dubstep. Hip Hop is mid-range for them → `Hip Hop` gets level 3 (out of 5 or 6).

### Step 3: Excluded genres get NO energy level

Excluded genres are not in the output at all, so they carry no level.
```

#### `OUTPUT_FORMAT`

```
## Output format

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
- `energy_levels_total`: integer 2..6. Total number of energy levels in this user's scale.
- `approved_genres`: array of `{genre, energy_level}`. `energy_level` is an integer 1..N.
- `conditional_genres`: array of `{genre, energy_level, note_en}`. `energy_level` is an integer 1..N. `note_en` is one short English sentence explaining why the genre is conditional (for developer audit — this bucket is data-only, not used by the initial playlist build).
- Do NOT output an `excluded_genres` field. Every canonical genre missing from both lists above is excluded automatically.
- `instrumentalness_preference`: carried through verbatim from R1/R2 (`"none"` | `"soft"` | `"hard"`).
- `popularity_preference`: carried through verbatim from R1/R2 (`"none"` | `"soft"` | `"hard"`).
- `reasoning_en`: one paragraph in English for developer audit.

Hard invariants:
- No genre may appear in both `approved_genres` and `conditional_genres`, or twice in the same list.
- Every genre string must be VERBATIM from the Genre Universe.
- Every approved/conditional genre has an `energy_level` between 1 and `energy_levels_total`.

Error case (return instead of a profile):
{"error": "<code>", "reasoning_en": "one short English sentence"}
```

---

## 2026-09-24 — Round 2: realigned with the current v7 Round 1 (probe-world R2)

**Applies to:** Round 2

Roni asked for v7 R2 to relate to v7 R1 the way v6 R2 relates to v6 R1. That relationship, made explicit: (a) every shared R1 rule section is imported verbatim, so R1 edits flow into R2; (b) R1's round-specific sections (intro, inputs, diversity rule, task workflow, output format) are re-authored for R2 but keep R1's concrete parameters; (c) a Round-2-only Learning section applies R1's design philosophy to the owner's decisions (v6: blends → "bridge genres" sharing ANY axis with the likes).

v7 R2 already followed (a)/(b) mostly — genre counts (3–6 + standalone list), 3–6-word titles, output fields and the rule list all still match current v7 R1 — but had drifted in three ways, now fixed:

1. **Learning step 3 made 4 probes impossible to build.** It restricted the Working Pool to "tight-cluster neighbours" (genres sharing ALL four axes with a liked genre) while R2 also imported R1's Direction Distinctness (any two clusters must differ on ≥ 2 axes). Around 1–2 liked probes those two rules contradict each other. Step 3 now maps the NEIGHBOURHOOD of each liked probe: tight-cluster neighbours (re-confirm a liked vector with fresh genres) AND adjacent-archetype genres (keep most of a liked probe's axes, move one or two) — the probe-world analogue of v6's bridge genres. Every individual probe must still pass Cluster Homogeneity; adjacency is between a probe and a liked vector, never inside a probe. Steps 1/2/5 now reason in archetypes too (liked probes → Positive Vectors; disliked probes → rejected archetypes; super-liked genres count as positive even from a disliked probe; zero likes → explore archetypes R1 didn't test).
2. **R1's `DISTINCTNESS_SECTION` was imported verbatim** ("The 8 clusters must…", ≥ 2 axes). v6 R2 never imported R1's diversity rule — it wrote a Round-2 version (`REFINED_NON_OVERLAP_SECTION`). v7 R2 now does the same: new `REFINED_DISTINCTNESS_SECTION` replaces both the import and the old `REFINED_OVERLAP_POLICY` — ≥ 1 differing axis between R2 probes when refining around likes, R1's ≥ 2 when there are zero likes; at most one re-confirmation probe per liked vector; a probe derived from a liked one must be at least half un-probed genres; never rebuild a disliked archetype; genre overlap between R2 probes still allowed.
3. **Intro/inputs lagged R1's framing.** `REFINED_INTRO` now carries R1's cluster definition and the downstream-dissolve context (overlap = stronger signal). `REFINED_INPUTS_SECTION`: "Round 1 directions" is now "the Round 1 probes the owner saw, each with rank (1–8)…" (matches the 2026-09-23 input fix — page 1 plus swiped page-2 probes are passed).

Also: `REFINED_TASK_WORKFLOW` rule list now names "Direction Distinctness & Overlap (Round 2)"; super-liked bias refers to "neighbours from Learning step 3". Section order: … Homogeneity, Energy & Pairing, Learning, Distinctness & Overlap (R2), Task Workflow … (Distinctness moved after Learning because it uses Learning's vocabulary). Places anchors unchanged; verified offline that both Places blocks still inject, R1's homogeneity + groove-family rules are present via import, and no BPM text remains.

Unchanged: `REFINED_OUTPUT_FORMAT`, `ROUND2_ADDITIONAL_ERROR`, Learning steps 4 and 6, every imported R1 section.

**`REFINED_INTRO`** (full text):

```
You are refining a previously generated set of diagnostic taste probes for a public-facing-business playlist tool. In Round 1 the owner was shown up to 8 tightly-clustered "musical directions" — each a small group of near-identical genres (same energy tier, same instrumentation family, same cultural register, same mood) — heard one representative song from each, and liked fewer than 3. Your task now is to analyze their decisions — including which specific genres they super-liked a track from — and produce 4 brand-new diagnostic probes that pin down the parts of their taste Round 1 didn't. Each new probe is still a tight cluster, not a blended playlist. Downstream, every liked probe from either round dissolves into a flat liked-genres list — overlapping genres across two liked probes become a stronger signal, not a bug.
```

**`REFINED_INPUTS_SECTION`** (full text):

```
## Inputs

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
- **Super-liked genres** — a deduped list of specific GENRES (not whole directions) that the owner super-liked at least one track from. Each entry is a single genre string from the Genre Universe. Super-liking is a sharper signal than merely liking a direction: the owner reacted specifically to a track drawn from that genre, so that genre carries extra positive weight beyond what its containing direction alone would suggest. May be empty.
```

**`LEARNING_LOGIC_SECTION`** (full text):

```
## Learning & Processing Logic (Round 2)

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
- Set every direction's `instrumentalness_preference` to the same value you would emit for Round 1 given the same emphases text (consistent across all 4 directions).
- Set every direction's `popularity_preference` the same way — same rule applies (uniform across the 4 directions unless the emphases text explicitly asked for per-direction variance).

### 5. Special case: zero Liked directions
If the Liked list is empty:
- Treat Description + Atmospheres + Musical Emphases + Round 2 refinement emphases (and any super-liked genres) as your positive signal.
- Use Disliked strictly as a negative filter — both its genres (step 2) and its archetypes.
- You are now exploring, not refining: build 4 archetypes that Round 1 did NOT test, consistent with the positive signal and away from every disliked archetype.
- If those positive inputs give too little signal AND the Disliked directions are internally contradictory (e.g., the owner disliked both a purely acoustic AND a purely electronic direction, offering no coherent negative filter), return `{"error": "insufficient_signal", ...}` rather than fabricating clusters from thin air.

### 6. Round 2 refinement emphases (highest priority when present)
When the owner supplied Round 2 refinement emphases, treat it as the STRONGEST signal available — above everything else, including the initial Round-1 Musical Emphases, the atmospheres, the super-liked genres, and the like/dislike buckets. It was written after they saw actual tracks and knew what they wanted more of or less of. When it contradicts any other signal, IT WINS.
- Genres or families explicitly requested: at least half of your 4 output clusters should center on them.
- Genres or families explicitly rejected: DROP them from every cluster, even if a Liked or super-liked genre would suggest them.
- General leanings ("more upbeat", "less electronic", "make them more surprising"): must shape every one of the 4 clusters, not just some.
- If empty or missing, fall back to steps 1–5 above.
```

**`REFINED_DISTINCTNESS_SECTION`** (full text):

```
## Direction Distinctness & Overlap (Round 2)

Round 1 required its 8 clusters to differ on at least two of the four axes. Round 2 deliberately works closer to the owner's positive signal, so the rule is adjusted:

- **Between your 4 Round 2 probes:** each must test a different taste vector — any two probes must differ on at least ONE of energy tier, instrumentation family, cultural register, mood. When the Liked list is empty (you are exploring, not refining), use Round 1's stricter rule: differ on at least TWO axes.
- **Probe mix when there are likes:** spend at most ONE probe per Positive Vector on a tight-cluster re-confirmation; use the rest on adjacent archetypes (Learning step 3). Four re-confirmations of the same liked probe waste the round.
- **Vs. Round 1 liked probes:** a Round 2 probe may share genres with a liked probe and be recognizably derived from it, but must not repeat it — at least half of its genres must be genres the owner wasn't already probed on in Round 1.
- **Vs. Round 1 disliked probes:** never rebuild a disliked probe's archetype (same energy tier + instrumentation family + cultural register + mood — that is exactly what the owner rejected). Sharing an individual genre with a disliked probe is fine only when that genre survived the ban in Learning step 2.
- **Overlapping genres between your Round 2 probes are allowed**, same as Round 1: if a genre legitimately sits inside two of your new archetypes, ship it in both — the overlap becomes a stronger genre-level taste signal downstream.
```

**`REFINED_TASK_WORKFLOW`** (full text):

```
## Task Workflow (Round 2)

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
   - **Genres list:** 3 to 6 genres from the Working Pool that form a tight, near-identical cluster. Certain genres may form a 1–2 genre standalone cluster (`Nu Metal`, `Indie Rock`, `Punk`, `Blues`, `Folk`, `Jazz House`) if that best fits the owner's taste.
   - **instrumentalness_preference:** Same value across all 4 clusters, derived from the Musical Emphases text using the same rules as Round 1 (`"none"` | `"soft"` | `"hard"`).
   - **popularity_preference:** Same value across all 4 clusters by default, derived from the Musical Emphases text using the same rules as Round 1 (`"none"` | `"soft"` | `"hard"`). If the emphases text explicitly asks for per-cluster variance (time-of-day / context-based), vary it to match. When set to `"hard"` or `"soft"`, it also influences your GENRE picks — skew away from esoteric genres, lean toward hit-friendly catalogs (see the Round-1 sub-rule for the full lists).
5. Rank clusters best-fit first based on strength of the taste signal.
```

**Removed:** `REFINED_OVERLAP_POLICY` (superseded by `REFINED_DISTINCTNESS_SECTION`); the `DISTINCTNESS_SECTION` import from `musical-directions.js`.

---

## 2026-09-23 — Round-2 + taste-profile: user-message INPUT fixes (no prompt-text change)

**Applies to:** R2 + taste profile (user message contents only; every system-prompt sub-constant is byte-identical)

Found during a v7 browser-flow audit. Both prompts refer to directions by **rank** ("LIKED (ranks): …"), and two runtime bugs made those ranks point at nothing or at the wrong direction:

1. **R1 page 2 was never described.** `v7/app.js` passed `round1Directions: state.directions`, which only ever holds R1 page 1 (ranks 1–4); page 2 (ranks 5–8) lives inside `preview.js`. Liked/disliked lists could still contain ranks 5–8, so the model saw e.g. "LIKED: 2, 6" with no rank-6 direction in the Round 1 block. Fix: new `round1DirectionsSeen()` helper in `v7/app.js` passes page 1 **plus every other R1 direction found in the like/dislike lists**, deduped by rank and sorted. Used for the R2 call, the taste-profile call, and the taste-profile retry. (The taste-profile prompt already says "Round 1 directions — up to 8 diagnostic probes", so the prompt was right; the input wasn't.)
2. **R2 ranks collided with R1 ranks.** `normalizeDirections(parsed, 1)` numbered R2 directions 1–4, the same as R1 page 1, while the taste-profile message lists LIKED/DISLIKED as "combined R1+R2". R2 is now renumbered **9–12** (`R2_RANK_START` in `v7/generation/refined-directions.js`). The model still emits 1–4 and normalizeDirections renumbers, so nothing in the R2 system prompt changed. All downstream rank uses are lookup keys or sorts (preview anchors key by `String(rank)`), so the new numbers are safe.

Separately (not a prompt change, logged here because it blocked the taste profile): the taste-profile RETRY closure referenced a step-5 block-scoped `round2Directions`, so every retry threw a ReferenceError and looped the retry screen forever. `round2Directions` now lives on `state`.

Known v6 parallel (NOT changed; v6 untouched): v6's R2 call has the same page-1-only `round1Directions` gap for liked page-2 directions.

---

## 2026-09-23 — energy directions: new prompt module for v7 "Option 1" daily playlist mode

**Applies to:** `energy directions`

New prompt module `v7/generation/energy-directions.js`. Runs AFTER the taste profile is persisted; takes the taste profile's `approved_genres` (each carrying a per-user energy_level 1..N) and groups them into "energy-tiered directions" — small tight genre clusters split into a HIGH tier and a LOW tier. These directions seed v7's "Option 1" daily playlist mode (4 playlists/day = 2 high-energy + 2 low-energy). Only `approved_genres` are used; `conditional_genres` and `excluded_genres` are ignored and never sent to the model. Success shape: `{ directions: [{ energy_tier: 'high'|'low', title_en, genres: [...] }] }`. Error shape: `{ error: 'insufficient_signal'|'matcher_error', reasoning_en }`. Mirrors `taste-profile.js` structure (sub-constants → EDITABLE + FIXED → assembleSystemPrompt; canonicalize via lowercase map; callModel wrapper; public entry with guards). label = `'v7-energy-directions'`, maxTokens = 8192, cache = true.

Key sub-constants authored:

### `ENERGY_DIRECTIONS_INTRO`

> "You group a user's approved music genres into a small set of "energy-tiered directions" for a public-facing-business playlist tool. The user has already completed onboarding and a full-catalog taste profile has been computed and persisted. You will receive ONLY the user's APPROVED genres — each tagged with a per-user energy level on the user's own dynamic energy scale — plus light venue context. Your job is to split the approved genres into a HIGH-energy tier and a LOW-energy tier, then form small, tight, energy-and-vibe-coherent clusters ("directions") WITHIN each tier. These directions become the seeds for the daily playlists (roughly two high-energy playlists and two low-energy playlists per day)."

### `TIER_SPLIT_RULES_SECTION`

> "## Tier Split & Clustering Rules
>
> ### 1. Only approved genres are in play
>
> Build every direction ONLY from the approved genres you were given. NEVER invent a genre, translate one, add a qualifier, or pull in a genre that is not in the approved list. Any string not present verbatim in both the approved list AND the Genre Universe will be silently dropped downstream.
>
> ### 2. Split the approved genres into two energy tiers by the user's own scale
>
> The user's scale has N levels (N = energy levels total). Define the midpoint as \`N/2\`:
> - **HIGH tier** = approved genres whose \`energy_level\` is in the UPPER half of the scale, i.e. \`energy_level > N/2\`.
> - **LOW tier** = approved genres whose \`energy_level\` is in the LOWER half of the scale, i.e. \`energy_level <= N/2\`.
>
> Every approved genre lands in exactly one tier based on its \`energy_level\`. Examples:
> - N=4, midpoint 2: levels 3–4 are HIGH, levels 1–2 are LOW.
> - N=6, midpoint 3: levels 4–6 are HIGH, levels 1–3 are LOW.
> - N=2, midpoint 1: level 2 is HIGH, level 1 is LOW.
>
> ### 3. Form directions WITHIN each tier — never mix tiers
>
> A HIGH direction contains only HIGH-tier genres; a LOW direction contains only LOW-tier genres. NEVER place a high-energy genre in a low direction or a low-energy genre in a high direction. The whole point of the split is that each daily playlist has a coherent energy register — mixing tiers breaks that.
>
> ### 4. Small tight clusters, not one big dump per tier
>
> Each direction is a small tight cluster of genres that are similar in energy AND vibe (instrumentation family, cultural register, mood) — same spirit as v7's diagnostic probes. Do NOT dump every high-energy genre into a single high direction; split a tier into coherent sub-clusters that each represent a distinct musical archetype within that energy register.
>
> ### 5. How many directions per tier — model's call, with a FLOOR of 2
>
> You decide how many directions each tier gets based on how many distinct genres/clusters that tier holds. There is a HARD FLOOR of **2 directions per tier**:
> - If a tier has plenty of genres, split it into as many coherent distinct clusters as make sense (aim for tight, non-redundant clusters).
> - If a tier genuinely has very few genres, still return at least 2 directions for that tier — they may share or overlap genres if unavoidable, but prefer coherent distinct clusters whenever the genre count allows.
> - Never return fewer than 2 directions for a tier that has any approved genres in it.
>
> ### 6. Titles
>
> \`title_en\` is a short English label describing the cluster's character (e.g. "Late-Night Jazz", "Driving House Grooves"). English only. Keep it concise."

Normalization enforces: drop directions with a bad `energy_tier`; canonicalize genres via lowercase map (drop non-universe / dedup within a direction); drop directions with zero valid genres; `console.warn` (no hard-error) when a tier that produced ≥1 direction came back with <2. `place` is appended as an optional "## Venue context" block in the user message (defensive, no strict anchor scheme).

---

## 2026-09-23 — taste profile: fix stale "5 axes" leftover from the BPM-axis removal

**Applies to:** `taste profile`

Follow-up to the BPM/tempo-axis removal below. That pass updated the tight-cluster-neighbour definition in `DEDUCTION_LOGIC_SECTION` §1 to "all four axes match" (energy tier, instrumentation family, cultural register, mood — tempo dropped), but missed one downstream reference in §4 ("Untouched genres") which still read "all 5 axes match". Since only four axes are defined anywhere in the prompt, "all 5" was unsatisfiable, so an untouched genre that is a genuine four-axis neighbour of a super-liked genre could never clear the §4 `approved` threshold and would be demoted to `conditional` — a bucket the initial v7 playlist builder ignores. That silently dropped exactly the kind of extrapolated genre the taste-profile stage exists to surface.

- `taste-profile.js` — `DEDUCTION_LOGIC_SECTION` §4 first bullet: "Tight-cluster neighbour (all 5 axes match) of a super-liked genre" → "Tight-cluster neighbour (all four axes match) of a super-liked genre". One-word content fix; no code or schema change.

---

## 2026-09-23 — Round-2 + taste-profile: BPM/tempo axis removed everywhere it appeared in R1

**Applies to:** `Round 2` + `taste profile`

The BPM removal from R1 (see next entry) also had to propagate to R2 and taste-profile since both refer to R1's directions and either re-cited the "same tempo" axis or emitted their own `bpm_range` field:

- `refined-directions.js` — `REFINED_INTRO` axis list dropped "tempo" (was "same tempo / energy / instrumentation / cultural register / mood"). `REFINED_INPUTS_SECTION` — R1 direction description no longer mentions `bpm_range`. `LEARNING_LOGIC_SECTION` steps 1 and 3 — dropped "tempo band" from the shared-traits list (now 4 axes: energy tier, instrumentation family, cultural register, mood). `REFINED_OVERLAP_POLICY` vs-disliked bullet — dropped "tempo band" from the cluster-shape composition (now energy tier + instrumentation family + cultural register). `REFINED_TASK_WORKFLOW` step 2 — homogeneity axes trimmed. Step 4 — "BPM ceiling" bullet removed. `REFINED_OUTPUT_FORMAT` — `bpm_range` removed from the schema example.
- `taste-profile.js` — Inputs section — R1 direction description no longer mentions `bpm_range`. `DEDUCTION_LOGIC_SECTION` step 1 tight-cluster-neighbour bullet — dropped "tempo band" (now 4 axes: energy tier, instrumentation family, cultural register, mood; approved threshold is now "all four axes match", conditional is "2–3 axes match"). `ENERGY_CALIBRATION_SECTION` — dropped "not an absolute BPM ladder" phrasing (now "not an absolute ladder"). "Narrow spread" description reworded from "all mid-tempo chill OR all high-energy dance" to "all mid-energy chill OR all high-energy dance". `formatDirection` helper — dropped `bpm_range: X-Y` line from the multi-line direction rendering.
- Code: `validateBpmRange` deleted from `refined-directions.js`; `validateDirection` no longer checks `bpm_range`.

Header comments in both files updated to reference the 2026-09-23 removal date.

---

## 2026-09-23 (same session, earlier) — Round 1: five targeted edits based on Ami's proposed rewrite

**Applies to:** `Round 1`

Ami came back with a proposed rewrite of the R1 EDITABLE prompt aimed at fixing a specific bad probe (Funk + Neo Soul + Acid Jazz being clustered together for a barbershop). Roni went through it against the current v7 prompt and picked five targeted changes; Ami's other proposed changes (Inflexible Genre Energy Assumption, Cluster Homogeneity OVER User Emphases, Prioritizing User Preferences in Direction Ordering, Afro Label Disambiguation Rule, Organic House & DownTempo Isolation, Hebrew description reframing as `בודק פתיחות ל…`) were NOT adopted in this pass — they're not rejected, just deferred for separate evaluation.

### Change 1 — `JAZZ_ISOLATION_RULE`: adopted Ami's simpler version

Was (v7 pre-2026-09-23, byte-identical to v6):

> "**Jazz Sub-genres Containment:** All Jazz genres (`Jazz (Standards)`, `Late Night jazz`, `Smooth Jazz`, `Swing Jazz`, `French Jazz`, `Gypsy jazz`, `JazzHop`) are intrinsically laid-back, background, or seated styles. They MUST NEVER be paired with dancing, energetic, or heavy beat-driven genres (such as RnB, Hip Hop, Funk, Pop, or Dance).
> **Allowed Jazz Pairings:** Except for `Ethio-Jazz` and `Acid Jazz` (both rhythmic/uplifting and can blend with Afro/Funk/R&B styles) and `Jazz House` (enclosed under House rules), all Jazz genres can ONLY be paired with:
>   - Other Jazz genres.
>   - `Bossa Nova`
>   - `Fado`"

Now:

> "- All Jazz genres (`Jazz (Standards)`, `Late Night jazz`, `Smooth Jazz`, `Swing Jazz`, `French Jazz`, `Gypsy jazz`, `JazzHop`) MUST NEVER be paired with dancing, energetic, or heavy beat-driven genres (RnB, Hip Hop, Funk, Pop, Dance).
> - Allowed Jazz Pairings: Only with other Jazz genres, `Bossa Nova`, or `Fado` (Exceptions: `Ethio-Jazz`, `Acid Jazz`, and `Jazz House`)."

Rationale: v6 phrasing explicitly said Ethio-Jazz and Acid Jazz "can blend with Afro/Funk/R&B styles" — that was appropriate for v6's blended-playlist world but reads as a green light for Acid Jazz + Funk in v7's diagnostic-probe world. Ami's simpler wording keeps them named as exceptions without licensing the specific pairing.

### Change 2 — `DISTINCTNESS_SECTION` preserved

Ami's proposal dropped `DISTINCTNESS_SECTION` entirely. We kept the section we already had. Unchanged from the initial v7 authoring:

> "## Direction Distinctness
>
> The 8 clusters must represent distinctly different musical archetypes. Any two clusters should differ on at least two of: energy tier, instrumentation family, cultural register, mood. If two of your clusters test the same taste vector you've wasted a probe slot — replace one of them.
>
> **Overlapping genres across clusters are allowed.** If a genre legitimately sits at the intersection of two archetypes (e.g. `Bossa Nova` in both a 'late-night jazz' cluster and a 'sultry acoustic' cluster), it may appear in both. When the owner likes two clusters that share a genre, the overlap becomes a stronger genre-level taste signal downstream — a feature, not a duplicate."

(The "differ on at least two of" list dropped "tempo band" as part of change 4 below.)

Rationale: without a distinctness rule the model could emit 8 near-identical probes for a focused venue and waste the diagnostic slots.

### Change 3 — `BEAT_PERCUSSION_RULE` rewritten as groove-family disambiguation

The single biggest fix in this session. v6 (and v7 pre-2026-09-23) had:

> "NEVER pair genres with strong rhythmic grooves, prominent drum patterns, or sexy/upbeat vibes (e.g., `RnB`, `French RnB`, `Funk`, `Neo Soul`) with ambient, drumless, or slow acoustic genres (e.g., `Late Night jazz`, `Piano Impressionism`, `Chamber music`). Switching between a drum-driven beat and a beatless slow jazz track inside a single cluster is strictly forbidden."

The parenthetical grouping "(e.g., `RnB`, `French RnB`, `Funk`, `Neo Soul`)" read to the model as a single-cluster license — those four genres presented together AS THE EXAMPLE of the groove family. Ami's proposed rewrite kept the same grouping and did not fix this.

New version explicitly splits the groove family into disjoint tight-cluster boundaries:

> "### 1. Beat & Percussion Pairing (Groove-Family Disambiguation)
>
> NEVER pair drum-driven groove genres with ambient, drumless, or slow acoustic genres (e.g., `Late Night jazz`, `Piano Impressionism`, `Chamber music`). Switching between a drum-driven beat and a beatless slow track inside a single cluster is forbidden.
>
> **Within the groove family, DO NOT group genres that share only 'having a beat' as a common trait.** They test different listener profiles and belong in different diagnostic probes. The tight-cluster boundaries inside the groove family are:
>
> - **RnB family** — `Rnb`, `French RnB`, `Japanese RnB`, `Korean RnB` cluster with each other. Vocal-forward, polished, contemporary R&B. NOT with Funk. NOT with Neo Soul.
> - **Funk family** — `Funk`, `Afro Funk`, `Italian Funk`, `French Funk`, `Greek Funk`, `Latin Funk`, `Arabic Funk` cluster with each other. Horn-forward, raw, rhythm-section-driven organic groove. NOT with Neo Soul. NOT with the RnB family.
> - **Neo Soul family** — `Neo Soul`, `Alternative R&B` cluster with each other. Vocal-driven, contemporary, moody. NOT with Funk. NOT with the RnB family.
> - **Hip Hop family** — `Hip Hop`, `French Hip Hop`, `German Hip Hop`, `Icelandic Hip Hop` cluster with each other. Rhymed vocals over programmed beats, urban. NOT with Funk. NOT with Neo Soul.
> - **Trap / Drill family** — `Trap`, `Grime & Drill` cluster with each other, or with Hip Hop genres of matching aggressive energy. Sharp electronic beats, edgy. NOT with organic Funk. NOT with classic RnB.
>
> If a probe cluster reaches across two of these boundaries (e.g. `Funk + Neo Soul`, or `Funk + Acid Jazz`), it's testing more than one taste vector and is invalid. Split it into separate clusters."

Rationale: the barbershop case that motivated this session (`Funk + Neo Soul + Acid Jazz` in one direction) is now explicitly a rejected pattern named in the closing paragraph of the rule.

### Change 4 — All BPM / tempo references removed from R1

Roni asked for BPM to come out entirely from the prompt. Applied across:

- `HOMOGENEITY_SECTION` — dropped the "**Same tempo band.** All genres in the cluster share the same BPM range." bullet from the 5-axis list; now 4 axes (energy tier, instrumentation family, cultural register, mood).
- `DISTINCTNESS_SECTION` — "differ on at least two of" list dropped "tempo band"; now 4 axes.
- `ROUND1_INTRO` — dropped "same tempo band" from the near-identical axis enumeration.
- `ROUND1_TASK_WORKFLOW` — dropped the entire "**BPM ceiling:** …" bullet from the per-direction fields.
- `ROUND1_OUTPUT_FORMAT` — `bpm_range` removed from the JSON schema example.
- `buildUserMessage` — page-2 broadening hint no longer mentions "different tempo bands, energy tiers, or cultural registers"; now "different energy tiers, instrumentation families, or cultural registers".
- Code: `validateBpmRange` deleted; `validateDirection` no longer checks `bpm_range`.

`HOMOGENEITY_SECTION` also had "mid-tempo groove" phrasing that got reworded to "mid-energy groove" — the "tempo" word was being used descriptively but Roni asked for ALL references gone.

Downstream note recorded: `v5_direction_tracks` / `v5_anchor_tracks` RPCs still take a `bpm_max` parameter. When v7's playlist stage is built the RPC either gets a wide-open BPM ceiling or the parameter is extended to support a no-filter mode. Not a v7-prompt concern; flagged for when we get there.

### Change 5 — Popularity preference "hit ∈ [60, 100]" kept intact

Ami's proposal had trimmed the "**Fixed definition — a 'hit' ALWAYS means popularity ∈ [60, 100].**" language along with the extended trigger-phrase list and the DB-behavior per-state breakdown. Roni asked for that language to stay in. Since v7's `PROCESSING_RULES_SECTION` inherited the full v6 sub-rule verbatim, the fix was to NOT adopt Ami's trim — no edit was needed to the file, but noting here for the audit trail.

---

## 2026-09-23 — Taste profile: Google Places injection removed

**Applies to:** `taste profile`

Initial authoring of the taste-profile prompt included Google Places injection at the same anchors R1/R2 use (`### Processing Rules:` for the input block; `## Deduction Logic` for the processing rule). Roni challenged the inclusion.

The taste-profile stage extrapolates from swipe-deck signal to a full-catalog taste map — that's a property of the user's taste, not of the venue. Google Places is venue context, and the venue context was already baked into R1/R2 when the model built the probes the user swiped on. Reusing Places at the taste-profile stage would mix venue-appropriateness signal into a user-taste extrapolation — the two are orthogonal.

The specific injected processing rule was particularly bad:

> "`liveMusic: true` may nudge live-music genres (Jazz, Blues, Folk) toward `approved` even on weak swipe-deck signal."

That's exactly wrong for a taste profile — if the user rejected every live-music-adjacent probe on the swipe deck, they don't want live music regardless of what Google says the venue is set up for. Places-based override of the user's actual taste is the wrong direction.

Removed:
- `PLACES_INPUT_BLOCK` constant.
- `PLACES_PROCESSING_RULE` constant.
- `injectPlaces` function.
- "Google Places context" bullet from `TASTE_PROFILE_INPUTS_SECTION`.
- `place` parameter from `buildUserMessage` and `generateTasteProfile` signatures.
- `formatPlaceContext` helper (only used by the removed injection).

`assembleSystemPrompt` simplified to `editable + '\n\n' + FIXED_PROMPT_SECTION`. Kept as an exported function anyway for API parity with R1/R2 — a future v7 Ami-style prompt-tuning dashboard for taste-profile can call the same entry point R1/R2 do.

Places stays in R1/R2 (venue-aware clustering) and in the eventual v7 downstream playlist builder (venue-appropriate scheduling). Not in taste-profile.

Assembled system prompt shrunk from 15,686 → 14,341 bytes.

---

## 2026-09-23 — Taste profile: initial authoring

**Applies to:** `taste profile`

New stage added to the v7 pipeline (module authored, not wired to a caller yet). Fires once after the swipe deck resolves (R1 + optional R2), before any playlist is built. Job: extrapolate from the sparse swipe-deck signal (up to 12 probes across R1+R2 + per-direction like/dislike + per-track super-likes) to a full-catalog taste profile.

Output shape:

```
{
  energy_levels_total: <2..6>,
  approved_genres:    [{ genre, energy_level }, ...],
  conditional_genres: [{ genre, energy_level, note_en }, ...],
  excluded_genres:    [string, ...],
  instrumentalness_preference: 'none' | 'soft' | 'hard',
  popularity_preference:       'none' | 'soft' | 'hard',
  reasoning_en: string,
}
```

Key decisions embedded in the prompt design:

1. **Every one of the 116 canonical genres must land in EXACTLY ONE bucket.** Hard invariant declared in the prompt AND enforced server-side by `normalizeTasteProfile` — any genre the model forgets to bucket is auto-added to `excluded_genres`. Case-drifted names get canonicalized via a lowercase→canonical map; invented genres (e.g. "Slow Funk") are dropped.
2. **Energy calibration is RELATIVE, not absolute.** N is chosen dynamically 2–6 based on the SPREAD of the user's taste. Hip Hop can be level 6 for a mostly-chill user or level 3 for a user who also picked Dubstep. Step 1 of the calibration section spells out the four spread bands (narrow / moderate / wide / very wide → N=2 / N=3-4 / N=5 / N=6). Step 2 pins level N as the highest-energy genre the user's approved+conditional set contains and level 1 as the lowest, with everything else bucketed relatively.
3. **Conditional bucket is "data only, not used by pipeline" for v7 launch** — kept because the signal it captures is real and the model is already reasoning over the full catalog; conditional-bucket downstream use is deferred.
4. **inst_pref + pop_pref carry through from R1/R2.** DO NOT re-classify. Popularity preference DOES shape bucketing (esoteric/niche-only genres go to conditional at most when pop_pref is `hard` or `soft`, unless a direct like or super-like on that specific genre puts them in approved). Instrumentalness preference does NOT shape bucketing at this stage (downstream track-pool filter handles the effect).
5. **No blanket exclusions.** A "Deep House" dislike doesn't ban all electronic if they super-liked a Nu Disco track. Every genre is evaluated on its aggregate signal.
6. **Priority order when conflicts:** Super-like beats everything → R2 refinement emphases → R1 musical emphases (explicit include/exclude) → direction-level signals. Direction-level like beats direction-level dislike ONLY if the like is consistent with another positive signal elsewhere in the profile.

Kept from Ami's proposed 30-directions prompt (which was rejected as off-task for this stage):

- Three-bucket taxonomy (approved / conditional / excluded).
- Strict genre-name discipline rule ("You must NEVER invent, modify, rename, translate, add qualifiers to, or otherwise alter any genre name…").

Rejected from Ami's proposed prompt:

- The whole "output 30 playlists split into 15 low-energy + 15 high-energy" step. Wrong scope; playlist building is a downstream stage, not this one.
- Binary low/high energy split. Roni's design calls for 2–6 dynamic levels calibrated to each user's own taste spread; Ami's binary would collapse all the relativity signal.
- "You are an expert AI Music Ethnomusicologist" persona preamble.
- Ami's 120-genre list (with Surf Rock, Doo-Wop, Motown, Afro Cuban Jazz, Electronic R&B, French Touch not in DB, Heavy Rock/Metal split, various diacritic mismatches). Used the shared 116-genre list instead.
- Vague "extrapolate to similar sonic vectors" deduction rules. Rewrote as an explicit 5-step deduction logic (positive-signal aggregation → negative-signal aggregation → conflict resolution → untouched-genre defaults → no blanket exclusions).
- "fusion vibe" language that re-introduced diverse-cluster concept from v6.

Error contract: only `insufficient_signal` (safety net; upstream R2 restart flow already routes zero-picks users to restart, so this stage should never see it in practice) + `matcher_error` (post-normalization guard: if approved + conditional are both empty after coercion, treat as unusable).

Provider label for gemini_call_log: `v7-taste-profile`. Separates this stage's spend from `v7-onboarding` (R1) and `v7-onboarding-refined` (R2) in the admin API.

---

## 2026-09-23 — Ami's dashboard swapped from v5 prompt to v7 prompt

**Applies to:** `all v7` (tooling wiring)

Not a prompt content change — a tool-wiring change. Ami's prompt-tuning dashboard at `/v5/ami-prompt-dashboard/` used to import `EDITABLE_PROMPT_SECTION` + `assembleSystemPrompt` from `/v5/generation/musical-directions.js` (the byte-identical mirror of v6). Swapped to import from `/v7/generation/musical-directions.js`, and swapped the ai-provider import from `/v6/generation/ai-provider.js` → `/v7/generation/ai-provider.js`.

Rationale: Ami now tunes against v7's R1 prompt. v6 tuning is no longer offered from this dashboard (single-target choice — Roni explicitly said no v6/v7 toggle). v5's file remains in place because `v5/app.js` (the legacy standalone v5 UI) still imports from it.

Cache-bust `?v=` bumped to `20092026a` on the app.js script tag and on both swapped module imports.

Files touched:
- `v5/ami-prompt-dashboard/app.js` (import URLs + header comment)
- `v5/ami-prompt-dashboard/index.html` (script tag cache-bust)

No changes to `vercel.json`. The `/v7/(.*)` no-cache header rule pattern that matches `/v5/(.*)` and `/v6/(.*)` was NOT added — flagged for when v7 grows a UI. For the two prompt module files alone, the `?v=` bump is sufficient (busts intermediate CDN caches).

---

## 2026-09-23 — Round 2 initial authoring

**Applies to:** `Round 2`

Refinement stage authored (module authored, not wired to a caller yet). Fires when Round 1's swipe deck yields fewer than 3 liked directions. Produces exactly 4 refined probes.

Design shift from v6 R2 → v7 R2 mirrors the R1 shift:

- v6 R2 chose bridge genres for **multi-axis cross-cultural adjacency**; each new direction could be a diverse mix aimed at seeding a future playlist.
- v7 R2 chooses **tight-cluster neighbours** — genres that would sit inside the SAME diagnostic probe as a liked or super-liked genre. NOT cross-register bridges; genres tight enough to belong in the same cluster.

Sub-constants (all R2-specific, not shared with R1 — R2-only reasoning):

- `REFINED_INTRO` — task frame.
- `REFINED_INPUTS_SECTION` — enumerates all R1 inputs plus R1 directions + like/dislike buckets + super-liked genres + optional Round 2 refinement emphases.
- `LEARNING_LOGIC_SECTION` — 6-step reasoning skeleton: extract positive seeds → extract negative constraints → identify tight-cluster neighbours (NOT bridge genres) → honor musical emphases → zero-Liked special case → R2 emphases override (highest priority when present).
- `REFINED_OVERLAP_POLICY` — replaces v6's non-overlap constraint. In v7 R2 all overlap is allowed: within-R2 overlap, R2-vs-R1-liked overlap, R2-vs-R1-disliked genre-level overlap. Only forbidden: reproducing the overall CLUSTER SHAPE of a disliked direction (same energy tier + same instrumentation family + same cultural register).
- `REFINED_TASK_WORKFLOW` — 4 clusters, all shared rules apply, super-liked genre bias, per-cluster required fields (before 2026-09-23: also included BPM ceiling; removed in the BPM-purge above).
- `REFINED_OUTPUT_FORMAT` — same schema as R1 (before 2026-09-23: included `bpm_range`).
- `ROUND2_ADDITIONAL_ERROR` — new `insufficient_signal` error code specific to R2 (zero-likes + contradictory dislikes + thin positive inputs).

Provider label for gemini_call_log: `v7-onboarding-refined`. Ranks in R2 output start at 1 (not continuing R1's rank sequence). Downstream will merge R2 picks into `state.picked` and renumber at signup.

Shared sub-constants imported from `v7/generation/musical-directions.js` (verbatim re-use, no drift risk):

- `GENRE_UNIVERSE_SECTION` (via shared/genre-universe.js)
- `PROCESSING_RULES_SECTION`
- `HOMOGENEITY_SECTION`
- `DISTINCTNESS_SECTION`
- `ENERGY_PAIRING_SECTION`
- `OUTPUT_LANGUAGE_SECTION`
- `TITLE_RULES_SECTION`
- `HEBREW_DESCRIPTION_SECTION`
- `WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION`
- `injectPlaces`

R2 imports these directly rather than copying — R1 is the "canonical rule library" for v7 shared rules; R2 has its own composition. If a shared rule changes in R1, R2 picks it up automatically.

---

## 2026-09-23 — Round 1 initial authoring

**Applies to:** `Round 1`

v7's R1 prompt authored as a fork of v6's. Structural mirror (two-call 4+4 split, same output shape modulo bpm_range removal on 2026-09-23, same provider switch via ai-provider.js, same Places injection anchors) but with the design shift baked in.

Rules kept from v6 (acoustic-compatibility, not diversity — still valid in v7):

- Pop Isolation Rule (v6 §5, verbatim)
- House & Techno Containment Rule (v6 §6, verbatim)
- Musical Emphases handling (verbatim)
- Instrumentalness preference classification (verbatim)
- Popularity preference classification (verbatim)
- Japanese Folk Restriction (verbatim)
- Atmospheres vs Text tiebreaker (verbatim)
- Business Name rule (verbatim)
- Google Places context injection (verbatim; anchors: `### Processing Rules:` for input, `## Energy & Pairing Constraints` for the processing rule)
- Output Language / English Title conceptually / Hebrew Description vocabulary constraints (verbatim)
- When NOT to return directions (error contract, verbatim)

Rules kept BUT rewritten on 2026-09-23 (see entries above):

- Beat & Percussion Pairing — later rewritten as Groove-Family Disambiguation.
- Jazz Isolation Rule — later simplified per Ami's proposal.

Rules DROPPED from v6:

- Multi-Cultural & Cross-Regional Fusion (v6 §3) — contradicts homogeneity.
- Equal Genre Weight & Density (v6 §4) — v7 clusters are smaller and tighter.
- Direction Diversity & Non-Overlap (v6 §7, single ≤1 shared genre) — v7 allows overlap because downstream aggregates to a liked-genres list.
- "Regional Blends" bullet from v6 §1 — subsumed by same-cultural-register rule under `HOMOGENEITY_SECTION`.

Rules NEW for v7:

- `HOMOGENEITY_SECTION` (Cluster Homogeneity as Diagnostic Probe Design) — 5-axis rule (originally: same tempo band / energy tier / instrumentation family / cultural register / mood; tempo dropped 2026-09-23, now 4-axis). Includes explicit test: "if two genres in a cluster would appeal to meaningfully different listener profiles, split them into two directions."
- `DISTINCTNESS_SECTION` — 8 clusters must represent distinctly different musical archetypes (differ on at least two of the homogeneity axes). Explicit "overlapping genres across clusters are allowed" clause — sits at the intersection of two archetypes, ships in both, becomes stronger genre-level signal downstream.
- Title format simplified — "Clear Stylistic Identity" per Ami's brief, 3–6 words, no operational metadata (no "for peak hours", no time-of-day).
- Hebrew description reframed for a single-vibe cluster (not a "blend") — retains v6's vocabulary constraints (instruments limited to `פסנתר`, `סינתים`, `גיטרה`, or family names; forbidden vocabulary list).

Intro paragraph anchors the diagnostic-probe framing: "diagnostic taste probes… tightly-clustered musical directions… same tempo band, same energy tier, same instrumentation family, same cultural register, same mood… downstream the picked directions dissolve into a flat liked-genres list — overlapping genres across two liked directions become a stronger signal, not a bug." ("same tempo band" dropped 2026-09-23.)

Provider label for gemini_call_log: `v7-onboarding`. Separates R1 spend from R2's `v7-onboarding-refined`.

Output schema (as of 2026-09-23 authoring; `bpm_range` removed 2026-09-23):

```
{
  "directions": [
    {
      "rank": 1,
      "title_en": "English title, 3-6 words",
      "genres": ["...", "...", "..."],
      "description_he": "Hebrew description, 1-2 sentences, 10-25 words total",
      "bpm_range": {"min": 0, "max": 115},   // removed 2026-09-23
      "instrumentalness_preference": "none",
      "popularity_preference": "none"
    }
    // ... up to 8 directions
  ]
}
```

Ami's proposed R1 output shape (`business_summary_brief`, `excluded_genres_count`, `excluded_genres_reasoning`, `direction_id`, `direction_title`, `vibe_description`, no `bpm_range` / no `instrumentalness_preference` / no `popularity_preference`) was rejected — mostly AI hallucinations; matched v6 shape instead to keep downstream code compatible.

---

## 2026-09-23 — Shared genre universe extracted to `shared/genre-universe.js`

**Applies to:** `all v7` (setup) + cross-referenced in v6 history

The v7 R1 authoring depended on having a single source of truth for the genre list, otherwise v7 would be a fourth genre-list drift location. Extracted the canonical list into `shared/genre-universe.js` and pointed v6 + v5 + v6's genre-list.js at it.

New file: `shared/genre-universe.js` — exports `GENRES` (array of 116 canonical strings in the ordering v6 currently ships), `GENRE_SET` (Set of same), and `GENRE_UNIVERSE_SECTION` (the formatted string constant used as a prompt sub-section: intro paragraph + `GENRES.join(', ')`).

Refactored:

- `v6/generation/musical-directions.js` — removed inline `GENRE_UNIVERSE_SECTION`, added `import { GENRE_UNIVERSE_SECTION } from '../../shared/genre-universe.js'; export { GENRE_UNIVERSE_SECTION };`. Byte-identical output verified: `EDITABLE_PROMPT_SECTION.length` unchanged at 17,966.
- `v5/generation/musical-directions.js` — same import swap. Byte-identical mirror preserved.
- `v6/generation/genre-list.js` — reduced to `export { GENRES, GENRE_SET } from '../../shared/genre-universe.js'`. Array order shifts from thematic to alphabetical (source-of-truth ordering); file itself noted the order was cosmetic. Downstream consumer `api/v6/account/event-playlist.js` embeds `${GENRES.join(', ')}` in a Haiku prompt — order shift is a purely cosmetic change to that prompt's genre menu.
- CLAUDE.md's "THREE CODE LOCATIONS enumerate the genre universe today" invariant collapses to one shared file. v6's `direction-edit-chat-prompt.js` already imported `GENRE_UNIVERSE_SECTION` from `musical-directions.js`, so it transitively picks up the shared source now.

New verification helper: `scripts/_verify-genre-refactor.mjs` — compares the current in-tree `GENRE_UNIVERSE_SECTION` against git HEAD's inlined version (parsed out via regex from the git-show text) to catch any accidental drift. Kept in-tree for future genre-list edits.

v7 files subsequently created import from this same shared module.

---
