# v7 onboarding before the two decks (2026-09-23 → 2026-11-02)

> Reference for AI coding assistants and developers. Moved out of CLAUDE.md
> on 2026-11-03, unchanged in substance, to keep CLAUDE.md focused on the
> current onboarding.

From the v7 build (2026-09-23) until the 2026-11-02 deploy, v7's onboarding
swiped **one deck of 8 diagnostic probes** (Round 1), added **4 more** when the
owner liked fewer than 3 (Round 2), and built a **one-sided taste profile**.
Since 2026-11-02 it runs two decks, energetic then calm, and a two-sided
profile: see CLAUDE.md → § V7 ARCHITECTURE → "Two onboarding decks".

**Read this before** changing the old generators below, the walkthrough
scripts that still call them, or a prompt section of theirs that the deck
prompts import.

## What still uses this code

- **Prompt sections.** The deck prompts are built from these files' sections:
  - `deck-directions.js` imports R1's processing rules, homogeneity, pairing,
    output language, titles, Hebrew description, venue phrase, the "when not
    to return directions" rule and `injectPlaces` from `musical-directions.js`;
  - `taste-profile-decks.js` imports `taste-profile.js`'s core philosophy, hard
    boundaries, processing rules, deduction logic and genre naming rules, plus
    `canonicalGenreList` / `forceRequestedIntoApproved`;
  - the taste chat's prompt imports `taste-profile.js`'s core philosophy and
    hard boundaries.

  An edit to one of those sections changes the live onboarding (and the taste
  chat) too; record it in `prompt-history-v7.md` with every prompt it reaches.
- **The live walkthroughs** `scripts/_v7-walkthrough.mjs` and
  `scripts/_v7-phaseb-walkthrough.mjs` still generate with
  `generateMusicalDirections` + `generateTasteProfile`, so they don't exercise
  the decks.
- **`normalizeTasteProfile`** has its offline tests
  (`node --test scripts/test-taste-profile-normalize.mjs`).
- **Signed-up profiles.** Every profile created before the 2026-11-02 deploy
  came from this pipeline (`two_sided = false`, swipe cards without `deck`):
  6 in the database on 2026-11-02, all signed up after the 2026-10-24 purge.
  They keep working unchanged (checked 2026-11-02).

## The pipeline

```
description + business name + atmospheres + musical emphases + Google Places
       ↓
Stage 1: v7/generation/musical-directions.js (generateMusicalDirections)
         → 8 diagnostic probes (4+4 split, page 2 fires while owner interacts with page 1)
           + venue_phrase_he, a short phrase for the business ("המסעדה הסקסית") for the "הכל מוכן!" screen
         label='v7-onboarding'
       ↓
[owner swipes swipe-deck]
       ↓
Stage 2 (only if fewer than 3 R1 picks):
         v7/generation/refined-directions.js (generateRefinedMusicalDirections)
         + optional Round 2 refinement emphases textarea (per v6 pattern)
         → 4 refined probes mapping the neighbourhood of the liked probes
           (re-confirm a liked vector with fresh genres + adjacent archetypes
           that move 1–2 of its 4 axes); ranks 9–12
         label='v7-onboarding-refined'
       ↓
[owner swipes refined deck]
       ↓
Stage 3: v7/generation/taste-profile.js (generateTasteProfile)
         → full-catalog (142-genre) bucketing + per-user energy scale + carry-through prefs
         label='v7-taste-profile'
       ↓
["הכל מוכן!" → registration → payment → taste-profile bar → signup → "בדקו את המייל ✉️"]
```

Everything from "הכל מוכן!" on is unchanged; see CLAUDE.md.

## Ranks

R1 = 1–8 (page 1 = 1–4, page 2 = 5–8), R2 = **9–12** (`R2_RANK_START` in
`v7/generation/refined-directions.js`). The R2 and taste-profile prompts
reference LIKED/DISLIKED by rank, so `v7/app.js round1DirectionsSeen()` (removed
2026-11-02) passed page 1 **plus** every page-2 direction that was
liked/disliked (`state.directions` alone was page 1 only).
`state.round2Directions` held the R2 set so the taste-profile retry could
rebuild the same call.

Each card's song came from `/api/v7/anchor-tracks` → `v7_anchor_tracks` with
no energy range (the decks added `lo` / `hi` on 2026-11-02).

## The one-sided taste profile (`taste-profile.js`)

It ran once after R1 (+ R2) resolved, before signup, and extrapolated from up
to 12 probes across R1 + R2, per-direction like/dislike and per-track
super-likes. Its bucketing rules, hard boundaries, requested genres and
schema invariant are the ones CLAUDE.md describes under "The taste-profile
stage"; the two-sided generator shares them. What was different:

- **No sides.** One entry per genre; each genre's level was relative to the
  owner's whole range, wherever it was liked.
- **House floor included Organic House:** every House genre (Deep, Tech,
  Organic, Soulful, Afro, Jazz, Hip House) sat in the top two levels.
- **The groove floor applied to the whole scale:** the R&B family, Neo Soul,
  Acid Jazz, AfroBeats and the Funk family never sat in the bottom two levels
  (standard R&B could, when the top two were full of clearly more energetic
  genres).
- **Safety net:** if level 1 had no approved genre, `normalizeTasteProfile`
  shifted every level down and shrank N (never below 2). The two-sided
  normalizer still does this when the profile has no sides.

## Why the swipe deck got its own function (measured 2026-09-23)

`v5_anchor_tracks` picks its one track with `ORDER BY random() LIMIT 1` over
*every* track matching genre + tempo + popularity. `track_analyses` has a
tempo index, so its cost tracks the tempo window, not the genre: a `0–300` spec
cost ~2× a v6-style narrow window even for small genres. A 4-card v7 call
(~4.6s wall-clock) blew the anon role's 3s `statement_timeout` on 6/6 calls →
57014 → empty deck → forced into R2, which failed the same way. A service-key
workaround briefly shipped on 2026-09-23 and was replaced by `v7_anchor_tracks`
on 2026-09-24.

## Ami's prompt dashboard, steps 1–3 (2026-09-23 → 2026-11-02)

Since 2026-11-02 steps 1–3 run the deck prompts (CLAUDE.md → § AMI'S
DASHBOARD). Before that:

- **Step 1 — the R1 prompt.** The page imported `EDITABLE_PROMPT_SECTION` +
  `assembleSystemPrompt` from `/v7/generation/musical-directions.js` (from
  v5's copy until 2026-09-23) and let Ami edit + preview the v7 R1 prompt
  output before it went to prod. Ami tuned against v7's R1 prompt, NOT v6's;
  Roni explicitly said no v6/v7 toggle at the dashboard level.
- **Step 2 — swipe simulation** (2026-09-28; shown once step 1 returned
  directions): each direction got "אהבתי" / "לא בשבילי" (default לא בשבילי);
  clicking a genre chip super-liked it and marked its direction liked, and
  disliking a direction cleared its super-likes, the same rules as onboarding.
  Plus an optional Round 2 refinement emphases textarea, enabled only while
  fewer than 3 directions were liked (production's `picked.length < 3` Round 2
  trigger; when disabled its text stayed in the box but wasn't sent), and the
  two carried preferences (prefilled with the `carryPref` rule, overridable for
  testing).
- **Step 3 — taste-profile editor** (2026-09-28): `EDITABLE_PROMPT_SECTION`
  from `v7/generation/taste-profile.js`, assembled with that module's
  `assembleSystemPrompt`; the user message came from its exported
  `buildUserMessage` and the response went through its exported
  `normalizeTasteProfile`, so a dashboard run saw exactly what production
  would. Output: approved / conditional by energy level, the requested genres
  (titled "נתבקשו מפורשות ע"י סופר לייק או בדגשים המוזיקליים של הלקוח",
  super-likes included), the computed excluded list, a "DROPPED" line for
  genres the model listed but production would discard, and `reasoning_en`.
  Logged as `label='ami-taste-profile'`.
- **Round 2 was not simulated** (the taste profile got "Round 2 directions:
  (not fired)"). The business inputs used were the ones from the last step-1
  run; re-running step 1 reset the swipe simulation.
- **Removed 2026-09-28:** a "Popularity window" derived from the checked
  atmospheres (v5's `derivePopularityWindow`). It was display-only and
  misleading, since production dropped atmosphere-derived popularity on
  2026-09-02.
