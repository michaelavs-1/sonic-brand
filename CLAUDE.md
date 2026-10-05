# Rubin · SonicBrands — AI Context Document

> Optimized for Claude and other AI coding assistants.
> Read this entire file before touching any code.

## ⚠️ READ FIRST — VERSION LANDSCAPE

The codebase contains multiple parallel "versions" that coexist. **v7 is the current active version** — it's what the user is iterating on. Since 2026-09-28 the site root (`/`) serves **v7** (deployed — see the rewrite note under Live URLs); v6 is still reachable at `/v6` but has no accounts. Others are kept but see the notes:

| Version | State | Where |
|---|---|---|
| v6 | **Reachable at `/v6` only — the root moved to v7 on 2026-09-28 — and NO v6 accounts exist** (all deleted 2026-09-24); its daily cron is hard-disabled. Signups at `/v6` would still create v6 accounts, which get no daily playlists. Michael's v4 UI shell + our v5 pipeline (Claude musical directions). Its code (`api/v6/*`, `v6/generation/*`) is still heavily reused by v7. Full v6 docs: [docs/v6-reference.md](docs/v6-reference.md). | `v6/`, `api/v6/` |
| **v7** | **Current active version. Runtime built + live-verified (2026-09-23).** Full parallel onboarding→signup→account→daily-cron runtime under `/v7`, separate from v6, and served at the site root (`/`) since 2026-09-28. Reframes onboarding directions as diagnostic taste PROBES that dissolve into a flat 124-genre bucketed taste profile at signup. Signup fires AFTER the payment step — a real Hyp payment (₪200/month subscription) is built and switched on per environment by `V7_PAYMENTS_ENABLED` — on in Development, **off in Production** (the step there is the old placeholder) (see "Payment (Hyp)" in § V7 ARCHITECTURE). The owner enters the account only via the emailed magic link (email verification required, like v6). Daily playlists via two delivery modes (Option 1 / Option 2). v7's daily cron is now the ONLY scheduled daily builder — v6's is shut off. Ami still tunes the R1 prompt via the Ami dashboard. See § V7 ARCHITECTURE and § OPEN QUESTIONS FOR V7 PIPELINE BUILD. | `v7/`, `api/v7/`, `api/cron/v7-generate-daily.js`, `shared/`, `prompt-history-v7.md` |
| v5 | Reference. `/api/v5/*` endpoints are still called by v6 (`anthropic`, `anchor-tracks`, `direction-tracks`, `databox-atmospheres`, `prewarm`, `record-playlist`). The `v5/` frontend still runs standalone. `v5/ami-prompt-dashboard/` lives here but as of 2026-09-23 imports from `v7/generation/musical-directions.js`. | `v5/`, `api/v5/` |
| v4 | Michael's fork. A snapshot lives at `michael-v4-snapshot/` (gitignored, used as UI reference for v6). Our own `v4/` also exists — has the Ami dashboard and precompute infra. | `v4/`, `api/v4/`, `michael-v4-snapshot/` |
| v3, v2 | Historical. Legacy pipelines. Broken in places (dead Spotify endpoints — see deprecations below). | `v3/`, `v2/` |

**Brand rename:** old name "Robin" still appears throughout; new name is "Rubin". Use "Rubin" in new code.

**Spotify API deprecations** still apply. Michael's app keeps grandfathered access to `GET /playlists/{id}/tracks` — this is why `api/new/spotify.js` uses Michael's app for Client Credentials reads and Rubin's app only for user-context writes.

---

## WHAT IS THIS

AI-powered Spotify playlist builder for physical businesses (cafés, bars, restaurants, stores). A business owner describes their venue, picks atmospheres, sets opening hours, swipes through preview tracks, and gets a set of playlists — one per selected "musical direction" — that will eventually cover their full opening day (~7 hours of music).

**Live URLs:**
- https://robin-music.com — **custom domain, DNS points at this Vercel project**. Primary user-facing URL.
- https://sonic-brand.vercel.app — Vercel's assigned alias for the same deploy. Kept as a backup identity.
- Both hostnames serve the same deploy. The root is a rewrite in `vercel.json` (not a Vercel-dashboard setting): **`"/" → "/v7/index.html"` since 2026-09-28** (was `/v6/index.html` from 2026-08-20), so either URL at the root lands on the v7 onboarding. v7's page only uses absolute `/v7/...` paths, so it works served at `/`; its own navigations still go to `/v7/...` URLs (account, logout → `/v7?intro=1`, restart → `/v7/?reset=1`), which is fine. v6 stays reachable at `/v6`. The legacy root `index.html` (v3 landing) was deleted on 2026-08-20; static-file precedence would otherwise beat the rewrite.
- Origin guard + magic-link redirect allowlist covers both plus this project's Vercel preview URLs (`sonic-brand-*.vercel.app`).

**Repo:** https://github.com/michaelavs-1/sonic-brand
**Owner:** Michael Avshalom (avshalom.michael@gmail.com)
**Developer:** Roni Mark (roni.mark@gmail.com)

---

## V6 (REFERENCE — SEE docs/v6-reference.md)

v6 is reachable at `/v6` but has no accounts and no daily cron (see the version table). Its documentation moved to **[docs/v6-reference.md](docs/v6-reference.md)** on 2026-10-03, unchanged, to keep this file focused on v7. It covers:
- the v6 onboarding pipeline, account dashboard, direction-edit chat, Profile tab and signup;
- v6-only mechanisms: the onboarding state machine, prefetching, the progressive swipe deck, the scrubbable playback bar, the v6 musical-directions and Round 2 prompts, and the v6 daily cron;
- the legacy `auth.users.raw_user_meta_data.sonic` blob, the `v6/` file subtree, and the 2026-08-01 / 2026-08-02 session summaries.

**Read it before changing:**
- anything under `v6/`;
- a v7 file forked from v6: `v7/preview.js` (swipe deck, progressive rendering, playback bar), `v7/account/app.js`, or the dormant `v7/account/direction-chat.js`;
- a v6 endpoint v7 still calls. These are `update-business-name` and `log-playlist-open` under `/api/v6/account/`, the Gemini proxy `api/v6/gemini.js`, and v6's `_daily-builder.js` / `_expire-playlist.js` helpers. (Since 2026-10-03 v7's special playlists use their own `/api/v7/account/*` endpoints, not v6's event endpoints.)

### Special event playlists

- **v6:** [docs/v6-reference.md](docs/v6-reference.md) → "Special event playlists (v6 account)".
- **v7** has its own flow since 2026-10-03: § V7 ARCHITECTURE → "v7 special playlists".

---

## V7 ARCHITECTURE (runtime built + live-verified 2026-09-23)

v7 is a full parallel runtime under `/v7` (onboarding UI, account UI, API endpoints, signup, taste-profile bucketing, two daily-playlist delivery modes, and its own daily cron). It was built and live-end-to-end-verified on 2026-09-23 against `vercel dev` → prod Supabase. v6 is untouched and reachable at `/v6`; v7 is reached at `/v7` and, since 2026-09-28, at the site root `/`. The version split is enforced by `businesses.version` ('v6' default, 'v7' stamped at v7 signup): v6's daily cron is now shut off and v7's targets only `version='v7'` businesses (see § VERCEL DEPLOYMENT and the v7 cron mechanism). Ami still tunes the R1 prompt via the Ami dashboard (imports v7's prompt + ai-provider since 2026-09-23). A short list of intentionally-deferred decisions remains — see § OPEN QUESTIONS FOR V7 PIPELINE BUILD.

### Design shift from v6

- **v6 directions were curated blends.** Each picked direction became the seed for a real playlist post-signup. Multi-Cultural Fusion and Cross-Regional blends were actively encouraged within a direction. Rules like Jazz Isolation and House Containment framed pairings as "can blend with X" — an appropriate framing for the diverse-playlist world.
- **v7 directions are diagnostic PROBES.** Each is a small cluster of near-identical genres (same energy tier / instrumentation family / cultural register / mood — 4 axes; no tempo axis after 2026-09-23). Liking or disliking one representative track flags the whole cluster as one taste vector. Downstream, the picked directions DISSOLVE into a flat liked-genres list — playlists are built off that list, NOT per-direction. Overlapping genres across two liked directions become a stronger genre-level signal, not a duplicate.
- **Rules rewritten for the shift.** `BEAT_PERCUSSION_RULE` was rewritten as a "Groove-Family Disambiguation" that explicitly splits RnB / Funk / Neo Soul / Hip Hop / Trap-Drill into five disjoint tight-cluster families (v6's version listed those first four in a single example set, which the model read as a single-cluster license — barbershop-bug root cause). `JAZZ_ISOLATION_RULE` was simplified to remove the explicit "Ethio-Jazz and Acid Jazz can blend with Afro/Funk/R&B styles" clause. `MULTI_CULTURAL_RULE` (v6 §3) and `EQUAL_GENRE_WEIGHT_RULE` (v6 §4) were dropped entirely. New sections `HOMOGENEITY_SECTION` and `DISTINCTNESS_SECTION` codify the tight-cluster / 8-distinct-archetypes design.
- **Ami's R1 rewrite (2026-09-30), carried into R2.** Details in `prompt-history-v7.md`.
  - **Requested styles:** each style the owner asks for gets ONE direction, and the rest map what else they like. In R2 it gets one of the 4 clusters again, with different companion genres than its R1 direction.
  - **Variety:** the widest variety the business allows *between* directions, never within one.
  - **Descriptions:** `description_he` is the sound, then a sentence starting with "בודק…" (always masculine: the direction is the subject), 15–30 words. Owners see it on the swipe card.
  - **Google Places rule:** it now sits at the end of `### Processing Rules:` (`injectPlaces`). Until then it landed under Direction Distinctness in R1 and under Homogeneity in R2.

### The three v7 prompt stages

Onboarding pipeline (BUILT — orchestrated by `v7/app.js`):

```
description + business name + atmospheres + musical emphases + Google Places
       ↓
Stage 1: v7/generation/musical-directions.js
         → 8 diagnostic probes (4+4 split, page 2 fires while owner interacts with page 1)
         label='v7-onboarding'
       ↓
[owner swipes swipe-deck]
       ↓
Stage 2 (only if fewer than 3 R1 picks):
         v7/generation/refined-directions.js
         + optional Round 2 refinement emphases textarea (per v6 pattern)
         → 4 refined probes mapping the neighbourhood of the liked probes
           (re-confirm a liked vector with fresh genres + adjacent archetypes
           that move 1–2 of its 4 axes); ranks 9–12
         label='v7-onboarding-refined'
       ↓
[owner swipes refined deck]
       ↓
Stage 3: v7/generation/taste-profile.js
         → full-catalog (124-genre) bucketing + per-user energy scale + carry-through prefs
         label='v7-taste-profile'
       ↓
[registration (email + password; a registered email is stopped here) → payment (Hyp iframe; placeholder while
  payments are switched off) → taste-profile bar
  → signup (api/v7/account/signup.js: account with the password + taste profile saved + magic link emailed)
  → "בדקו את המייל ✉️"]
       ↓
[owner clicks the emailed magic link (= email verification, logs them in) → /v7/account → first-login delivery-mode gate]
[later visits: email + password on /v7/account; "שכחתי סיסמה" → reset link → new password]
       ↓
Daily v7 playlist builder (BUILT — Option 1 / Option 2, see § v7 daily runtime below)
```

### The taste-profile stage (new for v7)

Runs once after R1+R2 resolve, before any playlist is built. Extrapolates from the sparse swipe-deck signal (up to 12 probes across R1+R2 + per-direction like/dislike + per-track super-likes) to a full-catalog taste profile.

Output shape (after `normalizeTasteProfile` — the model itself does NOT emit `excluded_genres`, see below):

```json
{
  "energy_levels_total": 4,
  "approved_genres": [
    {"genre": "Hip Hop", "energy_level": 4},
    {"genre": "Neo Soul", "energy_level": 2}
  ],
  "conditional_genres": [
    {"genre": "Trap", "energy_level": 4, "note_en": "..."}
  ],
  "excluded_genres": ["Chamber music", "Medieval Music"],   // computed in code
  "requested_genres": ["Hip Hop"],                          // super-liked + named in the emphases; always approved
  "instrumentalness_preference": "none",
  "popularity_preference": "none",
  "reasoning_en": "..."
}
```

Bucketing rules (in the prompt). Since 2026-09-30 the prompt approves **as many genres as the owner would genuinely enjoy** (Ami's "maximalist expansion"; history in `prompt-history-v7.md`):
- **approved** — any of:
  - a genre in a liked direction, a super-liked genre, or one requested in emphases;
  - a tight-cluster neighbour of one (all 4 axes, or 2–3 axes if the owner would enjoy it);
  - a "cross-pattern" genre that bridges two things the owner liked (e.g. LoFi Bossa + R&B/jazz → LoFi Beats, JazzHop).
- **Hard boundaries on inferred genres:**
  - electronic genres only if the owner liked an identical or adjacent electronic genre;
  - classical / spa only if presented in the probes and liked;
  - never expand into genres that clash with the venue (the Venue Context Cutoff stops EXPANSION only — the owner's own choices are never cut).
- **conditional** — a less-certain neighbour or bridge; OR mixed signals; OR untouched with no signal. **DATA ONLY in v7's initial cut** — first playlist builder ignores this bucket. Kept because the signal is real and the model is already reasoning over the full catalog.
- **excluded** — appears only in disliked directions with no positive counterweight; OR explicitly banned in emphases; OR Japanese Folk restriction triggers. The model expresses this by LEAVING THE GENRE OUT of both lists (since 2026-09-24 — saves ~500 output tokens per onboarding vs. having it re-list ~70 genres).

Energy calibration:
- `energy_levels_total` is DYNAMIC per user (2..6). Narrow spread of taste → N=2. Very wide spread (chamber music AND dubstep both in the profile) → N=6. Prefer the smallest N that meaningfully distinguishes operational contexts.
- Each approved/conditional genre gets an `energy_level` 1..N. **RELATIVE to the user's own range**, not absolute. Hip Hop is level N for a mostly-chill user; level 3 for a rave user who also picked Dubstep. Same-energy genres get the same level.
- Excluded genres get no level.
- **Groove floor (2026-09-30):** the R&B family, Neo Soul, Acid Jazz, AfroBeats and the Funk family sit above the owner's calmer APPROVED genres. They take level 1 only when there's no calmer approved genre, so the lowest level is never empty.
  - **Safety net:** if the model still leaves level 1 without an approved genre, `normalizeTasteProfile` shifts every level down and shrinks N (never below 2). This keeps Option 1's calm tier from coming out empty.
  - Tests: `node --test scripts/test-taste-profile-normalize.mjs`.

Hard schema invariant: every one of the 124 canonical genres must land in EXACTLY ONE bucket. `normalizeTasteProfile` in `v7/generation/taste-profile.js` guarantees this by construction — `excluded_genres` = every canonical genre not in approved or conditional (any `excluded_genres` the model sends anyway is ignored); approved wins over conditional on duplicates; case drift is canonicalised via a lowercase→canonical map; invented genres (e.g. "Slow Funk") are dropped; energy levels clamped to `[1..N]`.

**Requested genres (Ami, 2026-10-05).** `requested_genres` = the genres the owner asked for explicitly:
- **Sources:** every super-liked genre (added in code, from the swipe deck's list) + every genre named in the musical emphases or Round 2 text (listed by the model, rule `REQUESTED_GENRES_RULE`). Exact genres: "R&B" → `Rnb`, not `French RnB`.
- **Always approved:** `normalizeTasteProfile` forces each one in — out of conditional with its level there, or at the middle of the scale if the model left it out of both lists.
- **Used by Option 1 only:** each one is in every playlist of its energy tier, every day (see "Daily draw" below). Option 2 ignores them.
- **Stored** with the super-liked genres and the Round 2 text (migration `2026-10-05-v7-requested-genres.sql`). Accounts from before 2026-10-05: `scripts/_v7-backfill-requested-genres.mjs` reconstructs them (see its header).

**No Places injection at this stage.** Google Places was already baked into R1/R2 when the model built the probes the user swiped on.
- The taste profile was originally designed as a property of the USER only.
- Since 2026-09-30, the venue does cut INFERRED genres (Ami's Venue Context Cutoff), using the description + atmospheres already in the user message.

### Prompt stack

All five v7 prompts (R1, R2, taste profile, Option-1 energy directions, Option-2 level directions) route through **`v7/generation/ai-provider.js`** — same shape as v6's (`PROVIDER='gemini' | 'anthropic'`, model `gemini-3.6-flash`, thinking `high`) but INDEPENDENT. Flipping v6's PROVIDER doesn't touch v7. Ami's dashboard (which imports from v7's ai-provider since 2026-09-23) follows v7's switch.

`gemini_call_log.label` values in use:
- v6: `onboarding` (R1), `onboarding-refined` (R2), plus post-signup labels for event chat / direction-edit chat / preview-direction.
- v7: `v7-onboarding` (R1), `v7-onboarding-refined` (R2), `v7-taste-profile`, `v7-energy-directions` (Option-1 energy-tier generation at the delivery-mode gate), `v7-level-directions` (Option-2 per-level libraries, when Option 2 is chosen and the stored library doesn't fit the profile; the 2026-09-28 test runs used `v7-level-directions-test`), `v7-event-chat` + `v7-event-playlist` (special playlists, since 2026-10-03; both called server-side).

Admin API `/api/internal/gemini-spend`'s `by_label[]` breaks these out separately, so v7 spend is trackable from day one of runtime.

### v7 does NOT emit `bpm_range`

Removed 2026-09-23. v7's homogeneity axes (energy / instrumentation / register / mood) don't include tempo. The `validateBpmRange` function was deleted from both v7 files; `validateDirection` no longer checks BPM. Downstream:
- **Swipe deck → its own RPC, no tempo at all.** v7's preview (R1, R2 and the swap button) calls `/api/v7/anchor-tracks` → **`v7_anchor_tracks(p_specs)`** (migration `v5/precompute/migrations/2026-09-24-v7-anchor-tracks.sql`, **RUN 2026-09-24**). Specs are `{rank, genre, inst_pref, pop_pref}`. Per spec it samples 8 random playlists tagged with the genre, takes their tracks, applies the inst/pop filters and biases, and picks one at random; a second tier re-samples 200 playlists only for specs the first tier couldn't satisfy. Work is bounded by the sample, so it's fast regardless of genre, and it runs on the normal **anon** key like v6's endpoint. v6's `v5_anchor_tracks` + `/api/v5/anchor-tracks` are untouched and still v6-only.
- **Daily builders still pass `0–300`.** `api/v7/account/_daily-builder.js` reuses v6's `v6_direction_tracks_recent`, which REQUIRES `bpm_lo`/`bpm_hi` (NULLs would make `tempo BETWEEN NULL AND NULL` drop every row), so v7 directions carry `bpm_range:{min:0,max:300}` as a no-op tempo filter. That runs server-side on the service key, so it isn't subject to the anon 3s limit.

**Why the swipe deck needed its own function (measured 2026-09-23).** `v5_anchor_tracks` picks its one track with `ORDER BY random() LIMIT 1` over *every* track matching genre + tempo + popularity. `track_analyses` has a tempo index, so its cost tracks the tempo window, not the genre: a `0–300` spec cost ~2× a v6-style narrow window even for small genres. A 4-card v7 call (~4.6s wall-clock) blew the anon role's 3s `statement_timeout` on 6/6 calls → 57014 → empty deck → forced into R2, which failed the same way. A service-key workaround briefly shipped on 2026-09-23 and was replaced by `v7_anchor_tracks` on 2026-09-24.

### v7 persists a taste profile, NOT `business_directions`

v7 does NOT write `business_directions` (v6's per-direction table). Instead, signup persists the flat taste profile to **`business_taste_profiles`**, the chosen delivery mode to **`business_v7_settings`**, and (Option 1 only) energy-tiered directions to **`business_v7_directions`** — three new tables (see DATA MODEL). Consequences: v6's daily-gen cron, direction-edit chat, and admin API all read `business_directions` and see nothing for v7 businesses — which is correct (v6's cron is shut off; v7 has its own cron; the Home tab's "חידודים מוזיקליים" direction-chat ships dormant for v7). The admin API's v7 view is a future item.

### v7 daily runtime (Option 1 / Option 2) — BUILT

After signup, `/v7/account` shows a first-login **delivery-mode gate**, labelled "סוג פלייליסטים יומיים" in the UI (`set-delivery-mode.js` writes `business_v7_settings.delivery_mode` + `updated_at`). **As soon as the owner picks a type in the gate, the dashboard builds TODAY's set** (`checkV7ModeGate` returns true → `runGenerateDaily` → `api/v7/account/generate-daily.js`; expires 2h after today's close, or next 04:00 IL on a closed day / after closing). From tomorrow the v7 cron builds. Two duplicate guards: the cron skips a business as `mode-just-set` (silent) for 15 min after `updated_at`, so it can't race the in-flight first build; and the endpoint returns 409 if a live daily set already exists for the current business day (IL, overnight-aware) or another build for the business is running. If the first build fails entirely, the next cron tick builds.
- **Option 1 — 4 playlists/day.** On selecting option1, a **library of energy-tiered directions** — as many as the genres support, up to 30, no minimum — is generated (`v7/generation/energy-directions.js`, `label='v7-energy-directions'`, since 2026-09-28) and stored in `business_v7_directions`.
  - **Each direction** is a curated, internally coherent blend in the style of the v6 onboarding directions: 4–6 genres, following v6's energy / jazz / cross-cultural / pop / house pairing rules (copied into the prompt, not imported). It sits wholly in the HIGH or the LOW tier.
  - **Requested genres** (since 2026-10-05) are in every direction of their tier, overriding those pairing rules; the rest of each direction varies. The normalizer adds any the model leaves out.
  - **Across the library,** directions sound different from one another, and genres may repeat across directions without limit.
  - **Tier sizes:** tiers are sized roughly in proportion to their approved genres, with at least 2 per tier. A tier with few genres gets fewer directions, never padding. Measured on the 6 Option-1 accounts (2026-09-28 regeneration): 6 approved genres → 9 directions, 14 → 12, 19 → 16, 27 → 17, 32 → 19, 40 → 19; 19–52s in the browser.
  - **Normalizer:** drops genres that aren't approved or sit in the other tier, drops repeated genre sets, and caps the library at 30 (so does `save-energy-directions.js`).
  - **Before 2026-09-28** this step made 4–7 tight probe-style clusters. Every Option-1 account was regenerated with the new prompt on 2026-09-28 by `scripts/_v7-regenerate-energy-directions.mjs`. Rerun it after future prompt changes: it's a dry run by default, `--confirm` applies it, and it needs `vercel dev`. A failed generation keeps the old set.
  - **While it builds** (first-login gate + Profile Option 2 → 1) the owner sees "מכינים את הכיוונים המוזיקליים…" plus "עלול לארוך עד דקה וחצי, נא לא לסגור את החלון…" (`ENERGY_BUILD_WAIT_NOTE` in `v7/account/app.js`, and in `#v7ModeBuilding` in `v7/account/index.html`).
  - **Daily draw:** each day the builder fills 4 fixed names, 2 per tier, one direction per playlist (`pickTierPair` in `v7/generation/option1-draw.js`, shared with Ami's dashboard; tests `node --test scripts/test-option1-draw.mjs`). Since 2026-10-05 (Ami): the first direction is **random**, the second is the one with the **fewest genres in common** with it (ties at random; genres every direction of the tier shares don't count). The tier's requested genres are added to both playlists if their direction lacks them (`withRequested`), so the rule also holds for libraries built before it. A pool of 1 is used twice, and the second playlist still gets different tracks via same-day history. The tracks also vary day to day (random draw + 7-day dedup). **Owner-facing names are fixed** (since 2026-09-24): "אנרגיה גבוהה #1/#2" and "אנרגיה רגועה #1/#2", derived at build time from `energy_tier` + position within the tier (`tierPlaylistName` in `api/v7/account/_daily-builder.js`) — used for the dashboard label (`business_playlists.label`) and the Spotify playlist title/description. **Both options' names carry the date** (since 2026-09-28): the dashboard label is "<name> · dd.mm.yyyy" with the venue's business-day date (`datedLabel` in `v7/generation/playlist-length.js`; "replace now" matches names without it via `undatedLabel`), and the Spotify name was already "<business> · <name> · dd.mm.yyyy" (v6's `playlistName`). Gemini's `business_v7_directions.title_en` (e.g. "Smooth Jazz Lounge") is kept as an internal descriptor only and never shown to owners. Tiers are RELATIVE to the owner's own energy scale (high = upper half of their `energy_levels_total`), so a calm-jazz owner's "אנרגיה גבוהה" can be smooth jazz. **Length** (since 2026-09-24): each of the 4 playlists is sized to half of today's opening minutes + 90 min, at the assumed 3.5 min/track (`buildOption1Batch`; e.g. 09:00–21:00 → (360+90)/3.5 = 129 tracks). Count-based, so real playing time runs ~19% long — measured catalog average is 4.16 min/track (3k-row sample of `track_analyses.raw_analysis->>'duration'`, 2026-09-24). Becomes exact once builders fill by duration.
- **Option 2 — 2 mixes/day whose energy follows the owner's timeline (BUILT 2026-09-24).** Named **"Daily Mix #1"** and **"Daily Mix #2"**. Since 2026-09-28 each energy level plays from a **library of per-level directions**, one direction per mix per day, rotating daily. See "Option 2: energy timeline" and "Option 2: level directions" below.

#### Option 2: energy timeline

The owner draws the day's energy as a curve through draggable dots (the editor approved in the `/v7/test-timeline` sandbox). Decisions (Roni, 2026-09-24):
- **One timeline per hours group** — days with identical opening hours share one; the editor shows a tab per group ("א׳–ה׳ · 09:00–17:00"). Closed days have none. **Opening on the LEFT.** Dots: 5 to start, 2–12, move freely (energy continuous, time snaps to the clock's :00/:30 + exact opening/closing, two dots never share a time); "+" adds one; drag onto the trash (visible only while a dot is held) deletes. Grid rows = the taste profile's `energy_levels_total` (never shown to the owner).
- **Where:** one modal (`#timelineModal`, `openTimelineModal` in `v7/account/app.js`) — first-login gate (choosing Option 2 opens it; "חזרה" returns to the gate; saving = choosing Option 2), Profile tab "עריכת ציר האנרגיה" (button carries a mini preview of today's curve), and Profile Option 1 → 2 (**mandatory** — the type only switches on save; cancel keeps Option 1).
- **Opening hours edited → the timeline updates in the same request, keeping clock times** (`api/v7/account/update-hours.js`, v7's own copy of v6's endpoint): dots stay at their hours, a dot on the old opening/closing moves to the new one, out-of-hours dots are dropped (≥ 2 kept), a day that gets its own hours copies its old group's curve, merged groups prefer the one whose hours didn't change. No replace question on an hours change.
- **Replace question:** after a timeline save or a type switch (1→2 or 2→1 — on 2→1 it's asked right after the switch is saved, BEFORE the ~1-minute energy-directions build; a "now" answer rebuilds once the directions exist) in the Profile tab, if today has live daily playlists and the venue hasn't closed yet (right up to closing time), step 2 of the modal asks v6's "להחליף את הפלייליסטים של היום עכשיו, או להשאיר את הקיימים עד סגירה?". **"החליפו עכשיו"** → Home tab + `runGenerateDaily({replaceToday:true})`: the new set **starts at the current time** and runs to closing + 30; each old playlist leaves the dashboard as its replacement lands (`business_playlists.expires_at = now` only — the ledger keeps the original close + 2h so a phone still playing it isn't cut off at the next :30 sweep). **Cap: 2 replacements per business day**, visible in the question ("נותרה החלפה אחת להיום"; at the cap the button is disabled with "הגעתם למקסימום של 2 החלפות ביום — השינוי ייכנס לתוקף מחר"). Counted as `business_settings_changes` rows `field='daily_playlists_replaced'` (written only once something actually built). One build at a time per business (Upstash lock, `_build-lock.js` → 409 `build-in-progress`).
- **Builder** (`api/v7/account/_option2-builder.js`): window = `businessWindowAt` (IL + overnight-aware) → **start = max(now, opening)** (any build after opening — first login mid-day, late cron, "צור פלייליסטים", replace — starts at the build time), **end = closing + 30 min** (energy after closing = closing value). Closed day / after closing on demand ("המקום פתוח?"): the main group's curve (most days) stretched over now → now + 12h, expiring next 04:00. Level at any moment = the grid row the curve is in (`min(N, 1+floor(e·N))`); a level with no approved genres falls back to the nearest one. Pool: `v7_timeline_pool` RPC (random playlists per genre → tracks with `duration_sec`, 7-day no-repeat across the whole business, wider sample for short genres, recently-served refill for short levels). Assembly (`v7/generation/timeline-assembler.js`, pure, seeded): tracks end to end **by duration**, **each track's genre drawn at random** from the genres that mix plays at that level (that day's direction — see "Option 2: level directions" below), weighted by how many unused tracks each has left, the way Option 1 mixes a direction's genres. The 3–5-song "genre runs" rule (2026-09-24) was removed on 2026-09-28, two mixes never share a track. Rows carry `expansion.v7_timeline` (window, dots, per-track start minute / level / run genre, seed) + the usual `track_genres`. History key `'v7-option2'`. Falls back to the naive `planOption2` if the RPC isn't deployed.
- **Storage:** `business_v7_settings.timeline` = `{ version: 2, groups: [{ days, open, close, points: [{ m, e }] }] }` — `m` = clock minutes from midnight of the opening day (overnight > 1440), `e` 0..1. Always normalised against the current hours (`reconcileTimeline`). Timeline saves don't touch `updated_at` (the cron's `mode-just-set` skip means "mode changed").
- **Model** (`v7/generation/energy-timeline.js`, browser + server): hours groups, slots, curve (Fritsch–Carlson monotone cubic, verbatim from the sandbox), levels, reconciliation, `businessWindowAt`. Offline tests: `node --test scripts/test-energy-timeline.mjs`. Read-only plan preview: `node scripts/_v7-option2-dryrun.mjs [businessId] [--at=HH:MM]`. Live E2E (real Spotify, Roni runs): `scripts/_v7-option2-walkthrough.mjs`.
- **Loading placeholders:** the dashboard draws today's cards with their final names the moment a build starts (`expectedDailySlots` in `v7/account/app.js` — names are fixed per type); the server's `plan` line then takes over.
- **TEMPORARY testing log (Ami, 2026-09-24):** `DEBUG_TASTE_LOG` in `v7/account/app.js` prints the account's taste profile (genres by energy level), Option-1 directions / Option-2 timeline, the Option-2 level-direction library (whether it still fits the profile, and today's pick per mix), and today's playlists (Option 2: each mix's directions + consecutive level/genre stretches) to the browser console on every dashboard load. Turn off / delete when testing ends.
- **Needs migration `v5/precompute/migrations/2026-09-24-v7-timeline-pool.sql`** (track_analyses.duration_sec + trigger + backfill, and the pool RPC).

#### Option 2: level directions (2026-09-28)

Before this, every energy level of a mix played from ALL of that level's approved genres. Now:

- **The library.** For each energy level, Gemini builds a library of directions made only from that level's genres (`v7/generation/level-directions.js`, `label='v7-level-directions'`, stored in `business_v7_level_directions`).
  - Each direction is a coherent blend, following the same pairing rules as Option 1.
  - **No forced pairings** (Roni): a genre with no natural partner in its level gets a direction of its own.
  - **No target count:** the model builds as many as the genres support. Measured on all 10 v7 profiles: about 1 direction per 2–3 genres (1 genre → 1, 2 → 2–3, 3–7 → 2–4, 8–14 → 3–6, 19 → 7), 5–24 per business, 20–50s.
  - At least 2 directions per level with 2+ genres; `MAX_PER_LEVEL` 10 is only a safety ceiling.
- **Daily rotation** (`pickLevelDirections` in `v7/generation/timeline-assembler.js`). With K directions at a level and d = the business day's date as a day number:
  - Mix #1 plays `dirs[d mod K]` and Mix #2 plays `dirs[(d + floor(K/2)) mod K]`.
  - Each mix moves to the next direction every day and goes through all K before repeating.
  - The mixes differ whenever K ≥ 2; K = 1 → both play the same one. With K ≥ 4, nothing from yesterday plays in either mix.
  - Computed from the date alone (no stored state), so a same-day rebuild ("החליפו עכשיו") keeps the day's directions.
- **Builder** (`_option2-builder.js`):
  - `levelLibrary` keeps only genres still approved at that level; a level with genres but no stored direction plays its genres as one implicit direction.
  - Pool sizing (`estimateDemandPerMix`) and assembly are per mix, and each track's genre is drawn at random from the day's direction for that level (no genre runs).
  - Each row's `expansion.v7_timeline` carries `source` ('level-directions' | 'level-genres'), `day_number` and `directions` (`{level: {id, title_en, genres}}` for that mix).
  - **No library** (never generated, generation failed, migration not run) → the old behaviour, every genre of the level. Option 2 never gets stuck.
- **When it's generated:**
  - When Option 2 is chosen: the first-login gate after the timeline save (the gate's "מכינים את הכיוונים המוזיקליים…" line), and the Profile switch from Option 1 (after the timeline modal, before any "replace now" build).
  - **Kept across type switches:** each row stores `profile_key` (`levelProfileKey`, a hash of N + every approved genre with its level). `ensureLevelDirections` in `v7/account/app.js` reuses the stored library with no Gemini call while the key matches the live profile, and regenerates only when a genre was added, removed or moved to another level.
  - Timeline edits never touch it.
  - **On failure:** the Profile tab says "הכיוונים המוזיקליים לא הוכנו" and a click on Option 2 retries just this step.
- **Saving:** `api/v7/account/save-level-directions.js` replaces the set, re-checks the genres against the stored profile, and stamps `profile_key`.
- **Existing accounts:** `scripts/_v7-regenerate-level-directions.mjs`:
  - With no flag, lists.
  - `--generate [--all]` prints per-level results with no writes.
  - `--confirm` replaces the libraries of Option-2 businesses.
  - Needs `vercel dev`.
- **Tools:**
  - `node scripts/_v7-option2-dryrun.mjs <biz> --date=YYYY-MM-DD` shows each mix's direction per level on any day.
  - Offline tests: `node --test scripts/test-energy-timeline.mjs`.
- **Needs migration `v5/precompute/migrations/2026-09-28-v7-level-directions.sql`.**

Option 1 is planned by **`api/v7/account/_daily-builder.js`** `planOption1` (Option 2 by `_option2-builder.js`, above; `planOption2` there is only the naive fallback) — directions, per-playlist target, expiry — and built either by `buildOption1Batch` (the cron: plan + `buildBatch`, a v7 copy of v6's `buildDailyBatch` that also writes the per-track genre record — v6's function is untouched) or by the owner-triggered **`api/v7/account/generate-daily.js`** (the dashboard's "צור פלייליסטים" / "המקום פתוח?" links: same plan with `onDemand:true`, then v6 `buildOneDailyPlaylist` per playlist, streaming v6's ndjson contract with `slot-N` keys). `onDemand` sizes a closed/unknown day as `CLOSED_DAY_MINUTES` and never hands out an already-passed expiry (falls back to next 04:00 IL); the cron path is unchanged. Everything reuses v6's `_daily-builder.js` primitives (`buildDailyBatch`, `fetchTracksWithHistory`, ledger + history + insert). v7 directions carry `bpm_range:{min:0,max:300}` and **`id:null`** — `business_playlists.direction_id` is an FK to v6's `business_directions`, so passing a `business_v7_directions` id would violate it. The daily cron is **`api/cron/v7-generate-daily.js`** (see § VERCEL DEPLOYMENT). Spotify resilience + alerts are inherited unchanged: v7's build path flows through the version-agnostic `api/new/spotify.js` proxy.

### v7 special playlists — "צריכים משהו אחר היום?" (2026-10-03)

The Home tab's chat makes a one-off playlist for something happening **today**. Roni's framing: "tell us which special playlist you need right now". Until 2026-10-03 v7 ran v6's flow (a card per event, kept forever, built on a second click), described in docs/v6-reference.md and unchanged for v6.

- **Flow.**
  1. The owner chats (`api/v7/account/event-chat.js`, prompt `v7/generation/event-chat-prompt.js`).
  2. A reply with `state:'confirming'` + `proposed {name_he, description_he, genre_source}` shows "הכן פלייליסט".
  3. `save-event.js` inserts the `business_events` row.
  4. The client calls `event-playlist.js` straight away. The card under "פלייליסטים אחרים" shows a spinner in its button, then "▶ פתח" (no auto-open).
  - A failed build leaves a "נסו שוב" button plus a toast.
  - Build state lives in `eventBuilds` (`v7/account/app.js`), so re-renders keep the spinner. A card younger than 3 minutes with no playlist (e.g. after a refresh) is treated as still building.
- **Today only.**
  - The day runs 04:00 → 04:00 IL (`prevIl4amIso` / `nextIl4amIso` in `v7/generation/playlist-length.js`; tests: `node --test scripts/test-il-4am.mjs`).
  - The playlist expires at the next 04:00 (ledger + expire cron, so ~04:30).
  - The card shows only during its day (`todaysEvents`; an open page re-renders at 04:00). The row stays as history.
  - `event-playlist` refuses an older event with 410.
  - The chat gets a per-turn "## Today" block (date, time, deadline, count made today). It turns away future events and asks the owner to come back on the day.
- **2 per day** (`SPECIAL_PLAYLISTS_PER_DAY`).
  - The count is `business_events` rows since the last 04:00.
  - The chat says so first; `save-event` returns 409 `daily_cap`.
  - Trash deletes the row, which frees a slot.
- **How the playlist is made** (`event-playlist.js`, classifier prompt `v7/generation/event-playlist-prompt.js`):
  - **Model:** Gemini (v7 `ai-provider.js` constants, label `v7-event-playlist`) reads the brief. It returns genres + a tempo range + instrumental / popularity preferences.
  - **Genres:** `genre_source:'daily'` (the owner agreed in the chat to use their daily styles; the chat asks when they named no styles) → only the taste profile's approved genres. `'event'` → any of the 124. No pairing rules — Roni: those are for day-to-day cohesion.
  - **Preferences:** start from the taste profile; the brief can override them.
  - **Tracks:** `v5_direction_tracks` random draw, ~223 like v6 (`closedDayTargetTracks`), floor 5. It leaves out every track in the business's live playlists today (daily + special).
  - **Spotify and rows:** playlist on Rubin "<business> · <name> · dd.mm.yyyy" (IL date), `created_playlists` ledger, and a `business_playlists` row (`event_id`, ico 🎪, `track_genres`).
  - **Concurrency:** one build per event at a time (`acquireBuildLock('event:<id>')` → 409 `building`). The client then watches the table and retries once the lock has lapsed. An event that already has a live playlist returns it.
  - **⚠️ TEMPORARY: tempo (`bpm_range`) stands in for energy. Replace it with energy once Ami's energy tests (his dashboard's test playlists) conclude.**
- **Trash** (`delete-event.js`). Disabled while the card is building.
  - The card goes at once in the client, and comes back if the call fails.
  - The server archives the row into `deleted_events`, deletes it, and sets the playlist's `business_playlists.expires_at = now`.
  - Spotify: the playlist is deleted right away (`expirePlaylistNow`), unless the daily or expire cron is running (`runningCrons`). In that case the ledger's `expires_at = now` hands it to the next :30 expire sweep.
- **Migration** [`v5/precompute/migrations/2026-10-03-v7-event-genre-source.sql`](v5/precompute/migrations/2026-10-03-v7-event-genre-source.sql) adds `business_events.genre_source`. Without it, rows save without the column and read as `'event'`.
- **How the chat talks** (Roni, 2026-10-03):
  - always in the plural ("תרצו", "חזרו", "הגעתם");
  - never calls it "פלייליסט מיוחד" / "פלייליסט ספיישל". It explains what the chat does instead ("הצ'אט הזה מכין פלייליסטים לאותו היום").
  - The owner-facing server errors follow the same wording.
  - Thinking levels match v6: low for the chat, high for the classifier.
- **Live test:** `scripts/_v7-special-playlists-walkthrough.mjs`. It runs against `vercel dev` on a throwaway business and cleans up after itself. It creates ~2 Spotify playlists and makes ~6 Gemini calls; avoid running it at :00 / :30. It also checks every chat reply for singular forms and for "מיוחד" / "ספיישל". 23 checks passed on 2026-10-03.

### v7 onboarding + signup runtime — BUILT

- **Client** (`v7/`): `index.html` + `app.js` (state machine) + `atmosphere.js` / `atmosphere-bubbles.js` / `emphases.js` / `hours-selector.js` / `preview.js` (R1 + R2 swipe decks) / `result.js` (registration + payment + taste-profile bar — its fill runs 35s via `.taste-profile-fill`; the swipe-deck loaders keep 25s). Funnel: desc → places → atmospheres → emphases → hours → R1 swipe → (R2 if <3 picks) → registration → payment (Hyp; the placeholder screen while `PAYMENTS_ENABLED = false`) → taste-profile bar → `/v7/account`.
- **Account** (`v7/account/`): `index.html` + `app.js` (delivery-mode gate, energy-directions build) + `direction-chat.js` (dormant for v7 — reads empty `business_directions`).
  - **Home tab, top to bottom:** the daily playlists; today's special-playlist cards ("פלייליסטים אחרים", always visible); the **"חידודים מוזיקליים"** chat; the special-playlists chat ("צריכים משהו אחר היום?"; see "v7 special playlists" above).
  - **The two chats** are identical collapsible dropdown cards, closed by default (same `.hours-toggle` pattern as the Profile sections).
  - **"חידודים מוזיקליים"** moved there from the Profile tab on 2026-10-03. `direction-chat.js` boots the first time its card opens. It's still the dormant v6 copy until a v7 version is built.
- **Opening-hours rule (2026-09-29).** A day's closing time must be after its opening time, except a close after midnight, allowed up to 06:00 (20:00–02:00 is fine, 15:00–14:00 isn't). A day is also capped at 20 hours (so 06:30–06:00 is refused), and open = close is refused. Without the rule, an overnight window swallows the next morning: `businessWindowAt` keeps treating it as the previous business day. One source, **`shared/opening-hours.js`** (`dayHoursProblem` / `hoursProblems` / `hoursProblem`), used in three places:
  - the hours editor (`v7/hours-selector.js`): the problem is shown under the days with red time fields, and "המשך" / Profile "שמור" stay disabled while it's there;
  - `api/v7/account/update-hours.js`: 400 `bad_hours` with the Hebrew text;
  - `api/v7/account/signup.js`: 400 `bad_hours`, checked before anything is created, so a paid checkout stays unclaimed.
  v6's editor and endpoints don't have the rule. Tests: `node --test scripts/test-opening-hours.mjs`.
- **No inline playlist rename in v7 (kept this way for now; may change).** v6's Home-tab inline rename (click a playlist title → edit) and the per-playlist edit / trash icons are NOT available in v7. This wasn't a deliberate product decision — it fell out of the build: the code was copied from v6 and is still in `v7/account/app.js` (`enterRenameMode`, `editDirectionFromCard`, `openTrashDirectionModal`), but every one of those controls only renders when the row has a `direction_id` (`canRename = !!p.directionId …`, `if (p.directionId)`), and v7 rows always insert `direction_id: null` (FK to v6's `business_directions`). Roni has chosen to keep it off for now. Reviving it would need a v7 path that edits `business_v7_directions` instead of calling v6's `apply-direction-change` — and a decision on how a rename interacts with the fixed "אנרגיה גבוהה/רגועה #N" names.
- **⚠️ Real payments are switched on PER ENVIRONMENT by `V7_PAYMENTS_ENABLED=true`** (read as `PAYMENTS_ENABLED` in `api/v7/payment/_hyp.js`; since 2026-09-29 — before that a hard-coded constant, off 2026-09-28). ON in Development (Roni is finishing payments in `vercel dev` against the **production** terminal), OFF in Production until it's set there, so deploying unrelated work can't switch payments on. While off: the payment step shows the OLD placeholder screen (`runPlaceholderPaymentStep` in `v7/result.js` — all fields optional, resolves with `''`), `GET /api/v7/payment/checkout` returns `{paymentsEnabled:false}`, POST returns 503, and signup requires no checkout (`paid_at` = signup time, as before Hyp). **Invoices** come from Hyp's own invoicing module (Hyp Invoice / EZcount: `SendHesh=True` → emailed to `email`), issued in the name of the business that owns the terminal — confirmed 2026-09-29 by the company's integration guide for another project. The module must be active on the terminal (on the test terminal it isn't — the portal shows "הרשמה למערכת החשבוניות" — which is why no test invoice ever arrived). That guide also copies every invoice to the company's bookkeeping inbox via `EZ.cc_emails` (not sent by us yet — the address comes from Dan). **Testing on the production terminal charges real cards** (the Hyp test card is declined there): each successful test is a real charge at the monthly price (₪200 — but in Development `V7_PRICE_OVERRIDE_ILS=2` makes it ₪2, and ₪1 for the first month with TEST50 while coupons are on) + a real standing order — cancel both (same-day `CancelTrans` before 22:00 IL costs no fee; the agreement via `scripts/_hyp-hk-status.mjs`).
- **Payment (Hyp, built 2026-09-27).** The payment step (`runPaymentStep` in `v7/result.js`) is Hyp Pay's hosted page (pay.hyp.co.il, formerly YaadPay — docs https://developers.hyp.co.il/pay; append `.md` to any page for raw Markdown, and use curl — WebFetch truncates the big reference pages) in an iframe. Product: **₪200/month, charged automatically by Hyp until cancelled** — a Hyp-managed recurring agreement (הוראת קבע: `HK=True&freq=1&Tash=999&OnlyOnApprove=True`); price is `MONTHLY_PRICE_ILS` in `api/v7/payment/_hyp.js` — but the **test terminal charges ₪10/month** (`TEST_TERMINAL_PRICE_ILS`, temporary, per Hyp's ~10 ILS test-amount advice; `monthlyPriceIls(env)` picks it). **Coupons** discount the FIRST month only (`TashFirstPayment`), percent-based, from `payment_coupons`. **Tax invoice** emailed by Hyp (`SendHesh=True`) — but only when Hyp's invoicing module is active on the terminal (see the ⚠️ bullet above; it is NOT on by default — the test terminal never sent one). The terminal's default document (portal → חשבוניות דיגיטליות → הגדרת מסמך ברירת מחדל) should be קבלה / חשבונית מס. No company number — the law requires one only above ₪5,000). No installments. Flow:
  0. **Everything is on ONE page** (since 2026-09-28): our billing form on top, Hyp's card form (iframe) right under it in a collapsible **"פרטי תשלום"** section (`.pay-toggle`, closed at first, opens by itself the first time the card form loads). Hyp needs the details inside the signed request, so the card form loads 0.7s after the name is typed (`NAME_SETTLE_MS`) and is **re-signed + reloaded on every detail change** (`change` event; a reload clears card digits already typed — owners fill top-down). Re-signs pass the page's `checkoutId`, and the endpoint updates that row while it's pending (same `Order`) instead of inserting; a failed/paid row gets a new one. **Coupons are off by default** (`V7_COUPONS_ENABLED` — see ENVIRONMENT VARIABLES; a code constant before 2026-09-29): on the TEST terminal Hyp's server returned 500 after charging whenever a recurring page carried `TashFirstPayment` (every number format; the discounted first charge did go through) — reported to Hyp 2026-09-28, **reproduced on the production terminal 2026-09-29** (order 6: the ₪1 first charge went through and Hyp created the invoice, then crashed before emailing it or redirecting back). The exact request/response prepared for Hyp support is in `hyp-support/tashfirstpayment-request-response.json` (the folder is gitignored and local only — it holds emails + terminal numbers). A Chrome net-export of a failing production payment (order 8, 2026-09-29 09:33 UTC) showed the crash is inside Hyp: their own card form posts to `pay.hyp.co.il/cgi-bin/yaadpay/yaadpay.pl` and gets a bare 500 — the web server's stock "Internal Server Error" page (526 bytes, `comp@yaad.net`), i.e. their script crashed with no Hyp error code. To pull the payment requests out of such a log: `node scripts/_netlog-extract.mjs <netlog.json>` → `<log>.extract.txt`. While off, the coupon field is hidden (the GET returns `couponsEnabled`) and any coupon is ignored. While on, the field checks the code inline (`GET /api/v7/payment/checkout?coupon=` → animated dots, then ✓ with the first-month price or ✗). Card-form loads (`sign` in `runHypPaymentStep`) run one at a time, so a burst of edits can't open a second checkout row. SIGN also sends `sendemail=True` (Hyp's payment confirmation, as in the company's working setup). **Hyp drops "+" from stored email addresses** (sent `roni.mark%2Btestb%40gmail.com`, stored `roni.marktestb@gmail.com` — a different, possibly stranger's, mailbox that the standing order would keep for every monthly invoice), so Hyp gets the account email **without its "+tag"** (`invoiceEmailFor` in `shared/invoice-email.js`, used by `_hyp.js` and shown on the payment screen as "החשבונית תישלח אל …"); the checkout row keeps the full address in `email` and the sent one in `billing.invoiceEmail`.
  1. The screen shows the price (`GET /api/v7/payment/checkout` → `{amountMonthly, couponsEnabled, env}`) + our own billing form: **שם מלא** (required — sent as `ClientName`, the cardholder), **כתובת** (optional → `street` + `EZ.customer_address`), **שם העסק** (optional — when filled the invoice is made out to it, via `EZ.customer_name`), **ח.פ / ע.מ** (optional, digits → `EZ.customer_crn`), and the coupon. Hyp's page uses **template 6 (`tmp=6`) — card fields only** (card, expiry, CVV, cardholder ID). `EZ.customer_name` / `EZ.customer_address` are NOT in Hyp's docs: they're fields of Hyp's invoicing service (Hyp Invoice, formerly EZcount) passed through like the documented `EZ.customer_crn` — confirm on a real test invoice. "המשך לתשלום" → `POST /api/v7/payment/checkout` validates billing (400 with a Hebrew message) and the coupon — **an unknown coupon never blocks the payment**: the page is signed at full price and the response carries `couponRejected: true` (the screen keeps its ✗ under the field) — inserts a pending `payment_checkouts` row (incl. `billing`), and signs the page with Hyp (`APISign`/`What=SIGN`; `Order` = the row's `order_no`). Amounts come only from the server and are covered by Hyp's signature.
  2. The iframe loads Hyp's page. On success Hyp redirects the iframe to the **"successful transaction" URL configured in each terminal's Hyp portal** (הגדרות → API-דף תשלום ו → הפנייה לאחר עסקה → עסקה שהצליחה → לינק מותאם אישית) = `<host>/api/v7/payment/return`. There is no per-request return URL, and **Hyp sends no server-to-server notification** — this redirect is the only signal.
  3. `api/v7/payment/return.js` forwards the raw query string, byte for byte, to Hyp's `What=VERIFY` (Hyp's Hebrew fields can be windows-1255 — never decode + re-encode), marks the row `paid` (storing `Id`, `HKId`, `ACode`, the raw query), and returns a tiny page that `postMessage`s the parent (same origin). The parent also polls `GET /api/v7/payment/status?id=` every 3s, so a lost message never strands the owner. Idempotent on reload.
  4. `runPaymentStep` resolves with the paid checkout id → `state.paidCheckoutId` → signup payload `checkoutId`. Signup **requires** a paid checkout (402 otherwise), claims it (`business_id`), and stamps `businesses.paid_at` from it; once claimed only the same email may reuse it (409) — the resend path re-posts it. Internal test callers (`x-sonic-internal`) may omit `checkoutId`, so the walkthrough scripts still work.
  5. A paid-but-unclaimed checkout id is kept in localStorage (`rubin-v7-paid-checkout`), so going back or refreshing mid-funnel never charges twice; cleared after a successful signup.
  - **Terminals:** `HYP_ENV` = `test` (default) | `production` selects `HYP_TEST_*` or `HYP_PROD_*` (see ENVIRONMENT VARIABLES). Each checkout row records its `hyp_env` + `masof` and is verified against that terminal. Test card: `5253360311315452`, 12/29, CVV 493, ID 890108558. 3DS / Apple Pay / bit work only on production terminals. The portal toggle "אימות על ידי חתימה בעמודי התשלום" must be on (Hyp's docs put it under הגדרות → דף תשלום ו-API → אימות; it wasn't visible on the production terminal's menu on 2026-09-29 — if it's off, the card is charged but VERIFY fails and our page shows "התשלום לא אושר"). On the production terminal, the portal setting **"מניעת עסקאות כפולות"** may decline a repeat test with the same card and amount soon after the first.
  - **Same-origin requirement:** the return page is framed by our page, and `vercel.json` sets `X-Frame-Options: SAMEORIGIN` globally — the portal's return URL host must be the host the owner is on (robin-music.com vs sonic-brand.vercel.app matters in production).
  - **Credentials check:** `node scripts/_hyp-sign-probe.mjs` signs a page with the current terminal and prints its URL (CCode 902 = wrong PassP). Nothing is charged or written.
  - **Cancelling agreements by hand:** `node scripts/_hyp-hk-status.mjs <HKId> ...` terminates (`--resume` resumes) on the `HYP_ENV` terminal via `action=HKStatus`. Agreement numbers: `payment_checkouts.hyp_hk_id`, or the Hyp portal's standing-order list (which has no delete button). There's no API to list a terminal's agreements — never guess HKIds.
  - **Not built yet:** owner-facing subscription cancellation (the account page calling `HKStatus` with the stored `hyp_hk_id`); visibility of later monthly charges (Hyp-managed charges send no notification — failures show only in the Hyp portal); a 100% coupon (₪0 first charge) is undocumented — test it before offering one.
- **Passwords (added 2026-09-28).** v7 owners log in with email + password; emailed links are only for verifying the email (first login) and "שכחתי סיסמה".
  - **Password rule:** at least 8 characters incl. an uppercase + a lowercase English letter + a digit, and not in a known data leak. One source, **`shared/password-rules.js`** (`passwordProblem` → Hebrew message or null, `PASSWORD_RULES_TEXT`), used by the registration screen, the new-password screen, Profile, signup and `set-v7-passwords.mjs`. It mirrors the Supabase settings (min length 8 + "Digits, lowercase and uppercase letters"), which Supabase enforces on save; checking first lets registration reject a password BEFORE payment. The leaked check only runs in Supabase on save — at signup that's after payment, so a refused password (400 `weak_password`) gets a "choose another password" screen and a retry.
  - **Registration** (`runRegistrationStep` in `v7/result.js`) asks for email + password (held in memory only, never localStorage) and calls **`POST /api/v7/account/check-email`** → `{registered}` before resolving. Registered = an auth user that owns a business; a registered email is stopped there ("האימייל הזה כבר רשום" + a link to `/v7/account?email=…`), before payment. Rate-limited 20 per 10 min per IP — it tells anyone whether an email has an account, like most sign-up forms.
  - **Signup's password rules** (`prepareUser` in `api/v7/account/signup.js`; shared lookups in `api/v7/account/_auth-users.js`). A password only ever lands on an UNVERIFIED account, so it can't be used until the inbox owner clicks the link: no account → create it (unverified) with the password; unverified with no business → set the password; unverified WITH a business → only a resend of the same signup, which must carry `resendFor` = the business id the first call returned (the client's "שלחו שוב" and error-retry paths send it; error responses echo `business_id` once it exists) — anything else 409; verified + business → 409 `already_registered`, password never touched; verified with no business (a leftover login) → deleted and recreated unverified. A password Supabase refuses (weak / leaked, `weak_password`) returns 400 and the client asks for another one before retrying. Internal test callers may omit the password.
  - **Account login** (`v7/account/app.js`): `signInWithPassword`. Wrong email or password → one generic message. `email_not_confirmed` → "עוד לא אישרתם את האימייל" + a button that sends a new verification link (`signInWithOtp` with `shouldCreateUser:false` — the login page never creates accounts; before 2026-09-28 it did, for any email typed in). "שכחתי סיסמה" → `resetPasswordForEmail` (redirect `/v7/account`) → the link's `#type=recovery` is read before `createClient` consumes the hash and remembered in sessionStorage (`rubin-v7-set-password`) → `#newPasswordView` → `updateUser({password})` → dashboard. Expired / used links (`#error_code=…`) show a message on the login screen. Resends wait out a 60s countdown. A login with no business behind it is signed out with a message.
  - **Profile → סיסמה** (collapsible): current + new password; the current one is checked with `signInWithPassword` before `updateUser`.
  - **Password fields** (registration, new-password screen, login, Profile) have an eye button on the right side of the field that shows / hides the password (`passwordToggle` in `v7/result.js`, same in the account app). Autofilled fields keep the dark background and text colour (an inset shadow covers Chrome's light blue). The account LOGIN fields use Chrome's own pre-click autofill font (~13.3px, see the comment in `v7/account/index.html`), so saved credentials don't change size on the first click.
  - **Existing accounts** got a shared password via `scripts/set-v7-passwords.mjs <password> --before=<date>` (dry run by default; `--confirm`; only owners of a v7 business created before the date, so a re-run can't overwrite owner-chosen passwords).
  - **Supabase dashboard settings** (manual): Auth → Email keeps "Confirm email" on, minimum password length 8, password requirements "Digits, lowercase and uppercase letters", leaked-password protection on; Email Templates → "Reset Password" in Hebrew (same design as the magic-link email). If the rule changes, change `shared/password-rules.js` with it.
  - Tests: `scripts/test-v7-signup-passwords.mjs` (check-email + every signup rule against `vercel dev`, throwaway `@example.invalid` users, self-cleaning).
- **Email verification is REQUIRED (like v6; decided 2026-09-24).** Nothing in the v7 funnel logs the owner in. After payment, the bar awaits the taste profile, THEN `api/v7/account/signup.js` runs ("no non-paying clients" — no account before payment): it checks the paid Hyp checkout, creates/updates the user + a `businesses` row (`version='v7'`, `paid_at` = the payment time) and claims the checkout (while payments are switched off: no checkout is required and `paid_at` = signup time), **saves the taste profile** (`business_taste_profiles`, via the shared `_taste-profile.js` row builder, with the super-liked genres + Round 2 text since 2026-10-05) BEFORE emailing, backfills `gemini_call_log` once (all onboarding calls incl. the taste profile have resolved by then), and finally emails the one-time magic link (`/auth/v1/otp`, fatal if it fails). The client shows "בדקו את המייל ✉️" with a "לא הגיע? שלחו שוב" resend that re-posts the same (idempotent) payload. The resend waits out a 60-second countdown ("אפשר לשלוח שוב בעוד 0:59") that starts when the screen appears and restarts after every resend or 429 — Supabase sends at most one login email per user per ~60s. Clicking the link verifies the email and lands on `/v7/account`. Returning owners are looked up via the admin user list's `?filter=` — NOT admin `generate_link`, which counts as a login-link send and tripped Supabase's ~60s per-user email interval (the reason v7's email never arrived before 2026-09-24; v6's signup still uses `generate_link` for returning users). A too-soon resend gets a friendly 429. Test scripts skip the email with `skipEmail:true` + a valid `x-sonic-internal` header (their addresses are `@example.invalid`) and mint their own session via admin `generate_link` + `verify`. Caveat: an owner who pays and then closes the tab before signup finishes has a paid, unclaimed `payment_checkouts` row but no account (Hyp has no server callback to create it from). Reopening onboarding in the same browser skips the payment step via the localStorage checkout id; otherwise find it in `payment_checkouts` (status `paid`, `business_id` null).
- **Direction ranks are globally unique across rounds:** R1 = 1–8 (page 1 = 1–4, page 2 = 5–8), R2 = **9–12** (`R2_RANK_START` in `v7/generation/refined-directions.js`). The R2 and taste-profile prompts reference LIKED/DISLIKED by rank, so `v7/app.js round1DirectionsSeen()` passes page 1 **plus** every page-2 direction that was liked/disliked (`state.directions` alone is page 1 only). `state.round2Directions` holds the R2 set so the taste-profile retry can rebuild the same call.
- **Endpoints**: `api/v7/anchor-tracks.js` (swipe-deck anchors → `v7_anchor_tracks` RPC, anon key — see the bpm_range note above) + `api/v7/payment/`: `checkout.js`, `return.js`, `status.js`, `_hyp.js` (see "Payment (Hyp)" above) + `api/v7/account/`: `signup.js`, `save-taste-profile.js`, `set-delivery-mode.js`, `save-energy-directions.js`, `generate-daily.js`, `_daily-builder.js`.
- **Live verification scripts** (self-cleaning, throwaway user/business, safe against prod): `scripts/_v7-walkthrough.mjs` (Phase A onboarding→signup→account) and `scripts/_v7-phaseb-walkthrough.mjs` (Phase B daily builders + v7 cron + expiry). `/v7/?reset=1` (and the account app) clears the Supabase session for re-testing, same as v6.

---

## FILE STRUCTURE

```
sonic-brand/
├── v6/                                     ← Legacy v6 UI (reachable at /v6, no accounts). Full subtree in docs/v6-reference.md.
├── v7/                                     ← BUILT + LIVE-VERIFIED. Parallel runtime; served at `/` since 2026-09-28.
│   ├── index.html                          ← Onboarding shell + v7 CSS
│   ├── app.js                              ← Onboarding orchestrator: desc→places→atmospheres→emphases→hours
│   │                                          →R1 swipe→(R2 if <3)→registration→payment→taste-profile bar→account.
│   ├── atmosphere.js / atmosphere-bubbles.js / emphases.js / hours-selector.js  ← ports of the v6 steps
│   ├── preview.js                          ← R1 + R2 swipe decks. Anchors via /api/v7/anchor-tracks → v7_anchor_tracks
│   │                                          (no BPM) — NOT v6's /api/v5/anchor-tracks.
│   ├── result.js                           ← registration (email + password + check-email) + payment (Hyp iframe; placeholder while off) +
│   │                                          taste-profile bar → signup → "בדקו את המייל ✉️" (resend re-posts signup
│   │                                          with resendFor)
│   ├── wait-dots.js                        ← Animated "…" for WAITING messages (dots appear in order, then clear), used by
│   │                                          the onboarding and account apps; injects its own CSS. setWaitText(el, text) /
│   │                                          waitNodes(text) turn every "…" / "..." into the animation and "
" into <br>;
│   │                                          WAIT_DOTS_HTML for innerHTML templates. Placeholders keep a plain "…".
│   ├── test-timeline/index.html            ← SANDBOX (not linked from the app; /v7/test-timeline, served — ES-module
│   │                                          imports don't load from file://). Runs the SAME editor + model as the
│   │                                          account (imports both), so it can't drift. Dev panel: sample hours
│   │                                          (switching runs the real keep-clock-times reconciliation), N, time
│   │                                          direction, 15-min "translation to playlist" strip, stored JSON.
│   ├── account/
│   │   ├── index.html                      ← incl. #timelineModal (Option-2 editor + "replace today?" step)
│   │   ├── app.js                          ← type gate (option1/option2; option2 → timeline modal); Profile type
│   │   │                                      cards + "עריכת ציר האנרגיה"; replace-today flow; Option-1
│   │   │                                      energy-directions build; business-day "today" helpers; Home-tab
│   │   │                                      special-playlists chat + cards (eventBuilds, todaysEvents)
│   │   ├── energy-timeline-editor.js       ← The approved Option-2 timeline editor (TimelineEditor), extracted from
│   │   │                                      the sandbox; injects its own .etl-* styles. Client-only.
│   │   └── direction-chat.js               ← DORMANT for v7 (reads empty business_directions; kept for parity). Drives the
│   │                                          Home tab's "חידודים מוזיקליים" card (moved from Profile 2026-10-03).
│   └── generation/
│       ├── energy-timeline.js              ← Option-2 timeline MODEL (browser + server): hours groups, :00/:30 slots,
│       │                                      monotone curve, levels, reconcileTimeline (keep clock times),
│       │                                      businessWindowAt (IL + overnight). Bare imports.
│       ├── timeline-assembler.js           ← Option-2 duration-based assembler (pure, seeded RNG): demand → pool
│       │                                      sizes, per-track random genre, two disjoint mixes. Bare imports.
│       ├── musical-directions.js           ← R1 diagnostic taste probes (8, 4+4 split). label='v7-onboarding'.
│       ├── refined-directions.js           ← R2 refinement (4 probes, fires when R1 picks < 3).
│       │                                      label='v7-onboarding-refined'. Imports R1 sub-constants.
│       ├── taste-profile.js                ← Full 124-genre bucketing + dynamic 2-6 energy levels.
│       │                                      Runs once after R1/R2 resolve, before signup. Output:
│       │                                      approved/conditional/excluded + energy_levels_total +
│       │                                      per-genre energy_level + inst_pref/pop_pref carry-through.
│       │                                      label='v7-taste-profile'. NO Places injection (the venue only
│       │                                      cuts inferred genres, via the description; 2026-09-30).
│       │                                      Maximalist expansion + hard boundaries + groove floor.
│       ├── level-directions.js             ← Option-2 per-energy-level direction libraries from approved_genres.
│       │                                      label='v7-level-directions'. No forced pairings; rotated daily
│       │                                      (pickLevelDirections in timeline-assembler.js) (2026-09-28).
│       ├── energy-directions.js            ← Option-1 energy-tiered directions from approved_genres.
│       │                                      label='v7-energy-directions'. Library of up to 30 v6-style
│       │                                      blends, each wholly high or low, ≥2 per tier (2026-09-28).
│       │                                      Requested genres in every direction of their tier (2026-10-05).
│       ├── option1-draw.js                 ← Option-1 daily draw (pure, no imports; builder + Ami's dashboard): pickTierPair
│       │                                      (random, then the least alike), requestedByTier, withRequested (2026-10-05).
│       ├── playlist-length.js              ← port of the v6 helper (server-reachable: bare imports). v7 has no
│       │                                      popularity-window.js (unused copy deleted 2026-09-24).
│       ├── event-chat-prompt.js            ← v7 special-playlists chat prompt (today only, 2/day, styles question) +
│       │                                      buildEventChatContext. Used server-side by api/v7/account/event-chat.js.
│       ├── event-playlist-prompt.js        ← v7 special-playlist classifier: brief → genres + tempo + preferences.
│       │                                      Used by api/v7/account/event-playlist.js. Tempo is TEMPORARY (→ energy).
│       └── ai-provider.js                  ← Independent copy of v6's provider switch. Currently identical
│                                              (Gemini 3.6-flash, thinking=high) but flipping v6's PROVIDER
│                                              does NOT touch v7. Both prompts + Ami's dashboard route here.
│                                              SERVER-REACHABLE — bare imports only, no ?v= query.
├── shared/                                 ← Cross-version source of truth.
│   ├── invoice-email.js                    ← invoiceEmailFor: the address Hyp gets (the "+tag" dropped — Hyp mangles "+").
│   │                                          Browser (payment screen) + server (_hyp.js).
│   ├── opening-hours.js                    ← v7 opening-hours rule (browser + server): hoursProblem / dayHoursProblem.
│   │                                          Closing after opening, or after midnight by 06:00; ≤ 20h a day.
│   ├── password-rules.js                   ← v7 password rule (browser + server): passwordProblem, PASSWORD_RULES_TEXT.
│   │                                          Mirrors the Supabase Auth password settings.
│   └── genre-universe.js                   ← THE canonical genre list. Exports GENRES (array, 124 entries),
│                                              GENRE_SET, and GENRE_UNIVERSE_SECTION (formatted prompt block).
│                                              Every consumer (v5/v6/v7 musical-directions.js,
│                                              v6/generation/genre-list.js) re-exports or imports from here.
│                                              The old "THREE code locations" invariant collapsed to this
│                                              file on 2026-09-23.
├── v5/                                     ← Reference; standalone flow still runnable
│   ├── ami-prompt-dashboard/               ← Ami's prompt-tuning dashboard. Since 2026-09-23 imports
│   │                                          EDITABLE_PROMPT_SECTION + assembleSystemPrompt from
│   │                                          `/v7/generation/musical-directions.js` (was v5). Also imports
│   │                                          callModel/PROVIDER from `/v7/generation/ai-provider.js` (was v6).
│   │                                          Since 2026-09-28 also edits + tests the v7 taste-profile prompt
│   │                                          (swipe simulation → `/v7/generation/taste-profile.js`), and
│   │                                          step 4 shows the Option-1 / Option-2 directions built from the
│   │                                          profile (`playlist-directions.js`; each option's prompt editable).
│   │                                          Since 2026-09-30, Option-1 energy test playlists per direction
│   │                                          (`test-playlists.js` → api/v7/ami/test-playlist.js).
│   ├── precompute/
│   │   ├── v5-rpc-functions.sql            ← CREATE OR REPLACE for v5_anchor_tracks, v5_direction_tracks,
│   │   │                                      v6_direction_tracks_recent (all now accept p_inst_pref)
│   │   └── migrations/                     ← Dated SQL migrations for every version, v7's included
│   │                                          (run in the Supabase SQL Editor)
│   └── generation/musical-directions.js    ← Still consumed by legacy v5/app.js standalone UI. No longer
│                                              read by Ami's dashboard. Header comments + `MODEL='claude…'`
│                                              constant are dead code from the pre-ai-provider era.
├── v4/
│   ├── ami/                                ← Ami's dashboard (scan sheet → Supabase)
│   ├── precompute/                         ← Batch worker for track analysis (fills track_analyses): batch.mjs +
│   │   │                                      the dry-run-*.mjs planners (see § COMMON TASKS → Precompute)
│   │   ├── schema.sql                      ← track_analyses / playlist_tracks / playlist_genres schema
│   │   ├── genre-status.mjs                ← Read-only per-genre report: OK tracks, orphans, and whether each genre is
│   │   │                                      in shared/genre-universe.js (~2 min). Used after digesting new genres.
│   │   ├── playlist-scan.mjs               ← RapidAPI analysis of whole playlists → playlist-scans/<id>.json
│   │   │                                      (no Supabase). See § COMMON TASKS → Precompute.
│   │   └── playlist-scans/                 ← playlist-scan.mjs results (2026-09-28 scans kept here).
│   └── ...                                 ← v4 UI (mostly superseded by v6)
├── v3/, v2/                                ← Historical
├── michael-v4-snapshot/                    ← Gitignored. Snapshot of Michael's v4 fork. UI reference for v6.
├── api/
│   ├── _alert.js                           ← Resend REST helper. Reads SUPABASE_AUTH. Callers MUST await it
│   │                                          before res.end() — see "Alerts via Resend" mechanism.
│   ├── _cron-running.js                    ← Redis "cron running" flags set by both crons for their whole tick;
│   │                                          read by api/v7/ami/test-playlist.js so Ami's builds wait. Fail-open.
│   ├── alert-probe.js                      ← Diagnostic endpoint (CRON_SECRET-gated). GET reports whether
│   │                                          SUPABASE_AUTH is visible in the running function process;
│   │                                          POST does a live Resend send via the shared sendAlert helper.
│   ├── v6/
│   │   ├── origin-guard.js                 ← requireSite / requireSiteOrInternal helpers
│   │   ├── ratelimit.js                    ← Upstash-Redis fixed-window guard (see mechanism section)
│   │   ├── gemini.js                       ← Google Gemini generateContent proxy (multi-turn via `history`); writes gemini_call_log after every call
│   │   ├── gemini-pricing.js               ← Date-aware per-model rates; computes cost_usd for the log writer
│   │   ├── place-lookup.js                 ← Google Places (New) v1 textsearch
│   │   ├── transcribe.js                   ← Whisper (OpenAI)
│   │   └── account/
│   │       ├── _daily-builder.js           ← Shared build+persist module: buildDailyBatch, activeDirections
│   │       ├── _require-business-owner.js  ← requireBusinessOwner(businessId, userId) — SELECT businesses row and
│   │       │                                  verify owner_id matches the JWT-authenticated caller. Used by
│   │       │                                  expand-playlist, event-playlist, generate-daily to close an
│   │       │                                  authorization hole where any valid JWT could otherwise write to
│   │       │                                  any business's data via service-role writes.
│   │       ├── _expire-playlist.js         ← Shared expirePlaylistNow() — rename + empty + unfollow + mark deleted.
│   │       │                                  Used by both the hourly cron and direction-chat's apply endpoint.
│   │       ├── signup.js                   ← Supabase admin user + business + business_directions + super_liked_tracks; backfills gemini_call_log with new business_id via onboarding_session_id
│   │       ├── event-playlist.js           ← v6 only: Gemini (v6 ai-provider) → genres + BPM → v5_direction_tracks → Spotify + ledger
│   │       ├── expand-playlist.js          ← Streaming ndjson: grow onboarding playlists to per-day target
│   │       ├── generate-daily.js           ← User-triggered daily build (closed-day "המקום פתוח?" + empty-state "צור פלייליסטים"). STREAMING ndjson: plan → built/failed per direction → done. Directions ordered by click-count DESC (see business_playlist_opens). 5min maxDuration.
│   │       ├── update-hours.js             ← Profile-page hours edit; logs before/after into business_settings_changes
│   │       ├── update-business-name.js     ← Profile-page business-name edit (added 2026-09-05, replaces client-direct
│   │       │                                  sb.from('businesses').update); logs before/after into business_settings_changes
│   │       ├── upsert-event.js             ← business_events insert/update from the event chat finalize; backfills business_event_chats.event_id
│   │       ├── event-chat.js               ← One Gemini turn for the special-events chat; persists both messages to business_event_chats
│   │       ├── delete-event.js             ← Card-level delete; archives the row into `deleted_events` before deleting
│   │       ├── direction-chat.js           ← One Gemini turn for the direction-edit chat; persists both messages
│   │       ├── preview-direction.js        ← Round-robin anchor track for a merged (edit) or inline (add) spec
│   │       ├── apply-direction-change.js   ← Commit add/edit/remove; rebuild playlist; audit row
│   │       ├── toggle-super-like.js        ← Upsert or SOFT-DELETE (`deleted_at=now()`) one super_liked_tracks row —
│   │       │                                  soft-delete added 2026-09-05 so un-super-liking preserves engagement history
│   │       └── log-playlist-open.js        ← Append one business_playlist_opens row per dashboard "▶ פתח" click
│   ├── v7/
│   │   ├── ami/test-playlist.js            ← Ami's energy test playlists (50 random / 50 in an energy range) on
│   │   │                                      Rubin's account; waits for the crons. See § AMI'S DASHBOARD.
│   │   ├── anchor-tracks.js                ← v7 swipe-deck anchors → v7_anchor_tracks RPC (cheap playlist-sampling
│   │   │                                      pick, no BPM; anon key). Same origin guard + `anchor-tracks` rate bucket
│   │   │                                      as v5's. Needs migration 2026-09-24-v7-anchor-tracks.sql.
│   │   ├── payment/                        ← Hyp Pay subscription checkout (migration 2026-09-27-v7-payments.sql).
│   │   │   ├── _hyp.js                     ← Terminal config (HYP_ENV), price, SIGN + VERIFY calls, response parser.
│   │   │   ├── checkout.js                 ← GET price (+ `?coupon=` inline coupon check) / POST: coupon → pending
│   │   │   │                                  payment_checkouts row → signed page URL.
│   │   │   ├── return.js                   ← Hyp's success redirect (set in the portal): VERIFY → mark paid → postMessage.
│   │   │   └── status.js                   ← Checkout status for the payment screen's poll ({status, claimed}).
│   │   └── account/
│   │       ├── signup.js                   ← v7 onboarding→account bridge, after payment + the taste-profile bar.
│   │       │                                  Requires a paid payment_checkouts row (checkoutId) and claims it.
│   │       │                                  Creates user (with the password — rules in § V7 "Passwords") +
│   │       │                                  businesses row (version='v7', paid_at), SAVES the taste profile,
│   │       │                                  backfills gemini_call_log, then emails the magic link.
│   │       │                                  Never returns a session — email verification required.
│   │       ├── check-email.js              ← Registration-screen check: {registered} (auth user owning a business).
│   │       ├── _auth-users.js              ← Shared admin-API helpers: user lookup, business ids, create / set
│   │       │                                  password / delete, password validation.
│   │       ├── _taste-profile.js           ← Shared taste-profile → business_taste_profiles row builder.
│   │       ├── save-taste-profile.js       ← Owner-JWT profile write. NOT used by onboarding since 2026-09-24
│   │       │                                  (signup saves the profile); kept for later profile updates.
│   │       ├── set-delivery-mode.js        ← Writes business_v7_settings.delivery_mode (+ Option 2's timeline,
│   │       │                                  normalised); audits; returns the replace-today status.
│   │       ├── update-timeline.js          ← Saves the Option-2 timeline (normalised to current hours; no updated_at
│   │       │                                  bump); audits; returns the replace-today status.
│   │       ├── update-hours.js             ← v7 copy of v6's update-hours + reconciles the timeline (keep clock times).
│   │       ├── save-energy-directions.js   ← Persists Option-1 energy tiers into business_v7_directions.
│   │       ├── save-level-directions.js    ← Persists Option-2 level libraries into business_v7_level_directions
│   │       │                                  (genres re-checked against the profile; stamps profile_key).
│   │       ├── event-chat.js               ← One turn of the v7 special-playlists chat (v7 prompt + "## Today" block);
│   │       │                                  persists to business_event_chats.
│   │       ├── save-event.js               ← "הכן פלייליסט" → business_events row (+ genre_source); 2-per-day cap → 409.
│   │       ├── event-playlist.js           ← Builds a special playlist (genres from the brief or the daily genres, no
│   │       │                                  repeats of today's tracks, expires 04:00). 409 building / 410 expired.
│   │       ├── delete-event.js             ← Card trash: archive + delete the row; playlist deleted now, or handed to
│   │       │                                  the expire cron while a cron runs.
│   │       ├── _special-events.js          ← Shared: cap count, ownership + business name, model-JSON parsing.
│   │       ├── generate-daily.js           ← Today's build: auto-fired after the first-login gate + dashboard
│   │       │                                  "צור פלייליסטים" / "המקום פתוח?" + "החליפו עכשיו" (replaceToday:
│   │       │                                  cap 2/day, old rows hidden as new ones land). 409 if a live set exists
│   │       │                                  (business day) or a build is running. Option 2 → _option2-builder;
│   │       │                                  Option 1 → planOption1 + v6 buildOneDailyPlaylist. Streaming ndjson
│   │       │                                  (v6's contract, slot-N keys, + 'replaced'). 300s maxDuration.
│   │       ├── _option2-builder.js         ← Option-2 timeline builder: window, pool RPC, assembly, Spotify create/add,
│   │       │                                  rows. planOption2Timeline / planFromInputs / createTimelineMix /
│   │       │                                  buildOption2TimelineBatch (cron). Naive fallback if the RPC is missing.
│   │       ├── _replace-status.js          ← "replace today?" eligibility + the 2/day cap.
│   │       ├── _build-lock.js              ← One build at a time per business (Upstash SET NX, fail-open).
│   │       ├── _settings-helpers.js        ← verifyUser / readHours / readSettings / auditSetting.
│   │       └── _daily-builder.js           ← planOption1 (fromNow sizing for replacements) / planOption2 (naive
│   │                                          fallback) + buildOption1Batch / buildOption2Batch. Reuses v6
│   │                                          _daily-builder primitives; v7 directions carry id:null + bpm_range{0,300}.
│   ├── v5/
│   │   ├── anthropic.js                    ← Anthropic Messages API proxy (uses ANTHROPIC_KEY)
│   │   ├── anchor-tracks.js                ← Per-direction random preview track (BPM+popularity filter + inst_pref)
│   │   ├── direction-tracks.js             ← Bulk fetch tracks matching genres + BPM + popularity + inst_pref
│   │   ├── databox-atmospheres.js          ← Reads Supabase atmospheres table (NO CACHE — see optimization notes)
│   │   ├── prewarm.js                      ← Fire-and-forget Postgres plan warmer
│   │   ├── record-playlist.js              ← Writes 24h expiry ledger row (created_playlists)
│   │   └── supabase-client.js              ← pgrRpc/pgrSelect/pgrUpsert/pgrPatch wrappers; RETRIES ON 57014
│   ├── v4/
│   │   ├── ami-*.js                        ← Ami dashboard endpoints (scan, toggle, delete, etc.)
│   │   ├── ami-cron-tick.js                ← Endpoint still exists but REMOVED from vercel.json crons on 2026-08-13.
│   │   │                                      Batch worker was killed; keep the file for future revival.
│   │   ├── ami-atmospheres-scan.js         ← Diffs sheet against Supabase, upserts changes
│   │   ├── ami-track-lookup.js             ← Look up a track (bare id / URL / URI / mobile-share link);
│   │   │                                      reports playlist mappings + the track's full track_analyses row
│   │   │                                      (all typed audio-feature columns, since 2026-09-01)
│   │   ├── ami-track-delete.js             ← Archive a track's rows into `deleted_tracks` then remove live rows
│   │   ├── ami-track-restore.js            ← One-shot restore from the `deleted_tracks` archive
│   │   ├── ami-playlist-lookup.js          ← Sibling of ami-track-lookup for playlist IDs. Handles mobile-share
│   │   │                                      short links (open.spotify.com/s/…) via HTTP redirect-follow.
│   │   │                                      Reports playlist_genres row count, distinct genres, and
│   │   │                                      track_analyses coverage of the playlist's tracks.
│   │   ├── ami-playlist-delete.js          ← Archive every playlist_genres + playlist_tracks row into
│   │   │                                      `deleted_playlists`, then remove live rows. Does NOT touch
│   │   │                                      track_analyses — the audio-features cache is shared across
│   │   │                                      playlists and expensive to rebuild via RapidAPI.
│   │   ├── ami-playlist-restore.js         ← Reverses ami-playlist-delete via the archive row; drops archive after.
│   │   └── ...                             ← Legacy v4 endpoints (openai, spotify, biztype-match, cached-*)
│   ├── new/
│   │   ├── spotify.js                      ← Two-app Spotify proxy (Michael CC reads + Rubin user writes).
│   │   │                                      Resilience layer: 15s per-call timeout, 4xx/5xx body logging,
│   │   │                                      Redis pause switch, daily write counter with threshold alerts.
│   │   └── rubin-oauth-callback.js         ← One-time OAuth seed for RUBIN_REFRESH_TOKEN
│   │   (openai.js, databox.js gitignored — see legacy note below)
│   ├── cron/
│   │   ├── expire-playlists.js             ← Hourly `:30`. Exponential backoff on failure (1h→24h);
│   │   │                                      cluster + chronic alert emails via api/_alert.js. Version-agnostic
│   │   │                                      — sweeps both v6 and v7 expired playlists.
│   │   ├── v7-generate-daily.js            ← Hourly `:00` (the LIVE daily builder since the 2026-09-23 cutover).
│   │   │                                      Filters businesses to version='v7', gates on a business_taste_profiles
│   │   │                                      row + business_v7_settings.delivery_mode, branches option1→buildOption1Batch
│   │   │                                      / option2→buildOption2Batch. Same CRON_SECRET auth + resolveSpotifyBase()
│   │   │                                      + skip guards + pacing as the v6 cron, plus `mode-just-set` (skip
│   │   │                                      15 min after a delivery-mode change — the dashboard builds day 1).
│   │   └── generate-daily.js               ← v6 daily builder. FILE KEPT (revivable; no version filter yet) but
│   │                                          NO LONGER SCHEDULED — removed from vercel.json crons on 2026-09-23 —
│   │                                          and HARD-DISABLED in code (V6_DAILY_CRON_DISABLED, 2026-09-24). All v6
│   │                                          accounts were deleted 2026-09-24 (scripts/purge-v6-accounts.mjs).
│   ├── internal/
│   │   ├── _guard.js                       ← Shared bearer-token guard for the /api/internal/* admin surface
│   │   ├── users.js                        ← GET list of businesses + owner emails (Michael's dashboard)
│   │   ├── business.js                     ← GET one business's full onboarding prompt + directions + playlists + Gemini spend
│   │   └── gemini-spend.js                 ← GET site-wide Gemini cost totals (attributed + abandoned onboarding)
│   (Legacy root proxies openai.js, spotify.js, databox.js, plus
│    api/new/openai.js and api/new/databox.js, exist locally but are
│    GITIGNORED since the 2026-08-22 security-hardening pass — nothing
│    in v4/v5/v6/cron references them; last active callers were the
│    v2/v3 frontends. To re-enable one: `git checkout <old-commit> -- api/<file>.js`
│    then un-ignore it in .gitignore.)
├── docs/
│   ├── v6-reference.md                     ← The v6 documentation moved out of CLAUDE.md on 2026-10-03.
│   ├── admin-api-for-michael.md            ← Instructions Michael feeds his own Claude to build his admin dashboard.
│   │                                          Kept in sync with /api/internal/* endpoint shape.
│   └── playlist-opens-delta.md             ← Focused delta doc for the 2026-08-30 addition of business_playlist_opens
│                                             tracking + the new fields on /api/internal/business.
├── hyp-support/                            ← Gitignored, local only. Request/response logs prepared for Hyp support
│                                              (contain emails + terminal numbers).
├── internal-dashboard/                     ← Gitignored. Local placeholder dashboard for eyeballing
│                                             /api/internal/* responses against `vercel dev`.
│                                             Michael's real dashboard lives in his own repo.
├── scripts/
│   ├── _v7-walkthrough.mjs                  ← v7 Phase A live E2E: onboarding→signup→account. Self-cleaning
│   │                                          throwaway user/business; ~3 Gemini calls + prod writes. Safe vs prod.
│   ├── _v7-phaseb-walkthrough.mjs           ← v7 Phase B live E2E: R1→taste-profile→energy-directions→provision
│   │                                          option1/option2→trigger v7 cron→verify business_playlists+ledger→expiry.
│   ├── _v7-backfill-track-genres.mjs        ← Fill business_playlists.track_genres for v7 playlists built before
│   │                                          2026-09-24. Same attachTrackGenres as live builds. Dry run; --apply writes.
│   ├── test-energy-timeline.mjs             ← Offline tests (node --test) for the Option-2 timeline model, assembler, build window.
│   ├── test-opening-hours.mjs               ← Offline tests (node --test) for shared/opening-hours.js.
│   ├── test-taste-profile-normalize.mjs     ← Offline tests (node --test) for normalizeTasteProfile (level shift, names,
│   │                                          requested genres).
│   ├── test-option1-draw.mjs                ← Offline tests (node --test) for Option 1's daily draw + requested genres.
│   ├── test-il-4am.mjs                      ← Offline tests (node --test) for prevIl4amIso / nextIl4amIso (special-playlists day).
│   ├── test-v7-signup-passwords.mjs         ← v7 passwords: check-email + signup password rules vs `vercel dev`. Self-cleaning.
│   ├── set-v7-passwords.mjs                 ← One-off: shared password for v7 owners created before --before. Dry run;
│   │                                          --confirm applies.
│   ├── _v7-regenerate-level-directions.mjs  ← Option-2 level libraries: list / --generate [--all] (no writes) / --confirm
│   │                                          (replace, Option-2 businesses). Needs vercel dev.
│   ├── _v7-regenerate-energy-directions.mjs ← Regenerate + replace the Option-1 directions of every Option-1 business
│   │                                          with the current prompt (dry run by default; --confirm; needs vercel dev).
│   │                                          Ran 2026-09-28 for the library change.
│   ├── _v7-backfill-requested-genres.mjs    ← Requested genres for accounts from before 2026-10-05 (super-likes from
│   │                                          super_liked_tracks + one Gemini call on the emphases). List / --generate
│   │                                          (no writes) / --confirm. Needs vercel dev + the 2026-10-05 migration.
│   ├── _v7-option2-dryrun.mjs               ← READ-ONLY: print a planned Option-2 day (clock, level, genre, duration per
│   │                                          track) for a fixture or a real business; --at=HH:MM to plan as of a time,
│   │                                          --date=YYYY-MM-DD for another day. Prints each mix's direction per level.
│   ├── _v7-special-playlists-walkthrough.mjs ← Special playlists live E2E (vercel dev, throwaway business, ~2 Spotify playlists,
│   │                                          self-cleaning): chat rules, build, no repeats, cap, delete (now / after crons), 410.
│   ├── _v7-option2-walkthrough.mjs          ← Option-2 live E2E (real Spotify, ~6 playlists, self-cleaning): timeline save,
│   │                                          hours reconciliation, build, replace-today (hide old / keep ledger), lock, cap.
│   ├── _hyp-sign-probe.mjs                  ← Hyp credentials check: signs a payment page on the HYP_ENV terminal and prints
│   │                                          its URL. Nothing charged or written.
│   ├── _hyp-hk-status.mjs                   ← Terminate (or --resume) Hyp recurring agreements by HKId via action=HKStatus.
│   ├── _netlog-extract.mjs                  ← Chrome net-export log → `<log>.extract.txt` with only the Hyp / payment requests
│   │                                          and any 5xx (URL, status, headers; bodies only if recorded with "Include raw
│   │                                          bytes"). Streams the log, so size doesn't matter. --all lists every request.
│   ├── backup-db.mjs                         ← Dependency-free JSON snapshot of v6 prod data via PostgREST (no
│   │                                          Docker/pg_dump, no DB password). Writes backups/db-<ts>/{json,restore.sql,
│   │                                          manifest.json,auth-users.json}. Skips the heavy track-analysis catalog.
│   │                                          backup-db.ps1 is the PowerShell wrapper. backups/ is gitignored (PII).
│   ├── benchmark-directions.mjs            ← OpenAI vs Anthropic timing/quality benchmark
│   ├── purge-rubin-playlists.mjs           ← Unfollow all Rubin playlists (source: created_playlists ledger)
│   ├── purge-pre-cron-playlists.mjs        ← Unfollow Rubin playlists NOT dated today (source: GET /me/playlists).
│   │                                          Requires playlist-read-private scope on the refresh token.
│   │                                          Default dry-run; 2s inter-call pacing; per-line timestamped logs.
│   ├── purge-users.mjs, purge-users-except.mjs ← Tear down test users end-to-end (find playlists via the legacy user_metadata)
│   ├── purge-v6-accounts.mjs                ← Delete every account whose businesses are all v6: live playlists expired NOW via the
│   │                                          expire cron on vercel dev, then businesses (CASCADE) + auth users. Dry run by default;
│   │                                          --confirm. Ran 2026-09-24 (17 accounts; backup first: backups/db-2026-09-24T13-05-59, local only).
│   ├── migrate-directions-to-table.mjs     ← Backfill business_directions from historical business_playlists.expansion
│   ├── migrate-user-metadata-to-tables.mjs ← Backfill per-business tables from legacy user_metadata blobs
│   ├── test-super-liked-tracks.mjs         ← Integration test for the super-like DB path
│   ├── test-instrumentalness-preference.mjs ← Integration test for the 3-state inst_pref RPC behavior
│   ├── test-cron-daily-guards.mjs          ← Integration test for the past-close + anyBuiltToday guards
│   ├── test-rubin-spotify.mjs              ← Live probe: refresh Rubin token + create + unfollow a throwaway playlist
│   ├── test-michael-spotify.mjs            ← Live probe: Michael's CC token still has grandfathered read access
│   ├── test-anchor-removal.mjs             ← Regression: v5_anchor_tracks behavior after the anchor concept was dropped
│   ├── test-gemini.mjs                     ← Sanity ping against /api/v6/gemini
│   ├── test-resilience-layer.mjs           ← Unit-level tests for Aug 29 resilience layer (Redis pause + backoff + counter + Resend, opt-in --send-alert)
│   ├── test-resilience-http.mjs            ← HTTP tests against vercel dev: pause switch 503, 4xx body log, cron endpoints alive
│   ├── test-cluster-failure-alert.mjs      ← Forces 3 expire failures to exercise the cluster alert email end-to-end
│   ├── check-duplicate-users.mjs           ← Reports exact-email dupes (should be 0) + Gmail alias collisions
│   ├── check-prompt-genres.mjs             ← Diffs the EDITABLE_PROMPT_SECTION genre list against the canonical genre-list.js
│   ├── _verify-genre-refactor.mjs          ← 2026-09-23 sanity check: compares in-tree GENRE_UNIVERSE_SECTION against
│   │                                          git HEAD's inlined v5/v6 versions. Kept for future genre-list edits.
│   ├── post-deploy-health.mjs              ← Post-deploy sanity: cleanup ledger + daily-gen output + Redis state
│   ├── cleanup-orphaned-playlists.mjs      ← One-off (2026-08-27): direct-Spotify cleanup for the Aug-22 141-row backlog
│   ├── build-today-oneoff.mjs              ← One-off (2026-08-27): manually build today's daily playlists during the kill-switch window
│   ├── feedback-*.js / feedback-*.sql      ← V1/V2-era legacy. `feedback-system.js` / `-mirror.js` / `-dynamic.js`
│   │                                          are `index.html`-patching installers for a pre-v4 UI's feedback
│   │                                          system (thumb-down banlist → dynamic learned_insights). Not called
│   │                                          by anything in v4/v5/v6. Kept in-tree for now; candidate for `git rm`.
│   ├── mirror-vercel-deployment.mjs        ← Pull deployment source via Vercel API
│   └── mirror-live-site.mjs                ← Pull deployed static assets via HTTP
├── benchmark-results/                      ← JSON outputs from benchmark script
├── prompt-history.md                       ← Audit log for v6 EDITABLE_PROMPT_SECTION changes
├── prompt-history-v7.md                    ← Audit log for v7 prompts (R1, R2, taste-profile)
├── tests/                                  ← Legacy test scripts (mostly v3/v4 era)
├── .env.local                              ← Gitignored. Has ANTHROPIC_KEY, GEMINI_API_KEY, RUBIN_*, SUPABASE_*,
│                                              UPSTASH_REDIS_REST_KV_REST_API_URL/TOKEN, INTERNAL_API_KEY,
│                                              INTERNAL_ADMIN_API_KEY, CRON_SECRET, TRACK_ANALYSIS_*,
│                                              SUPABASE_AUTH (Resend key — see "Alerts via Resend"),
│                                              ALERT_EMAIL_FROM / ALERT_EMAIL_TO (optional overrides)
├── vercel.json                             ← Function timeouts, cron schedule (two: expire + generate-daily),
│                                              rewrites (incl. `/` → `/v7/index.html`), security headers
└── CLAUDE.md                               ← This file
```

---

## KEY MECHANISMS (shared by v6 and v7)

v6-only mechanisms (the onboarding state machine, prefetching, the progressive swipe deck, the playback bar, the v6 musical directions + Round 2, and the v6 daily cron) are in [docs/v6-reference.md](docs/v6-reference.md).

### Genre list — `shared/genre-universe.js`

Shared canonical menu, currently 124 entries. As of 2026-09-23 the list lives in **`shared/genre-universe.js`** — one source of truth. Every consumer (v5 / v6 / v7 musical-directions.js, v6/generation/genre-list.js, transitively the v6 + v7 event-playlist classifier prompts and the direction-edit chat prompt) imports or re-exports from there. Kept in sync with the exact strings stored in `playlist_genres.genre` in Supabase — the RPCs lowercase-match. Grew from 73 → 105 across 2026-08 as Ami added new genres to Data Box Tab 2 and RapidAPI batch runs digested their seed playlists into `track_analyses`. Late-Aug / early-Sep churn: `Latin Funk` and `Greek Funk` added (Greek Funk seeded from the 2 world-funk playlists that got reassigned during the world-funk purge); `World Funk` and `Brit Funk` fully removed from the DB (playlists + exclusive tracks purged); `Thai Molam Funk` renamed to `Thai Molam` to match Ami's sheet update; `Alternative R&B`, `Hawaii ukulele music`, `Musica Tropical` added on 2026-09-02 after their sheet seeds digested cleanly. **2026-09-26** — 8 more added after clean Round 1 + Round 2 digestion: `Afro Cuban Jazz`, `Doo-Wop`, `Electronic R&B`, `French Touch`, `Italian Folk`, `Mo Town`, `Soft Pop Hits`, `Surf Rock` (4,390 total OK tracks across the group). See § PROMPT EDITING PROTOCOL for the current invariant.

### Playlist auto-expiry

Every playlist created via `/api/new/spotify` create_playlist gets a row in
`created_playlists` (`spotify_id`, `name`, `expires_at`, `deleted_at`,
`error`, plus `attempts`, `last_error`, `next_attempt_at`, `alerted_at`
added 2026-08-29). Hourly cron `/api/cron/expire-playlists` (scheduled
`30 * * * *`) picks up eligible rows and unfollows on Rubin's side
(rename → empty → unfollow → mark `deleted_at`; unrecoverable errors
treated as already-gone via `isGone` — currently 404, 410, and 400 with
"Invalid base62 id" — see [api/v6/account/_expire-playlist.js](api/v6/account/_expire-playlist.js).
The 400-branch was added 2026-09-04 after a leaked test-fixture row with
a bogus spotify_id sat in backoff for a day and fired a chronic alert;
without it, an unparseable id would loop forever since a 400 for "invalid
id" is not transient).

**Eligibility**: `deleted_at IS NULL AND expires_at <= now() AND
(next_attempt_at IS NULL OR next_attempt_at <= now())`. The
`next_attempt_at` gate is what makes the exponential backoff work.

**Retry model (exponential backoff, added 2026-08-29)**:
On failure, `attempts` is incremented and `next_attempt_at` is set to
`now() + backoff(attempts)` where:
`attempts=1 → +1h, 2 → +2h, 3 → +4h, 4 → +8h, 5 → +16h, 6+ → capped +24h`.
Rows are NEVER permanently abandoned — we back off but keep trying until
either the Spotify call succeeds or the playlist entity is gone (isGone
→ mark deleted_at). This is what stops the tight every-hour re-loop that
caused the 141-row backlog after Aug 22.

**Alerts**:
- Chronic failure — when a row transitions to `attempts >= 5` (~15h of
  consecutive failure), one alert email fires per row via `alerted_at`
  guard (never re-fires for the same row lifetime).
- Cluster failure — if 3+ consecutive playlists fail in a single tick,
  one alert email fires immediately with the failure list. Catches
  broad Spotify-side incidents within the hour they start.

Two different expiry regimes feed into that one cron:

- **Daily playlists** (onboarding-day expansion + `/api/cron/generate-daily`)
  expire **2h after that day's closing time in Asia/Jerusalem**. Different
  each day if the venue's hours differ. Computed via
  `dailyPlaylistExpiryIso({ hours })` in [v6/generation/playlist-length.js].
  DST-safe; handles overnight-wrap (close ≤ open).
- **Event playlists** and **closed-day playlists** (both the manual
  "המקום פתוח?" flow and the rare onboarding-on-a-closed-day fallback)
  expire at the **next 04:00 Asia/Jerusalem** — one-off items kept visible
  through the night but swept before the following morning. Helper:
  `nextIl4amIso()` in [v6/generation/playlist-length.js].

`business_playlists.expires_at` mirrors the ledger `expires_at` and drives
dashboard visibility. Both account apps read it into each playlist's
`expiresAt` (ms), and `playlistIsLive(p)` filters expired entries out of the
render loop, `hasPlaylistsForToday()`, and `activePlaylistForEvent()`. Missing
`expiresAt` is treated as live (backward-compat for pre-per-day entries; the
cron still cleans them up on their old 24h clock). Before the per-business
tables, the same field lived in the legacy `user_metadata` blob (see
docs/v6-reference.md).

### Auth email — custom SMTP via Resend + robin-music.com

Supabase Auth's built-in email sender is rate-limited hard (~3/hour per
project on defaults) and lands in spam. Configured 2026-08-20/21 to
send magic-link emails from a `robin-music.com` sender via Resend SMTP.

- **Sender**: `send.robin-music.com` DKIM/SPF/DMARC configured at GoDaddy
  → verified in Resend. From-address example: `noreply@robin-music.com`.
- **SMTP config**: entered in Supabase Dashboard → Auth → SMTP Settings.
  Resend API key (from the Resend dashboard) is the SMTP password.
- **App-side**: no code change. `sb.auth.signInWithOtp({email, options:
  {emailRedirectTo: ...}})` in `v6/account/app.js` (the login flow) and
  the admin `generate_link` call in `api/v6/account/signup.js` both go
  out via whatever SMTP Supabase is configured to use.
- **Resend account**: separate login, owned by Roni. API key stored in
  Supabase Auth SMTP settings AND mirrored to `.env.local` + Vercel env
  as `SUPABASE_AUTH` (the historical name — see "Alerts via Resend"
  mechanism below). Our own code reads it via `SUPABASE_AUTH` for
  operational alert emails; Supabase Auth reads its own copy via SMTP.
- **Verification records to keep green** in GoDaddy DNS: TXT + CNAME
  records Resend auto-generates during setup. If any go red, emails
  land in spam and Supabase auth flows silently degrade.

### Rate limiting (`api/v6/ratelimit.js`, Upstash Redis)

Added during the 2026-08-22 security audit. Zero-dependency fixed-window
counter backed by Upstash Redis REST. Import + guard at the top of any
handler:

```js
import { guard } from '../v6/ratelimit.js';
if (!await guard(req, res, 'anthropic', 10, 60)) return; // 10/min per IP
```

**Current guards** (bucket name / limit / window seconds):
- `/api/v5/anthropic` — 10/min
- `/api/v6/gemini` — 20/min
- `/api/v5/anchor-tracks`, `direction-tracks`, `databox-atmospheres` — 60/min
- `/api/v5/prewarm` — 30/min
- `/api/v5/record-playlist` — 30/min
- `/api/new/spotify`, `/api/v4/spotify` — 60/min
- `/api/v6/account/signup` — 20/hour (per IP; abuse-mitigation). `/api/v7/account/signup` uses the SAME `signup` bucket, so v6 and v7 signups share one per-IP counter.
- `/api/v6/account/direction-chat` — 20/min (profile-tab chat turn)
- `/api/v6/account/event-chat` — 20/min (events-tab chat turn)
- `/api/v6/account/preview-direction` — shares the `anchor-tracks` bucket (60/min)
- `/api/v6/account/apply-direction-change` — 10/min (commits add/edit/remove)
- `/api/v6/account/toggle-super-like` — 60/min (super-like button toggle in the preview modal)
- `/api/v6/account/log-playlist-open` — 120/min (dashboard "▶ פתח" click log; higher than other write endpoints because bursty clicking through several playlists is legitimate)
- `/api/v7/account/update-timeline` (`v7-update-timeline`), `/api/v7/account/update-hours` (`v7-update-hours`), `set-delivery-mode` — 20/min
- `/api/v7/account/generate-daily` (`v7-generate-daily`) — 12/hour, plus a per-business build lock and the 2/day replace cap
- `/api/v7/account/save-energy-directions` (`save-energy-directions`), `/api/v7/account/save-level-directions` (`save-level-directions`), `/api/v7/account/save-taste-profile` (`save-taste-profile`) — 20/min
- `/api/v7/account/check-email` (`v7-check-email`) — 20 per 10 min (it reveals whether an email is registered)
- `/api/v7/payment/checkout` (`v7-checkout`) — 30/min; its coupon check `GET ?coupon=` (`v7-coupon-check`) — 30/min; `/api/v7/payment/status` (`v7-payment-status`) — 120/min; `/api/v7/payment/return` (`v7-payment-return`) — 60/min
- `/api/v7/ami/test-playlist` POST (`ami-test-playlist`) — 40/hour; its GET cron-status check (`ami-test-playlist-status`) — 120/min
- `/api/v7/account/event-chat` (`v7-event-chat`) — 20/min; `save-event` (`v7-save-event`) — 20/min; `event-playlist` (`v7-event-playlist`) — 20/hour; `delete-event` (`v7-delete-event`) — 30/min. On top of that, special playlists are capped at 2 per business per day

**Behavior notes:**
- Keyed by client IP (via `x-forwarded-for` first-hop, `x-real-ip`, or
  socket address as fallback).
- **Internal callers bypass** — server-to-server calls carrying a valid
  `x-sonic-internal: ${INTERNAL_API_KEY}` header skip the limiter,
  otherwise every internal call from our own Vercel functions would
  share one egress IP and starve legitimate user traffic.
- **Fail-open** on any Upstash outage / missing env — a rate limiter
  that 500s the whole site during a Redis blip is worse than one that
  briefly stops enforcing. Logs `[ratelimit] ... not set — rate limiting
  DISABLED` once at cold start so the misconfiguration is loud.

**Env** (Vercel's Upstash integration writes them under the awkward
double-prefix; mirror to `.env.local` for `vercel dev`):
- `UPSTASH_REDIS_REST_KV_REST_API_URL`
- `UPSTASH_REDIS_REST_KV_REST_API_TOKEN`

### Spotify resilience layer (`api/new/spotify.js`)

Added 2026-08-29 after the Aug 22 QUOTA_EXCEEDED incident. Four defenses
layered into the proxy:

1. **Per-call 15s timeout** via `AbortController`. Prevents a single hung
   Spotify call (Aug 7 style 504 cascade) from eating the whole 30s
   function budget. On timeout, returns synthetic 504.
2. **Response-body logging** on every Spotify 4xx/5xx. Logs the response
   body (500 char cap) plus the parsed `error.reason` field so the next
   incident isn't a guessing game. This was the missing visibility that
   let Aug 22 escalate silently.
3. **Global pause switch** backed by Redis key `spotify:pause_until`
   (epoch-ms value). Set automatically by the proxy on:
   - Any `429` with `Retry-After ≥ 30s` → pause for the Retry-After duration
   - Any `403` with `reason=QUOTA_EXCEEDED` → 6h pause (Retry-After is often
     absent or unhelpfully large for QUOTA_EXCEEDED)
   Every subsequent user-token call short-circuits with `503 { error:
   'spotify_paused' }` until the key expires. Check-before-set ensures a
   short 429 pause can't overwrite a long QUOTA pause. Fires one alert
   email per pause event. The `_daily-builder.js` and `playlist-builder.js`
   retry loops both recognise the `spotify_paused` marker and NEVER retry
   it — that's what prevents the escalation loop that made Aug 22 worse.
4. **Daily write counter** — Redis `spotify:writes:YYYY-MM-DD` (IL date).
   Increments on every successful user-token write. Alerts once at 500
   (soft) and once at 800 (hard). Exact-equality trigger prevents storming
   under concurrent load.

Pause / counter checks are BYPASSED for CC-token reads (Michael's app is
on a separate quota bucket and hasn't been the source of any block).

### Alerts via Resend (`api/_alert.js`)

Email helper for operational alerts. Delivered via Resend's REST API.
Fail-open — a missing key or Resend outage logs one warning and returns
`{ok:false}` without throwing, so a broken alert never takes down the
caller.

**MUST-AWAIT rule (2026-08-29 lesson):** Vercel serverless freezes the
function process the moment `res.end()` is called. A fire-and-forget
`sendAlert(...).catch(() => {})` never gets to complete the fetch to
Resend — the request is cut mid-flight. Every caller MUST await the
send before returning:
- In per-request handlers (setPause, incrDailyWrites) → `await sendAlert(...)`.
- In loops that may fire many alerts (cron expire) → push each promise
  into `alertPromises[]` and `await Promise.allSettled(alertPromises)`
  before `res.status(200).json(...)`.

This was the actual root cause of the "cluster alert never arrived" bug
we chased for a day. If you add a new alert trigger, follow the pattern.

**Env**:
- `SUPABASE_AUTH` — Resend API key. Named `SUPABASE_AUTH` because it was
  originally added for Supabase's SMTP magic-link config (see the "Auth
  email" section above). Our alert helper reads the same value.
- `ALERT_EMAIL_FROM` (optional) — defaults to `noreply@robin-music.com`
- `ALERT_EMAIL_TO`   (optional) — defaults to `roni.mark@gmail.com`

**Current alert triggers**:
- Spotify pause switch engaged (from the proxy on 429/403)
- Cron expire: 3+ consecutive failures in one tick (cluster alert)
- Cron expire: single row hitting `attempts >= 5` (chronic alert, once
  per row lifetime via `alerted_at` guard)
- Daily Spotify write count crossing 500 (soft) or 800 (hard)
- Cron daily-gen: top-level `pgrSelect('businesses')` fails (every
  occurrence — means zero builds fleet-wide this tick)
- Cron daily-gen: aggregate per-tick email listing businesses that hit
  alertable skip reasons (added 2026-09-03). Persistent-state reasons
  (`bad-hours` / `no-hours` / `no-directions` / `zero-built`) are deduped
  once per (business, reason, IL-date) via Redis key
  `alerted:daily-gen:<biz>:<reason>:<il-date>` with 26h TTL — so a broken
  owner state generates one email per day, not one per hour. Exception
  reasons (`build-failed` / `outer-throw`) fire on every occurrence since
  they may recover next tick. `zero-built` is a derived signal: cron
  passed every skip guard, called `buildDailyBatch`, and every direction
  failed after retries — distinct from `no-directions` (never even tried).
  Normal skips (`not-onboarding-done` / `closed-today` / `past-close` /
  `already-built-today` / `too-early`) are silent.

**Debugging the alert pipe** — `/api/alert-probe` (CRON_SECRET-gated).
`GET` reports `{ env_present, from, to }` — tells you whether
`SUPABASE_AUTH` is visible inside the running function process (Vercel
env vs `.env.local` gotcha: `vercel dev` reads from Vercel cloud env,
so a var only in `.env.local` will show `env_present: false` and every
alert will silently fail-open). `POST` does a real send through the
shared `sendAlert` helper and returns `{ env_present, sent, reason? }`.
Use this after any env-var change before trusting cron alerts to arrive.

### Instrumentalness preference (`instrumentalness_preference`)

Added 2026-08-21. Three-state enum threaded through prompt → per-direction
JSON → RPC → business_directions column → daily-gen / expand / event
downstream. Values: `'none' | 'soft' | 'hard'`.

**Classification (Gemini's job).** The Musical Emphases sub-rule in
`EDITABLE_PROMPT_SECTION` instructs Gemini to read the emphases text and
set `instrumentalness_preference` on every direction:
- `'hard'` — "only instrumentals" / "no vocals" / "רק אינסטרומנטלי" /
  "בלי שירה". Excludes vocal tracks entirely from the pool.
- `'soft'` — "prefer instrumentals" / "a lot of instrumentals" / "יותר
  אינסטרומנטלי" / "פחות שירה". Biases toward instrumentals but keeps
  some vocals if the instrumental pool is thin for that direction.
- `'none'` — emphases doesn't mention instrumentals (default).

Explicit prompt instruction: Gemini's genre CHOICES do NOT change based
on this preference. Genres are still picked purely on the venue's vibe.
The DB layer is what actually delivers the filter/bias.

**Enforcement (SQL).** All three v5/v6 track-fetch RPCs accept an
`inst_pref` / `p_inst_pref` parameter (default `'none'`):
- `'hard'` adds `AND ta.instrumentalness >= 85` to the WHERE clause.
- `'soft'` adds `(inst_pref='soft' AND coalesce(ta.instrumentalness,0) < 85)::int`
  as the primary ORDER BY key (before `random()`), so instrumentals sort
  ahead of vocals in the random draw. Vocals only fill in when the
  instrumental subset is thin.
- `'none'` unchanged — pure `random()`.

**Threading path.** Emphases text (step 3) → Gemini (step 4) →
per-direction `instrumentalness_preference` in the response → normalized
by `normalizeDirections` → passed to `fetchAnchorTracks` (per-spec
`inst_pref` inside the `p_specs` jsonb) and `fetchDirectionTracks`
(top-level `instrumentalness_preference` body field) → forwarded by the
`/api/v5/anchor-tracks` and `/api/v5/direction-tracks` proxies to the
RPCs → persisted at signup into `business_directions.instrumentalness_preference`
→ read back by `activeDirections()` in `_daily-builder.js` and by
`expand-playlist.js`'s business_directions SELECT → forwarded on every
subsequent daily-gen / expand call so the preference persists for the
life of the business.

Backward-compat: default `'none'` on both the column and the RPC param,
so anything pre-2026-08-21 keeps behaving exactly as before. Event
playlists (chat-created) always pass `'none'` — their description comes
from the chat, not from onboarding emphases.

Integration test: `scripts/test-instrumentalness-preference.mjs`.

### Popularity preference (`popularity_preference`)

Added 2026-09-02. Same shape as `instrumentalness_preference` (three-state enum
`'none' | 'soft' | 'hard'` threaded through prompt → per-direction JSON → RPC →
`business_directions` column → daily-gen / expand / chat-edit downstream), but
with two meaningful differences from the instrumentalness rule:

1. **Gemini's genre choices ARE affected.** When set to `hard` or `soft`,
   Gemini also biases which GENRES it picks — skewing away from esoteric /
   niche-only genres (Peruvian Chicha, Anatolian Psychedelic Rock,
   Tishoumaren, Dabke, Neo Exotica, Ethio-Jazz, Rebetiko, Laiko, Turk
   Arabesk, Medieval Music, Piano Impressionism) and leaning toward
   hit-friendly catalogs (Modern Pop, 80s Pop, 90's pop party, Rock, Hip
   Hop, RnB, Funk, Disco, Indie Rock, Bossa Nova, Jazz (Standards)).
2. **Per-direction schema.** Unlike inst_pref (which R1/R2 stamp uniformly
   on every direction), popularity_preference is per-direction. Gemini
   still DEFAULTS to uniform across all directions, but MAY vary it per
   direction if the emphases text explicitly asks for time-of-day or
   context-based variance ("hits during lunch, deeper cuts in the
   evening").

**Classification (Gemini's job).** The "Popularity preference (special
sub-rule)" in `PROCESSING_RULES_SECTION` (shared with R2 via import)
instructs Gemini:
- `'hard'` — "only hits" / "well-known only" / "רק להיטים" / "רק שירים מוכרים".
- `'soft'` — "mostly hits" / "יותר להיטים" / "בעיקר מוכרים".
- `'none'` — no mention (default). Also correct if the user asks for the
  OPPOSITE (deep cuts, lesser-known) — that's what the atmosphere-derived
  popularity window delivers when unmodified.

**Enforcement (SQL).** All three RPCs (`v5_anchor_tracks`,
`v5_direction_tracks`, `v6_direction_tracks_recent`) accept `pop_pref` (per
spec on `v5_anchor_tracks`) / `p_pop_pref` (top-level on the other two).
Default `'none'`.
- `'hard'` OVERRIDES the popularity WHERE window to `BETWEEN 60 AND 100`
  regardless of the atmosphere-derived `popularity_window` passed by the
  caller.
- `'soft'` keeps the atmosphere window in WHERE (candidate pool stays
  wide), and adds `(pop_pref='soft' AND coalesce(ta.popularity,0) < 60)::int`
  as an ORDER BY key so tracks with popularity ≥ 60 surface first;
  deep cuts fill in when the hit pool is thin.
- `'none'` — unchanged (atmosphere window applies as before).

**Threading path.** Same shape as instrumentalness — emphases text →
Gemini → per-direction `popularity_preference` in the response →
`normalizeDirections` → threaded through `fetchAnchorTracks` (per-spec
`pop_pref` inside `p_specs`) and `fetchDirectionTracks` (top-level
`popularity_preference` body field) → forwarded by `/api/v5/anchor-tracks`
and `/api/v5/direction-tracks` proxies → persisted at signup into
`business_directions.popularity_preference` → read back by
`activeDirections()` and by `expand-playlist.js`'s SELECT → forwarded
on every daily-gen / expand call so the preference persists for the life
of the business until the owner overrides it via the direction-edit chat.

**Direction-edit chat (post-signup owner control).** The chat prompt
teaches the model to detect natural-language asks like "תעשה את הכיוון
הזה יותר להיטי" / "add some deeper cuts here" and emit an edit proposal
with `popularity_preference`. `preview-direction`, `apply-direction-change`,
and `direction-chat.js`'s `mergeUpdates` / `sanitizeUpdates` all handle
the field the same way they handle `instrumentalness_preference`. The
Exposure rules forbid quoting the enum values or the numeric window —
talk in feel ("יותר שירים מוכרים", "פחות מיינסטרים, יותר גילויים").

**Backward-compat.** Default `'none'` on both the column and the RPC
params. Anything pre-2026-09-02 keeps behaving exactly as before. Event
playlists (chat-created via the event chat) always pass `'none'`.

**Migration:** `v5/precompute/migrations/2026-09-02-direction-popularity-preference.sql`
adds the column + CHECK constraint. Idempotent. Code was written null-tolerant
(`|| 'none'` throughout), so it can ship before the migration runs; running
the migration afterward is a no-op for existing rows.

Integration test: `scripts/test-popularity-preference.mjs`.

### Cross-day track dedup (`v6_daily_track_history`)

To prevent the same tracks appearing in a business's daily playlists day
after day, every serve is recorded in `v6_daily_track_history (business_id,
direction_key, spotify_id, served_at)`. Direction key is a lowercase-sorted
join of the direction's `genres` list plus BPM range, e.g.
`bossa nova|french jazz|jazz (standards)|85-115` — see `directionKey()` in
[v6/generation/playlist-length.js]. On the next build for that (biz, dir),
`v6_direction_tracks_recent` RPC excludes tracks served within the last 7
days. Pool-shortage fallback: if the filtered pool comes back short, caller
retries with `p_exclude_days=0` and merges — playlists always hit target.

Historical note: pre-2026-08-13 keys were `${anchor_genre}|${bpm_min}-${bpm_max}`
(anchor genre only, before the anchor concept was removed). Post-refactor
lookups don't match those old rows — expect a few days of possible track
repeats before the new-format history fills in.

Applies to auto daily-gen (cron), closed-day manual "המקום פתוח?" flow,
and the onboarding-day sample expansion. Event playlists are NOT deduped
(one-off, different genre pool anyway).

---

## DATA MODEL

The legacy `auth.users.raw_user_meta_data.sonic` blob (v6, before the per-business tables) is documented in [docs/v6-reference.md](docs/v6-reference.md).

### Supabase tables

**Reference / catalog (populated by Ami's scans + precompute):**
- `atmospheres` — { name, ranges, row_in_sheet }. Populated by Ami's scan endpoint.
- `biztype_genres` — { business_type, genre, column_letter, position_in_column }. Ami's other scan.
- `playlist_genres` — playlist_id ↔ genre + position_in_genre.
- `playlist_tracks` — playlist_id ↔ spotify_id + position.
- `track_analyses` — spotify_id + typed audio-feature columns (tempo, popularity, energy, `instrumentalness`, valence, etc.) + raw_analysis jsonb.

**Per-business production data (owned by v6 signup + dashboard):**
- `businesses` — { id, owner_id, name, monthly_credits, credits_remaining, business_description, musical_emphases, onboarding_expanded, **version** (`'v6'` default | `'v7'`, added 2026-09-23), **paid_at** (timestamptz, added 2026-09-23) }. Written by signup. `business_description` + `musical_emphases` are the free-text prompt inputs the owner typed during onboarding (bizDesc + step-3 emphases); added 2026-08-23 for the internal admin API. PATCH path in signup.js skips blank values so repeat-onboarding with an empty field doesn't clobber a previously-recorded prompt. **`version`** gates which daily cron targets the business (v6 cron shut off; v7 cron filters `version='v7'`); **`paid_at`** is set on the v7 signup path only (the Hyp payment time from `payment_checkouts.paid_at`; `now()` for internal test signups) and never cleared.
- `business_directions` — permanent per-business direction storage. Columns: { id, business_id, rank, title_en, description_he, genres (jsonb), bpm_range (jsonb), popularity_window (jsonb), **instrumentalness_preference** (`'none'|'soft'|'hard'`, added 2026-08-21), **popularity_preference** (`'none'|'soft'|'hard'`, added 2026-09-02), active (bool, soft-disable), created_at, updated_at }. Added 2026-08-20 migration — replaced the fragile "reconstruct directions from recent playlist_playlists.expansion" approach that cascaded to zero when the cron partially failed. Now the source of truth for daily-gen; `activeDirections(bizId)` in `_daily-builder.js` reads from here.
  - **8-active cap enforced by DB trigger** (`business_directions_cap`, added 2026-08-29). BEFORE INSERT OR UPDATE, per-business advisory-lock + count-active, raises `check_violation` if the write would push active count > 8. Closes the TOCTOU race in apply-direction-change's app-level check and rejects crafted signup payloads. Signup.js still trims client-side to the first 8 so a legitimate 8-pick onboarding never hits the trigger; apply-direction-change still returns its own friendly `cap_reached` code before the trigger fires so end-users see a nice message rather than a raw exception. Trigger is the last-line defense. See `v5/precompute/migrations/2026-08-29-directions-cap-trigger.sql`.
- `business_playlists` — one row per built Spotify playlist (onboarding sample, expanded daily, cron-generated daily, or event). Columns include { spotify_id, business_id, url, label, ico, track_count, genres, bpm_range, expansion (jsonb, legacy), event_id (nullable back-ref), direction_id (nullable FK → business_directions), track_ids (jsonb, ordered), **track_genres** (jsonb, v7 only — see below), expanded_at, expires_at, created_at }. Nothing deletes rows — `expires_at` gates dashboard visibility only. **This table is the permanent record of every playlist a business was ever served, with its tracks** (v6 and v7 alike): after expiry the Spotify playlist itself is emptied, so `track_ids` here is the only surviving record of its contents. Deleting the business (e.g. `scripts/purge-users.mjs`) takes these rows with it — run `scripts/backup-db.mjs` first if the history matters.
- `business_hours` — one row per business: { business_id, hours (jsonb — 0..6 day map with `{open,close,closed}`), longest_minutes, updated_at }. Upsert on business_id.
- `business_place` — one row per business (Google Places snapshot): { business_id, place_id, name, address, primary_type, types, editorial_summary, price_level, website_uri, vibe (jsonb), updated_at }. Upsert on business_id.
- `business_events` — { id, business_id, name, description, created_at, **genre_source** (`'daily'|'event'`, v7, added 2026-10-03 by migration `2026-10-03-v7-event-genre-source.sql`; NULL = `'event'`) }. Owner's chat-generated one-off event descriptions. In v7 each row is one special playlist for its day (04:00 → 04:00 IL): the card is hidden after that, but the row stays as history.
- `super_liked_tracks` — { id, business_id, spotify_id, created_at, deleted_at (nullable, added 2026-09-05), UNIQUE(business_id, spotify_id) }. Persisted at signup from `state.superLikedTracks`; also topped up by the direction-edit preview modal when the owner taps super-like on a track. Nothing consumes yet — captured for future taste-tuning. **Soft-delete via `deleted_at`**: un-super-liking sets `deleted_at = now()` rather than removing the row (so a track's engagement history isn't lost even if the owner toggles it off). Re-super-liking clears `deleted_at` back to NULL via the upsert path. Future readers should filter `deleted_at IS NULL` to see "currently super-liked."
- `business_playlist_opens` — { id bigserial, business_id, spotify_id, source ('home-daily' | 'home-event' | future), opened_at }. Append-only engagement log. One row per dashboard "▶ פתח" click. Not FK'd to `business_playlists` (matches `super_liked_tracks` pattern) — join manually on `spotify_id` when analyzing. `business_playlists` rows are never deleted (only `expires_at`-gated), so a click yesterday still resolves to its direction / genres / track_ids today. Client writes via fire-and-forget `POST /api/v6/account/log-playlist-open`; navigation to Spotify is never blocked on the write. Added 2026-08-26.
- `business_direction_chats` — { id, business_id, role ('user'|'assistant'), content (raw JSON for assistant / plain text for user), proposal (jsonb — parsed structured payload attached to an assistant turn: `{kind, direction_id?, updates?, spec?}`), selected_direction_id (nullable FK, which card the owner had selected when they sent this), created_at }. Rolling per-business message log for the profile-tab direction-edit chat. Client renders the transcript on tab open; server loads the tail (last 40) as Gemini chat history each turn.
- `business_direction_changes` — { id, business_id, direction_id (nullable — null when the pre-insert direction hasn't landed yet), kind ('add'|'edit'|'remove'), before (jsonb direction snapshot), after (jsonb direction snapshot), message_id_first, message_id_last (nullable FKs into business_direction_chats — the message range that produced this change), playlist_action ('rebuilt'|'expired'|'kept'|'renamed'|null), applied_at }. Written by `/api/v6/account/apply-direction-change` on every commit; surfaced by the internal admin API as the audit feed per business. `'renamed'` was added 2026-09-02 for the cosmetic-only edit fast path (title / description-only chat edits) — see the migration `2026-09-02-direction-changes-renamed-action.sql`.
- `business_settings_changes` — { id bigserial, business_id, field (text — `'name'` or `'hours'`), before (jsonb), after (jsonb), changed_at }. Audit log for business-level settings that upsert in-place (i.e. don't produce a versioned history on their own). Written by `api/v6/account/update-business-name.js` and `api/v6/account/update-hours.js` on every non-no-op save. `field` is free text (no CHECK-enum) so future settings can join without another migration; for `'name'` the before/after are JSON-quoted strings, for `'hours'` they're `{hours, longest_minutes}` objects. Added 2026-09-05 (migration `2026-09-05-owner-change-history.sql`).
- `business_event_chats` — { id, business_id, role ('user'|'assistant'), content (raw JSON for assistant / plain text for user), proposal (jsonb — `{name_he, description_he}` on confirming assistant turns, plus `genre_source` from v7's chat; null otherwise), event_id (nullable FK → business_events; backfilled by v6's `upsert-event.js` / v7's `save-event.js` when the chat produces a saved event), created_at }. Rolling per-business message log for the special-events chat on `/v6/account` and `/v7/account`. Written by `POST /api/v6/account/event-chat` and `POST /api/v7/account/event-chat`. Client's on-screen transcript still resets to empty on hard refresh / after finalize — a client `SESSION_START_AT_ISO` gates both what the browser shows AND what the server includes in Gemini's context. Persistence is orthogonal (every turn logged for admin visibility regardless of what the client displays). Added 2026-08-30 (migration `2026-08-30-event-chat.sql`).

**v7 production data (owned by v7 signup + account; migration `2026-09-23-v7-tables.sql`, RUN):**
- `business_taste_profiles` — one row per v7 business (PK `business_id`). The flat, full-catalog taste profile produced by `v7/generation/taste-profile.js` and persisted by `signup.js` at onboarding (before the verification email goes out). Columns: { business_id (uuid PK), energy_levels_total (int 2..6), approved_genres (jsonb — [{genre, energy_level}]), conditional_genres (jsonb — [{genre, energy_level, note_en}]; **DATA ONLY, builders ignore it**), excluded_genres (jsonb — [string]), instrumentalness_preference (text), popularity_preference (text), reasoning_en (text), audit_tally (jsonb, analytics), **requested_genres** (jsonb — [string], the genres Option 1 puts in every playlist of their tier), **super_liked_genres** (jsonb — [string]), **round2_emphases** (text) }. The last three were added 2026-10-05 (migration `2026-10-05-v7-requested-genres.sql`); NULL = signed up before. Writers fall back to saving without them if the migration hasn't run. Owner-scoped RLS SELECT; service-role writes. Replaces `business_directions` as v7's taste source of truth.
- `business_v7_settings` — one row per v7 business (PK `business_id`). { business_id (uuid PK), delivery_mode (text CHECK IN ('option1','option2'); NULL until the gate is picked), timeline (jsonb — Option 2's energy timeline, v2 shape `{version:2, groups:[{days, open, close, points:[{m,e}]}]}`, see § V7 ARCHITECTURE "Option 2: energy timeline"), updated_at (bumped only by delivery-mode changes) }. Written by `set-delivery-mode.js`, `update-timeline.js`, and `update-hours.js` (reconciliation). Changes are audited in `business_settings_changes` (fields `delivery_mode`, `energy_timeline`; plus `daily_playlists_replaced` per "replace now").
- **`track_analyses.duration_sec`** (int, added 2026-09-24, migration `2026-09-24-v7-timeline-pool.sql`) — track length parsed from `raw_analysis->>'duration'` ("m:ss"), filled by a `BEFORE INSERT OR UPDATE OF raw_analysis` trigger (covers every analysis writer) + a one-time backfill. Used by the Option-2 builder via the `v7_timeline_pool` RPC.
- `business_v7_directions` — Option-1 energy-tiered directions: a library of up to 30 per business (populated at mode selection via `save-energy-directions.js`, which replaces the whole set and keeps at most 30; `rank` is bookkeeping only — the daily draw is random). { id (uuid PK), business_id (FK→businesses ON DELETE CASCADE), energy_tier (text CHECK IN ('high','low')), rank (int), title_en (text), genres (jsonb — [string], canonical), active (bool DEFAULT true), created_at }. Partial index on (business_id) WHERE active. Only Option 1 uses this; Option 2 uses `business_v7_level_directions` (below).
- `business_v7_level_directions` — Option-2 per-energy-level direction libraries (migration `2026-09-28-v7-level-directions.sql`). { id (uuid PK), business_id (FK→businesses ON DELETE CASCADE), energy_level (int CHECK 1..6), rank (int — rotation order within the level), title_en (text, internal), genres (jsonb — canonical, all approved at that level), profile_key (text — `levelProfileKey` of the taste profile it was built from), active (bool DEFAULT true), created_at }. Partial index on (business_id) WHERE active; owner-scoped RLS SELECT. Written by `save-level-directions.js` (replace-all) and `scripts/_v7-regenerate-level-directions.mjs`; separate from Option 1's table, so switching types never touches it. See "Option 2: level directions" in § V7 ARCHITECTURE.
- **v7 `business_playlists` rows insert `direction_id: null`** — that column is an FK to v6's `business_directions`; a `business_v7_directions` id would violate it (the two are different tables). See the v7 daily runtime mechanism in § V7 ARCHITECTURE.
- **`payment_checkouts`** (migration `2026-09-27-v7-payments.sql`) — one row per Hyp payment attempt from the v7 payment step. { id (uuid PK — the client's handle), order_no (bigserial, sent to Hyp as `Order`), hyp_env ('test'|'production'), masof, email, business_name, onboarding_session_id, coupon_code (FK → payment_coupons), percent_off, amount_first, amount_monthly, status ('pending'|'paid'|'failed'), hyp_trans_id (Hyp `Id`), hyp_hk_id (Hyp `HKId` — the recurring agreement, needed to cancel), hyp_acode, hyp_ccode, hyp_amount, return_query (raw redirect query, audit), paid_at, business_id (FK → businesses ON DELETE SET NULL — set when signup claims it), **billing** (jsonb `{name, address, invoiceBusinessName, taxId, invoiceEmail}` — what the payment screen sent Hyp for the invoice; `invoiceEmail` = the address actually sent to Hyp, with any "+tag" dropped (`shared/invoice-email.js`); migration `2026-09-28-v7-payment-billing.sql`), created_at, updated_at }. RLS on, no policies (server-only). A paid row with `business_id` null = paid but never signed up.
- **`payment_coupons`** — { code (PK, uppercase), percent_off (1..100, first month only), active, note, created_at }. Seeded with `TEST50` (50%) for testing — deactivate before real customers: `UPDATE payment_coupons SET active = false WHERE code = 'TEST50';`. RLS on, no policies.
- **`business_playlists.track_genres`** (jsonb, added 2026-09-24, migration `2026-09-24-v7-track-genres.sql`) — v7's per-track genre record, next to `track_ids`: `{ "<spotify_id>": ["Bossa Nova"], ... }` = which of the playlist's OWN genres each track belongs to in the catalog (canonical names; two entries when a track is tagged with two of them; `[]` if the catalog no longer ties it to any). NULL for v6 rows. Written at build time by `attachTrackGenres` in `api/v7/account/_daily-builder.js` (cron and on-demand builds) via the server-only **`v7_track_genres(p_spotify_ids, p_genres)`** RPC (`playlist_tracks` → `playlist_genres`). Best-effort: a failed lookup never blocks the build, and `insertPlaylistRows` retries without the column if it's missing, so the playlist record itself is never lost. Rows built before the column existed: `scripts/_v7-backfill-track-genres.mjs` (dry run; `--apply` writes).

**Ledgers + operational state:**
- `created_playlists` — the expiry ledger. Columns: `spotify_id` (PK), `name`, `expires_at`, `deleted_at`, `error`, `owner_id` (nullable FK → auth.users), `business_id` (nullable FK → businesses). Both FKs use ON DELETE SET NULL so the cron can still unfollow expired playlists after their owner/business is deleted. Rows written by onboarding (via /api/v5/record-playlist) start with NULL owner/business — signup.js back-fills them. Renamed from `v5_created_playlists` on 2026-08-02; migration in `v5/precompute/migrations/`.
- `v6_daily_track_history` — { business_id, direction_key, spotify_id, served_at }. Per-(biz, direction) served-track history for cross-day dedup. See "Cross-day track dedup" mechanism below. Cron opportunistically prunes rows older than 14 days.
- `gemini_call_log` — one row per Gemini API call. Columns: { id, created_at, model, label, input_tokens, output_tokens (includes thinking tokens for cost purposes), thinking_tokens (broken out for analytics), total_tokens, cost_usd (numeric 12,8), business_id (nullable FK), onboarding_session_id (nullable text), http_status, finish_reason }. Written fire-and-forget by `api/v6/gemini.js` after every call — success OR failure. Cost computed server-side via `api/v6/gemini-pricing.js` using date-aware per-model rates (Google's paid Standard tier; auto-switches on 2027-01-01 when the price doubles). Label values in use: `onboarding` (Round-1 musical directions), `onboarding-refined` (Round-2 refinement — added 2026-08-31; see the v6 "Round 2 refinement flow" mechanism in docs/v6-reference.md), plus post-signup labels for event chat / direction-edit chat / preview-direction. Attribution: post-signup callers pass `business_id` directly; onboarding callers pass a client-generated tab-lifetime `onboarding_session_id` which `signup.js` backfills into `business_id` (and clears the session id) on account creation — this applies to both `onboarding` and `onboarding-refined` label rows since R2 fires during the same tab-lifetime session as R1. Rows with `onboarding_session_id` set but no `business_id` = "abandoned onboarding" bucket surfaced by the internal admin spend endpoint. Added 2026-08-25; RLS on with no policies (writes go through service_role).

**Archive tables (owner + Ami actions):**
- `deleted_tracks` — archive keyed by `spotify_id`. Snapshot of the track's `playlist_tracks` rows + its `track_analyses` row before deletion. Written by `api/v4/ami-track-delete.js` (Ami's cleanup flow); consumed and dropped by `api/v4/ami-track-restore.js`. RLS on with no anon-read policy (dashboard hits go through service_role).
- `deleted_playlists` — archive keyed by `playlist_id`. Columns: { playlist_id (PK), name, owner, playlist_genres_rows (jsonb), playlist_tracks_rows (jsonb), deleted_at }. Written by `api/v4/ami-playlist-delete.js`; consumed and dropped by `api/v4/ami-playlist-restore.js`. Added 2026-08-30 (migration `2026-08-25-deleted-playlists.sql`). Same RLS posture as `deleted_tracks`. **Does not archive `track_analyses`** — that cache is shared with any other playlist the tracks live in and is expensive to rebuild via RapidAPI.
- `deleted_events` — archive keyed by `id` (same as the original `business_events.id`). Columns: { id (PK, uuid), business_id, name, description, original_created_at, deleted_at }. Written by `api/v6/account/delete-event.js` and `api/v7/account/delete-event.js` (owner-triggered, from the Home tab's event trash icon). No restore endpoint — the events chat flow is delete + re-chat by design (see Special event playlists section), so the archive is admin-visibility only, not a rollback mechanism. Added 2026-09-05 (migration `2026-09-05-owner-change-history.sql`). Same RLS posture as the other archives.

**Historical / vestigial:** `analyses`, `track_feedback`, `app_settings` (old OpenAI key storage — the `openai_key` row + its permissive RLS were removed during the 2026-08-14 security audit), `spotify_tokens` (v1 era).

### Track pool coverage

**128,652 successfully-analyzed tracks** (`status = ok`) in `track_analyses` as of 2026-09-28 (~121k on 2026-09-08); the count has grown incrementally as batch runs digest new genres (jazzhop, latin funk, Alternative R&B, Hawaii ukulele music, Musica Tropical, Israeli genres, Japanese Folk through early September; the 8 genres added 2026-09-26 — Afro Cuban Jazz, Doo-Wop, Electronic R&B, French Touch, Italian Folk, Mo Town, Soft Pop Hits, Surf Rock). This is the pool `v5_direction_tracks` and `v6_direction_tracks_recent` select from. To get the current authoritative count, run `SELECT count(*) FROM track_analyses` in Supabase (or grep the batch log: `grep -Ec "\] ok [A-Za-z0-9]{22} " v4/precompute/state/batch.log`). **Do not trust exploration-agent estimates over this number** — an Explore agent once returned a bogus 31k and misled a planning session. Distribution across the canonical genre list (124 entries as of 2026-09-26, `shared/genre-universe.js`) is uneven; biz types added earlier (café, pizzeria) have deeper pools than newly-added Latin / Asian / world-fusion genres.

---

## SPOTIFY SETUP

### Two-app architecture (unchanged)

- **Michael's app** (`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`): Client Credentials reads of public-playlist tracks (grandfathered access to the deprecated `GET /playlists/{id}/tracks` endpoint).
- **Rubin's app** (`RUBIN_SPOTIFY_CLIENT_ID` / `RUBIN_SPOTIFY_CLIENT_SECRET`): user-context writes on the dedicated "Robin - Sonic Brands" account (id `316gotb2mutzdjmghprpgmxwq62i`).

### `RUBIN_REFRESH_TOKEN` scope

Currently seeded with `playlist-modify-private` + `playlist-modify-public` + `playlist-read-private` (widened 2026-09-06 so `scripts/purge-pre-cron-playlists.mjs` can enumerate the account via `GET /me/playlists`). Verified via `scripts/test-rubin-spotify.mjs`.

To re-seed (if the token ever gets invalidated or you need to change scopes), the OAuth callback endpoint is gated behind `INTERNAL_ADMIN_API_KEY` via OAuth's `state` param — Spotify echoes state verbatim through the redirect, so appending `&state=<INTERNAL_ADMIN_API_KEY>` to the authorize URL is the seeding-flow convention. Missing/wrong state => 401 (gate lives in [api/new/rubin-oauth-callback.js](api/new/rubin-oauth-callback.js)). Full URL:

```
https://accounts.spotify.com/authorize?client_id=431c55feb024444c979f2aa51e04426d&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fnew%2Frubin-oauth-callback&scope=playlist-modify-private%20playlist-modify-public%20playlist-read-private&state=<INTERNAL_ADMIN_API_KEY>&show_dialog=true
```

Prereqs to re-seeding: `vercel dev` running (so the localhost callback answers), redirect URI still registered in the Rubin Spotify app's dashboard, and the same `INTERNAL_ADMIN_API_KEY` present in `.env.local` as the one you paste into the URL. The endpoint's 401 message points at this section.

**Known 403 quirk on `DELETE /playlists/{id}/followers`:** occasional 403 "Insufficient client scope" when the expire cron tries to unfollow a playlist Rubin's app created hours earlier — even though rename + empty on the same playlist in the same tick succeed. First observed 2026-09-01 on a `בלנד 5 · Boutique World Funk & Ethio-Jazz` daily-gen playlist. Rename + empty succeed silently, unfollow 403s, `expirePlaylistNow` catches it as best-effort and marks `deleted_at` anyway → the playlist stays in Rubin's library as `(expired) <name>` with 0 tracks (cruft). Suspected trigger: `create_playlist` sets `collaborative: true` (see [api/new/spotify.js](api/new/spotify.js)), which may have quirky scope semantics on the follower-DELETE endpoint. If this becomes systematic, either (a) drop `collaborative: true` in create_playlist, or (b) treat unfollow 403s as retriable so the row stays eligible on next tick.

### Development mode

Rubin's app is in Development Mode (25-user cap on OAuth users). Only relevant for pre-v5 flows that OAuth'd end users. v6 uses Rubin's refresh token exclusively, so this cap doesn't apply to v6 playlist creation.

---

## SUPABASE PERFORMANCE NOTES

### `statement_timeout` raised to 15s

Supabase's default `statement_timeout` on the `authenticator` role is **3s**. Cold Postgres connections need to compile query plans, which for non-trivial RPCs (`v5_anchor_tracks`, `v5_direction_tracks` — JOINs across playlist_tracks + playlist_genres + track_analyses with random ordering) can push past 3s → error code **57014** "canceling statement due to statement timeout".

**Fix applied:** ran `ALTER ROLE authenticator SET statement_timeout = '15s'; NOTIFY pgrst, 'reload config';` in Supabase SQL Editor.

**⚠️ That raise does NOT cover anon-key calls (measured 2026-09-23).** PostgREST applies the *impersonated* role's settings per request, and Supabase's `anon` role carries its own **3s** `statement_timeout`, which overrides `authenticator`'s 15s. Every endpoint that calls an RPC through `pgrRpc` without `{ useService: true }` — `/api/v5/anchor-tracks`, `/api/v5/direction-tracks`, `/api/v5/prewarm` — is still capped at **3s**. Evidence: anon-key `v5_anchor_tracks` calls 57014 at ~3.3s wall-clock, while identical calls on the service key succeed at ~4.6s. v6's 4-spec R1 anchor call lands ~2.2–2.5s warm — **working, but within ~0.5s of the ceiling** (one v6-shaped test call 57014'd too), which is the real explanation for v6's intermittent 57014s. Server-side paths that pass `useService: true` (daily builders, expand-playlist) get the longer timeout. Options if v6's margin ever becomes a problem, best first: point v6 at a cheap sampling RPC like v7's `v7_anchor_tracks` (would need its own tempo-aware variant, since v6 directions do carry BPM); move the endpoint to the service key; or raise `anon`'s timeout (trade-off: the anon key is public, so this widens what anyone can run directly against PostgREST).

### Retry-on-57014 in `api/v5/supabase-client.js`

Belt-and-suspenders. `pgrRequest` catches errors whose message contains `"57014"` and retries once after 300ms. Since the 15s timeout raise, this rarely fires — but is kept as a safety net for edge cases (connection pool churn, etc.).

### Atmospheres endpoint has NO server-side cache

`/api/v5/databox-atmospheres` used to have a 30-min in-memory cache. **Removed** so that Ami's atmospheres-scan changes are immediately visible without a stale window. The client hides the ~100-500ms Supabase read behind the description page's typing time. Response is `Cache-Control: no-store`.

---

## MODEL CHOICES

### Current choices

| Feature | Model | Where selected | Rationale |
|---|---|---|---|
| v6 Musical directions (main flow) | `gemini-3.6-flash`, thinking=high | `v6/generation/ai-provider.js` `PROVIDER='gemini'` | Faster + cheaper than Sonnet at comparable quality once thinking=high is set; better JSON compliance with `responseMimeType`. Flip `PROVIDER` back to `'anthropic'` in that one file to revert. |
| v7 Musical directions (R1 + R2 + taste-profile + energy-directions + level-directions) | `gemini-3.6-flash`, thinking=high | `v7/generation/ai-provider.js` `PROVIDER='gemini'` | INDEPENDENT of v6's switch. Same values today but decoupled — flipping v6's PROVIDER does not affect v7 or Ami's dashboard (which imports v7's ai-provider since 2026-09-23). Labels for `gemini_call_log`: `v7-onboarding`, `v7-onboarding-refined`, `v7-taste-profile`, `v7-energy-directions`, `v7-level-directions`. |
| Event chat (special-events dashboard) | `gemini-3.6-flash`, thinking=low | hardcoded in `api/v6/account/event-chat.js` (v6) and `api/v7/account/event-chat.js` (v7) | Multi-turn JSON, low latency for a chat feel. Prompts in `v6/generation/event-chat-prompt.js` / `v7/generation/event-chat-prompt.js`. |
| Direction-edit chat (profile-tab) | `gemini-3.6-flash`, thinking=low, max_tokens=3000 | hardcoded in `api/v6/account/direction-chat.js` | Same rationale as event chat — multi-turn JSON, low latency. Prompt in `v6/generation/direction-edit-chat-prompt.js`. Kept distinct from the ai-provider switch used for musical directions. |
| Event playlist genre+BPM extraction | `gemini-3.6-flash`, thinking=high | v6: `v6/generation/ai-provider.js` constants (`api/v6/account/event-playlist.js`); v7: `v7/generation/ai-provider.js` constants (`api/v7/account/event-playlist.js`, label `v7-event-playlist`) | One-shot classify. Was documented as Claude Haiku, but the code follows the ai-provider switch (corrected 2026-10-03). |
| Voice transcription | Whisper (`whisper-1`) via OpenAI | `api/v6/transcribe.js` | No good Anthropic ASR yet. Uses `OPENAI_API_KEY` env var only — the legacy `app_settings.openai_key` fallback was removed during the 2026-08-14 security audit. |
| Rubin's Spotify writes | (not a model — Rubin's OAuth user token) | `api/new/spotify.js` | Single grandfathered Rubin app; token refreshed lazily. |

### Historical benchmarks

`scripts/benchmark-directions.mjs` compared providers on the musical-directions
prompt (input "בר יין שכונתי בלב תל אביב" + atmospheres [אלגנטי, קליל]).
Results in `benchmark-results/summary.json`.

Headline from the 2026-08-01 pass (Anthropic vs OpenAI, pre-Gemini switch):
- `gpt-4o`: ~3.3s (fastest; no reasoning phase)
- `claude-sonnet-4-6` warm: ~11s (steady, quality winner at the time)
- `gpt-5-mini`: ~25s (reasoning-heavy)
- `gpt-5`: ~53s (reasoning-heavy — not viable for user-facing flow)

Gemini 3.6-flash (thinking=high) later replaced Sonnet as the production
choice for musical directions. Benchmark script kept for future re-runs
when a new model lands.

---

## AMI'S DASHBOARD

Ami has a dashboard at `v4/ami/` for maintaining the Data Box / atmospheres tables. Endpoints under `api/v4/ami-*`:

- `ami-scan.js` — sheet → Supabase upsert for biz-type genres
- `ami-atmospheres-scan.js` — sheet → Supabase upsert for atmospheres (writes `atmospheres.name`, `ranges`, `row_in_sheet`)
- `ami-status.js`, `ami-logs.js` — poll scan progress
- `ami-toggle-*.js` — manage skip flags
- **Track cleanup** (`ami-track-lookup.js` / `-delete.js` / `-restore.js`) — reversible removal of one track. Lookup parses bare id / URL / URI / mobile-share short link and reports playlist_tracks state PLUS the track's full `track_analyses` row (all typed audio-feature columns — tempo, popularity, energy, instrumentalness, valence, danceability, acousticness, etc. — added 2026-09-01 so Ami can eyeball why a specific track ended up somewhere it shouldn't have). Delete archives the track's rows into `deleted_tracks` before removing them. Restore replays the archive and drops the archive row.
- **Playlist cleanup** (`ami-playlist-lookup.js` / `-delete.js` / `-restore.js`, added 2026-08-30) — the playlist equivalent. Lookup uses the same input parsing (bare id / URL / URI / mobile-share link resolved via redirect-follow) and reports playlist_genres row count + distinct genres + track_analyses coverage of the playlist's tracks. Delete archives every `playlist_genres` + `playlist_tracks` row for that `playlist_id` into `deleted_playlists`, then removes the live rows. **Critically does NOT touch `track_analyses`** — those audio-features rows are shared with any other playlist those tracks live in, and are expensive to rebuild via RapidAPI. If Ami wants a track's cache gone too, she uses the track-cleanup flow one-at-a-time. Restore replays the archive and drops the archive row for a re-deletable state.
- `ami-cron-tick.js` — **cron schedule REMOVED from `vercel.json` on 2026-08-13**. Endpoint file kept so the batch worker can be revived, but no longer runs hourly. Was the driver for the RapidAPI-based track analysis pipeline; when we stopped needing it, keeping the hourly tick just consumed function invocations and served no purpose. Re-add `{"path": "/api/v4/ami-cron-tick", "schedule": "* * * * *"}` to `vercel.json crons` to bring it back.
- `ami-sync-usage.js`, `ami-reorder.js` — housekeeping

Ami also has a separate **prompt-tuning dashboard** at `/v5/ami-prompt-dashboard/`.
Since 2026-09-23 it imports `EDITABLE_PROMPT_SECTION` + `assembleSystemPrompt`
from **`/v7/generation/musical-directions.js`** (was v5) and `callModel` +
`PROVIDER` from **`/v7/generation/ai-provider.js`** (was v6). It lets Ami edit
+ preview the v7 R1 prompt output before it goes to prod. Ami is tuning
against v7's R1 prompt, NOT v6's — Roni explicitly said no v6/v7 toggle at
the dashboard level. The dashboard uses whatever provider v7's `ai-provider.js`
points at (currently Gemini 3.6-flash, thinking=high — same values as v6's
copy, but decoupled: flipping v6's PROVIDER doesn't affect the dashboard).
He also has a "דגשים מוזיקליים" textarea there that mirrors the onboarding
field, so he can test emphases + instrumentalness + popularity classification
behavior end-to-end. Each returned direction shows its
`instrumentalness_preference` / `popularity_preference` (since 2026-09-28).
Atmospheres behave as in v7 production: the checked names become an
`Atmospheres: …` line in the user message and nothing else. The dashboard
used to show a "Popularity window" derived from them (v5's
`derivePopularityWindow`); it was display-only and misleading, since
production dropped atmosphere-derived popularity on 2026-09-02, so it was
removed 2026-09-28.

**Taste-profile prompt (added 2026-09-28).** Two more steps follow the R1
step on the same page:
- **Step 2 — swipe simulation** (shown once step 1 returns directions): each
  direction gets "אהבתי" / "לא בשבילי" (default לא בשבילי); clicking a genre
  chip super-likes it and marks its direction liked, and disliking a direction
  clears its super-likes — same rules as onboarding. Plus an optional Round 2
  refinement emphases textarea, enabled only while fewer than 3 directions
  are liked (production's `picked.length < 3` Round 2 trigger; when disabled
  its text stays in the box but isn't sent), and the two carried preferences
  (prefilled with the `carryPref` rule, overridable for testing).
- **Step 3 — taste-profile editor**: `EDITABLE_PROMPT_SECTION` from
  `v7/generation/taste-profile.js`, assembled with that module's
  `assembleSystemPrompt`; the user message comes from its exported
  `buildUserMessage` and the response goes through its exported
  `normalizeTasteProfile`, so a dashboard run sees exactly what production
  would. Output: approved / conditional by energy level, the requested
  genres (titled "נתבקשו מפורשות ע"י סופר לייק או בדגשים המוזיקליים של הלקוח",
  super-likes included), the computed excluded list, a "DROPPED" line for
  genres the model listed but production would discard, and `reasoning_en`.
  Logged as `label='ami-taste-profile'`.
- Round 2 is not simulated (the taste profile gets "Round 2 directions: (not
  fired)"). The business inputs used are the ones from the last step-1 run;
  re-running step 1 resets the swipe simulation.

**Daily playlist directions (added 2026-09-28).** Step 4 appears once step 3
returns a taste profile with approved genres:
- Ami picks **Option 1** or **Option 2**, edits that option's prompt (its own
  editor, prefilled with production's `EDITABLE_PROMPT_SECTION`), and
  generates the directions the daily playlists would be built from, using
  the latest step-3 profile.
- **Switching back and forth:** each option keeps its own edited prompt, last
  result and status. Switching shows that option's editor and result, and one
  option can keep generating while Ami looks at the other.
- The logic lives in `v5/ami-prompt-dashboard/playlist-directions.js`. The
  edited text is assembled with production's FIXED section, `buildUserMessage`
  and normalizer (`v7/generation/energy-directions.js` / `level-directions.js`),
  with no Places block, logged as `label='ami-energy-directions'` /
  `'ami-level-directions'`. When Ami's version is ready, Roni ports it into
  the v7 module (and `prompt-history-v7.md`).
- The results show:
  - a short Hebrew explanation of how that option's playlists are built from
    the directions (`EXPLANATION_HE` — keep it in sync with `planOption1` and
    `_option2-builder.js` when those rules change),
  - the directions per tier or per level,
  - any approved genres left unused, and genres the normalizer dropped,
  - Option 1: each tier's requested genres, and one example day drawn with
    production's `pickTierPair` (requested genres included);
  - Option 2: the next 4 days of `pickLevelDirections` rotation per mix.
- A new step-3 run clears both options' results (the edited prompts stay) and
  hides step 4 until it succeeds.

**Energy test playlists (added 2026-09-30).** Ami is examining whether the
per-track `track_analyses.energy` (0–100) is worth using in the daily
playlists. Under an Option 1 result (not Option 2), each direction has two
buttons (`v5/ami-prompt-dashboard/test-playlists.js`):
- **🎲 50 שירים אקראיים** — 50 random tracks from the direction's genres, drawn
  like an Option-1 daily playlist (`v6_direction_tracks_recent`, bpm 0–300,
  the step-3 profile's instrumental / popularity preferences, no 7-day history).
- **⚡ לפי אנרגיה** — a modal with a two-handle 0–100 range slider and a create
  button. The draw uses the same pool, limited to tracks whose energy is in the
  range (`v7_energy_tracks` RPC, migration `2026-09-30-v7-energy-tracks.sql`).
  - While a playlist builds, the slider and button are disabled and the button
    shows a spinner. Afterwards an open button appears and they can be used
    again.
  - Fewer than 50 matches → a playlist of however many there are, with a
    message. Zero → a message and no playlist.
  - Each direction keeps its own modal state while the modal is closed.
- Both show the playlist's actual energy (min–max, average) after it's built.
- Each list of created playlists (per direction, and per direction's modal) is
  numbered in build order, "1. אקראי · 50 שירים", newest on top.
- **Server:** `api/v7/ami/test-playlist.js` builds on Rubin's Spotify account
  through the usual proxy and writes a `created_playlists` row with no business
  and a 3-day expiry, so the expire cron deletes it.
  - Site-only, rate-limited 40/hour per IP (`ami-test-playlist`).
  - Errors: 503 `spotify-paused`, 501 `needs-migration` (the RPC is missing).
- **Crons go first.** Both crons set a Redis "running" flag for their whole tick
  (`api/_cron-running.js`: `cron:running:v7-daily` / `cron:running:expire`,
  330s TTL). While one is set, the POST answers 409 `cron-running` without
  touching Spotify. The dashboard then shows why and moves the build to the back
  of the line, re-checking every 20s with the cheap GET (`ami-test-playlist-status`,
  120/min).
  - Ami's builds also run one at a time.
  - A cron that starts while one of Ami's builds is running isn't held back
    (a build takes ~5–10s).

The dashboard's prompt assembly runs through a **lenient wrapper**
`normalizeForProdAssembly` in `v5/ami-prompt-dashboard/app.js` (added 2026-08-30)
before calling the prod `assembleSystemPrompt` helper. It renames any
"### … Processing Rules:" heading to the exact form prod's strict
`injectPlaces()` anchors on, so Ami's edits don't have to preserve it —
without this, Ami saw cryptic "התגובה לא הייתה JSON תקין" errors when the
Places blocks failed to inject and the model got a malformed prompt. Since
2026-09-30 that heading is v7's only Places anchor: the input block goes before
it and the processing rule at the end of its block (it used to anchor on
"## Energy & Pairing Constraints" too, which the wrapper also renamed). The
wrapper applies ONLY to the dashboard preview path; prod's `injectPlaces`
still warns and skips the Places blocks when the anchor is missing. When
Ami's tuned prompt is ready to ship, Roni is the one injecting it into prod
and manually reconciling any anchor formatting.

Because the atmospheres endpoint has no server cache, Ami's scan is
immediately visible to v6 onboarding sessions without waiting for cache
expiry.

---

## INTERNAL ADMIN API (Michael's dashboard)

Read-only endpoints under `api/internal/*` for Michael's forthcoming admin dashboard (his own repo, host TBD — not in this repo). Auth: single shared bearer token in `INTERNAL_ADMIN_API_KEY` env var, presented as `Authorization: Bearer <key>` or `x-internal-admin-key: <key>`. CORS is `*` because the bearer token IS the security boundary (no cookies, so cross-origin attacks can't attach it). Fail-CLOSED on missing env — misconfig 500s loudly, same philosophy as `requireSiteOrInternal`.

- `GET /api/internal/users` → `{ count, businesses: [ { business_id, name, owner_id, owner_email, created_at, has_prompt } ] }`. `has_prompt` is true iff `business_description` or `musical_emphases` is non-null (rows signed up after the 2026-08-23 migration).
- `GET /api/internal/business?id=<uuid>` → full detail: `{ business, onboarding: { business_description, musical_emphases, atmospheres }, place, hours, directions[], playlists[], direction_changes[], chat_transcript[], gemini_spend: { total_usd, call_count, by_label[] }, gemini_calls[], cleanup_backlog[], playlist_opens[], playlist_opens_summary: { total, by_playlist[], by_source[] } }`. `playlists[].track_ids` is the ordered Spotify-ID array as of build time (null for pre-2026-08-20 rows); `playlists[].track_genres` (added 2026-09-24) is v7's `{spotify_id: [genre, ...]}` per-track genre record (null for v6 rows) — documented for Michael in `docs/admin-api-for-michael.md`. `direction_changes[]` and `chat_transcript[]` are the profile-tab direction-edit chat's audit + full message log (empty for owners who haven't used the chat yet). `gemini_spend` + `gemini_calls[]` are this business's Gemini API cost rollup + every logged call (both onboarding calls backfilled at signup and post-signup chat calls) — both zero/empty for businesses that signed up before 2026-08-25 when call logging started. `cleanup_backlog[]` (added 2026-08-29) is any `created_playlists` row for this business that is past-expired, not yet deleted, AND has failed at least once (attempts >= 1) — worst-offender first; empty for healthy businesses. `playlist_opens[]` + `playlist_opens_summary` (added 2026-08-30) are the dashboard "▶ פתח" click log for this business (raw log capped at 1000, plus rolled-up counts by playlist and by source).
- `GET /api/internal/gemini-spend` → site-wide Gemini API cost totals: `{ totals: { all_time_usd, all_time_calls, attributed_usd, attributed_calls, abandoned_usd, abandoned_calls }, by_day[], by_label[], recent[] }`. `abandoned_*` = rows with `onboarding_session_id` set but no `business_id` (user started onboarding, Gemini spent money, they never signed up). Aggregations done in server memory over up to 10k rows — move to a Postgres RPC if the log ever grows past that.

Notes on the data shape:
- `onboarding.atmospheres` is read from `auth.users.raw_user_meta_data.sonic.onboarding.atmospheres`. That field only gets written on FIRST signup for a given email, so a user who did a second onboarding under the same email still shows the atmospheres from their first flow.
- `playlists[]` includes both live and expired rows (nothing deletes `business_playlists`; `expires_at` only gates dashboard visibility). Michael's dashboard should filter itself if it only wants live playlists.
- Michael's dashboard is expected to iterate: `GET /users` for the list, `GET /business?id=<row.business_id>` per user for detail. No server-side pagination — pilot scale.
- Michael's Claude-facing reference doc lives at `docs/admin-api-for-michael.md` — keep it in sync when the endpoint shape changes.

---

## ENVIRONMENT VARIABLES

All set in Vercel cloud env. `.env.local` also has them for local dev (`vercel dev` reads from cloud, but scripts and one-off tools use `.env.local`).

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_KEY` | `api/v5/anthropic.js` (the event-playlist endpoints reach it only if an ai-provider is switched to Anthropic) | Sonnet 4.6. Anthropic path is on standby; Gemini is production. |
| `GEMINI_API_KEY` | `api/v6/gemini.js` | Google `x-goog-api-key`. Powers musical directions + event chat. |
| `OPENAI_API_KEY` | `api/v6/transcribe.js`, legacy proxies | Env-only. The old Supabase `app_settings.openai_key` fallback was removed during the 2026-08-14 security audit (was readable via the public anon key). |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Michael's app for CC reads | Hardcoded copy of client_id in v3/app.js for legacy OAuth |
| `RUBIN_SPOTIFY_CLIENT_ID` / `RUBIN_SPOTIFY_CLIENT_SECRET` | Rubin's app for user-context writes | client_id: `431c55feb024444c979f2aa51e04426d` |
| `RUBIN_REFRESH_TOKEN` | `api/new/spotify.js` refreshUserToken | Scope: `playlist-modify-private` + `playlist-modify-public` + `playlist-read-private` (widened 2026-09-06 — see § SPOTIFY SETUP). Re-seed for other scopes. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | All v5/v6 endpoints via api/v5/supabase-client.js | Anon safe to expose client-side; service role server-only |
| `INTERNAL_API_KEY` | `api/v6/origin-guard.js requireSiteOrInternal`; passed as `x-sonic-internal` header for server-to-server calls into `api/new/spotify.js`; also rate-limit bypass in `api/v6/ratelimit.js` | Fail-open if not set. |
| `INTERNAL_ADMIN_API_KEY` | `api/internal/_guard.js requireAdmin` — Michael's dashboard bearer token | Fail-CLOSED if unset (500s the endpoint). Must be set in Vercel prod + `.env.local`; share the value with Michael out-of-band. |
| `UPSTASH_REDIS_REST_KV_REST_API_URL` / `_TOKEN` | `api/v6/ratelimit.js`, `api/new/spotify.js` (pause switch + daily write counter) | Auto-injected by Vercel's Upstash integration with the `UPSTASH_REDIS_REST` custom prefix. If unset, rate limiting is DISABLED (fail-open) and one warning line prints at cold start. Same fail-open behaviour for the pause switch — logs a warning then proceeds without global backpressure. |
| `SUPABASE_AUTH` | `api/_alert.js` sendAlert; Supabase Dashboard → Auth → SMTP for magic-link emails | Resend API key (prefixed `re_`). Named `SUPABASE_AUTH` because it was originally added for Supabase's SMTP config — same key powers our operational alert emails now. Fail-open if unset. Set in Vercel + `.env.local`. |
| `GOOGLE_PLACES_API_KEY` | `api/v6/place-lookup.js` | Optional — endpoint silently skips if unset. Currently sensitive in Vercel + set to empty on some environments. |
| `CRON_SECRET` | `api/cron/expire-playlists.js`, `api/cron/v7-generate-daily.js` (+ the unscheduled `generate-daily.js`) auth check | Vercel Cron sets `Authorization: Bearer <secret>` header. Also gates the v7 walkthrough scripts' manual cron trigger. |
| `V6_ACCOUNT_REDIRECT_URL` | `api/v6/account/signup.js accountRedirectUrl` | Optional pin. When unset, magic-link redirect derives from request host (validated against `isAllowedHost`). |
| `V7_ACCOUNT_REDIRECT_URL` | `api/v7/account/signup.js accountRedirectUrl` | Optional pin for where the v7 signup email's magic link lands. When unset (the normal case), it's `<request host>/v7/account`, host checked against `isAllowedHost`. |
| `V7_PAYMENTS_ENABLED` | `api/v7/payment/_hyp.js` (`PAYMENTS_ENABLED`) → checkout, signup, the payment screen | `true` = real Hyp payments in v7 onboarding; anything else / unset = the placeholder payment screen and no payment required. Set per Vercel environment (Development on since 2026-09-29; Production off until payments are ready). |
| `V7_COUPONS_ENABLED` | `api/v7/payment/checkout.js` | `true` = first-month coupons on (coupon field shown, `TashFirstPayment` sent). Off by default — on the test terminal Hyp crashed after charging whenever `TashFirstPayment` was sent. Development only for now (2026-09-29, re-testing on the production terminal). |
| `V7_PRICE_OVERRIDE_ILS` | `api/v7/payment/_hyp.js` `monthlyPriceIls` | Dev-only monthly price (≥ 1) replacing the real one on ANY terminal, for real-card tests on the production terminal. Ignored whenever `VERCEL_ENV=production`. Set to `2` in Development on 2026-09-29 (with TEST50 → ₪1 first month). Never set it in Production. |
| `HYP_ENV` | `api/v7/payment/_hyp.js` | `test` (default when unset) or `production` — which Hyp terminal takes v7 payments. Any other value throws. **No comment on the same line in `.env.local`** — our scripts read everything after `=` as the value, and a copy of `production # …` into Vercel broke it once. |
| `HYP_TEST_MASOF` / `HYP_TEST_API_KEY` / `HYP_TEST_PASSP` | same | Hyp **test** terminal: terminal number (10 digits), API key (`KEY`), API password (`PassP`). `KEY` + `PassP` are in the terminal's Hyp portal → הגדרות → API-דף תשלום ו → אימות. |
| `HYP_PROD_MASOF` / `HYP_PROD_API_KEY` / `HYP_PROD_PASSP` | same | Hyp **production** terminal. Only needed where `HYP_ENV=production`. |
| `TRACK_ANALYSIS_RAPIDAPI_KEY` | `v4/precompute/batch.mjs`, `api/v4/track-analysis.js` | RapidAPI plan quota tracked in `.rapidapi-call-count.json`. The *automated cron* is off (ami-cron-tick killed 2026-08-13) but the CLI batch worker `node v4/precompute/batch.mjs` is still run manually to digest new genres as Ami adds them. Key rotated 2026-08-25 after a paid-tier upgrade — the old key kept returning provider-side errors on the higher tier; new key resolved it. Rotated again 2026-09-24 when the plan went back from Ultra to Pro (same lesson: a tier change → a new key). Track analysis only runs locally (the batch worker on Roni's machine reads the key from `.env.local`); nothing in the cloud runs it on a schedule. Regen a key at RapidAPI dashboard → your app → security. |
| `RAPIDAPI_BILLING_CYCLE_DAY` | Precompute batch | Day of month billing resets |

**Also configured in external dashboards:**
- **Resend API key** — the value stored under `SUPABASE_AUTH` above is
  a Resend key. Also mirrored into Supabase Dashboard → Auth → SMTP
  Settings so Supabase can send magic-link emails from
  `noreply@robin-music.com`. Two different consumers of the same key.
  See the "Auth email" and "Alerts via Resend" mechanisms.

---

## VERCEL DEPLOYMENT

**Tier:** Vercel Pro (paid). 1M function invocations/month, up to 900s function duration, commercial use allowed. Supabase is also on Pro ($25/mo) — 8GB DB, unlimited API requests, no auto-pause. Assume both when reasoning about limits.

**Prod deploys are MANUAL:** `vercel --prod`. Pushing to `main` does NOT auto-deploy.

`vercel.json` configures:
- Function `maxDuration` per endpoint (30s default; 10–15s for small writes such as toggle-super-like, log-playlist-open, place-lookup and the v7 settings saves; 60s for anthropic + transcribe + v6 event-playlist + expand-playlist + the v6 chat / apply endpoints + v7 event-chat + `api/v7/ami/test-playlist.js`; 120s for `api/v7/account/event-playlist.js` (a build measured 42s on 2026-10-03); 15s for v7 save-event / delete-event; 300s for the cron entrypoints, both generate-daily endpoints, and **`/api/v6/gemini`** — raised from 60s on 2026-09-24 because v7's taste-profile call generates ~8.6k–13k tokens (mostly thinking) at ~150 tok/s ≈ 57–88s, over the old limit. The proxy is shared by v6 and v7; the higher ceiling doesn't change normal calls)
- **Cron schedule (two hourly crons, deliberately staggered)** — cut over to v7 on 2026-09-23:
  - `/api/cron/v7-generate-daily` at `0 * * * *` — the LIVE per-business daily playlist builder. Targets `version='v7'` businesses only; branches option1/option2 (see the v7 daily runtime mechanism in § V7 ARCHITECTURE).
  - `/api/cron/expire-playlists` at `30 * * * *` — sweeps expired ledger rows (rename + empty + unfollow on Rubin). Version-agnostic — sweeps both v6 and v7. Moved off `:00` on 2026-08-29 as part of the resilience layer so it can't overlap top-of-hour daily-gen writes.
  - **`/api/cron/generate-daily` (v6) was REMOVED from `crons` on 2026-09-23** — the user did not want to keep making that many Spotify calls once v7's builder came online. The file stays in-tree (revivable) but nothing schedules it, so v6 businesses get no new daily playlists (existing ones expire normally). **Also hard-disabled in code (2026-09-24):** `V6_DAILY_CRON_DISABLED = true` at the top of the handler makes it a no-op even if a stale deploy still schedules it (prod did, until the next deploy) or someone triggers it by hand. It has NO `version` filter and would NOT skip v7 businesses — v7 accounts DO get `onboarding_expanded = true` (the account app copied from v6 sets it on first visit) — so reviving it needs both the flag flipped and a `version=eq.v6` filter.
  - `/api/v4/ami-cron-tick` was **removed** from the cron schedule on 2026-08-13. Endpoint file still exists so it can be revived, but nothing schedules it now.
- Cache headers: `no-cache` for `/` + `/index.html` + all `/vX/*` paths
- Security headers (global): `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(self), camera=()` — added during the 2026-08-22 security audit
- Rewrites: `/` → `/v7/index.html` (since 2026-09-28; was `/v6/index.html` from 2026-08-20, which replaced the deleted legacy root index.html), plus per-version paths `/v6`, `/v6/account`, `/v5`, `/v5/ami-prompt-dashboard`, `/v4`, `/v4/ami`, etc.

### Cache busting

`v6/index.html` script tag uses `?v=DDMMYYYY{letter}` (e.g., `02082026a`). Bump when JS/CSS changes — and bump the matching `?v=` on every `import` inside `v6/app.js` too (they use the same query so browsers pick up the new module bytes).

`v6/account/index.html` similarly at `01082026b`.

**v7 uses the same scheme.** `v7/index.html` and `v7/account/index.html` load `app.js?v=DDMMYYYY{letter}`, and the browser-side imports inside `v7/app.js` / `v7/account/app.js` carry their own `?v=` (e.g. `../generation/level-directions.js?v=28092026a`). When you change a v7 client module, bump its `?v=` on the importing line AND the `app.js?v=` in the page's `index.html`. The server-shared rule below applies to v7 too: modules under `v7/generation/` that `api/` imports (`energy-timeline.js`, `timeline-assembler.js`, `playlist-length.js`, `ai-provider.js`, …) must use bare imports among themselves.

**Server-shared modules must NOT use `?v=` on their internal imports.** Node's ESM loader treats the query string as part of the filename and prod cold-deploys crash with `Cannot find module './foo.js?v=...'`. `vercel dev` sometimes strips the query (loader-chain dependent) so this passes locally but breaks on Vercel. The specific offender that took down `/api/v6/account/direction-chat` on 2026-09-02 was `v6/generation/musical-directions.js` importing `./ai-provider.js?v=25082026a` — that file got pulled into the server bundle transitively when `direction-edit-chat-prompt.js` started importing rule sub-constants from it (2026-08-31), and the chat prompt is in turn imported by the server-side chat endpoint. Any module that is (or might become) transitively reachable from an `api/` file must use bare `import 'x'` / `import './x.js'` — no query. Browser cache freshness for those modules is handled by the `Cache-Control: no-cache` header on `/v6/*` in `vercel.json` (browsers revalidate on every load), so the `?v=` bump was redundant there anyway.

---

## PROMPT EDITING PROTOCOL

Nine prompts (musical directions, the v7 prompts built on them, and v7's special-playlist prompts) exist across two versions, tracked in two audit-log files:

**v6 (production)** — tracked in `prompt-history.md`:
- **v6 Round 1** — `EDITABLE_PROMPT_SECTION` + `FIXED_PROMPT_SECTION` in `v6/generation/musical-directions.js`, both composed from named sub-constants. Mirrored byte-for-byte in `v5/generation/musical-directions.js` (kept for legacy `v5/app.js` — no longer read by Ami's dashboard).
- **v6 Round 2** — R2-specific sub-constants inside `v6/generation/refined-directions.js`, composed on top of shared sub-constants imported from R1's file. No v5 mirror (R2 is v6-only).

**v7 (runtime built)** — tracked in `prompt-history-v7.md`:
- **v7 Round 1** — `v7/generation/musical-directions.js`. Diagnostic taste probes (see § V7 ARCHITECTURE). What Ami's dashboard tunes against.
- **v7 Round 2** — `v7/generation/refined-directions.js`. Imports shared sub-constants from v7 R1.
- **v7 Taste profile** — `v7/generation/taste-profile.js`. Full-catalog bucketing (every genre in `shared/genre-universe.js` — 124 as of 2026-09-26; the prompt reads the count from the list) + per-user energy scale.
- **v7 Energy directions** — `v7/generation/energy-directions.js`. Option-1 energy-tiered directions from `approved_genres`. `Applies to: energy directions`.
- **v7 Level directions** — `v7/generation/level-directions.js`. Option-2 per-energy-level direction libraries from `approved_genres`. `Applies to: level directions`.
- **v7 Event chat** — `v7/generation/event-chat-prompt.js`. The special-playlists chat (today only, 2 per day, styles question). `Applies to: event chat`.
- **v7 Event playlist** — `v7/generation/event-playlist-prompt.js`. Brief → genres + tempo + preferences for a special playlist. `Applies to: event playlist`.

**Any edit to any prompt** appends a NEW entry at the top of the correct history file (v6 edits → `prompt-history.md`; v7 edits → `prompt-history-v7.md`). Each entry MUST include:
- An **Applies to:** line. For v6: `Round 1` / `Round 2` / `both`. For v7: `Round 1` / `Round 2` / `taste profile` / `R1+R2` / `energy directions` / `level directions` / `event chat` / `event playlist` / `all v7`.
- Today's date + one-sentence summary of what changed and why
- The FULL text of the changed sub-constants (for substantive content changes) OR a clear diff description (for structural/refactor changes with byte-identical output). Never delete old entries — the files are the audit log.

If the edit touches a shared sub-constant in v6, mark `Applies to: both` and note both v6 prompts are affected. Same for v7. Verify v5 mirror is still byte-identical to v6 for `EDITABLE_PROMPT_SECTION` and `FIXED_PROMPT_SECTION` after every v6 edit.

Cross-version edits (e.g. the 2026-09-23 `shared/genre-universe.js` extraction, which touched v6 + v5 + genre-list.js + enabled v7 to import from the same source) go in BOTH history files — primary record in whichever version drove the change, cross-reference entry in the other.

### Genre Universe invariant (as of 2026-09-23)

The genre universe is enumerated in **ONE code location**: `shared/genre-universe.js`. Every consumer imports or re-exports from there:

- `v6/generation/musical-directions.js` — re-exports `GENRE_UNIVERSE_SECTION` (import from shared).
- `v5/generation/musical-directions.js` — same import.
- `v6/generation/genre-list.js` — re-exports `GENRES` + `GENRE_SET` from shared.
- `v7/generation/musical-directions.js` — imports `GENRE_UNIVERSE_SECTION` from shared.
- `v7/generation/refined-directions.js` — imports transitively via v7 R1.
- `v7/generation/taste-profile.js` — imports `GENRE_UNIVERSE_SECTION` + `GENRES` + `GENRE_SET` from shared (for the case-insensitive canonicaliser in `normalizeTasteProfile`).
- `v6/generation/direction-edit-chat-prompt.js` — imports `GENRE_UNIVERSE_SECTION` from `v6/generation/musical-directions.js` at runtime (which re-exports from shared).
- `api/v6/account/event-playlist.js` — imports `GENRES` + `GENRE_SET` from `v6/generation/genre-list.js` (which re-exports from shared).

There is no cross-file drift to check anymore. Historical (pre-2026-09-23) context: the list used to be inlined in THREE places (v5 + v6 musical-directions.js + v6 genre-list.js), which triggered a MUST-FLAG assistant behavior rule about verifying sync at session start. That rule is retired.

**Rule that still applies:** DB strings in `playlist_genres.genre` must match `shared/genre-universe.js` verbatim (case-insensitive; RPCs lowercase-match). If Ami adds a genre in Data Box or the batch worker, the new string must be added to `shared/genre-universe.js` in the same change — that's still a single-file edit, but if it's skipped, downstream lookups silently return zero tracks for the new genre. Sanity check: `scripts/_verify-genre-refactor.mjs` compares in-tree against git HEAD's inline form for regression detection.

---

## COMMON TASKS

### Run v6 locally
1. `vercel dev` (reads cloud env)
2. Open `http://127.0.0.1:3000/v6` (the root `/` serves v7 since 2026-09-28).

### Run the integration tests (Supabase-live, cleans up after itself)
Same PowerShell env-load pattern as the purge scripts, then:
```powershell
node scripts/test-instrumentalness-preference.mjs
node scripts/test-super-liked-tracks.mjs
node scripts/test-cron-daily-guards.mjs
```
Each creates + tears down its own throwaway user + business. Safe to run against prod.

### Re-seed Rubin refresh token
- See "Spotify Setup → RUBIN_REFRESH_TOKEN scope" above for the authorize URL (includes the `&state=<INTERNAL_ADMIN_API_KEY>` gate).
- Update `RUBIN_REFRESH_TOKEN` in Vercel cloud env AND `.env.local`, in the same sitting. Restart `vercel dev` if running.
- Verify: `node scripts/test-rubin-spotify.mjs` (refresh + create + unfollow round-trip).

### Bump cache version
- Change `?v=…` in `v6/index.html` and `v6/account/index.html`.
- Also update the imports in `v6/app.js` and `v6/account/app.js` to match.

### Manually deploy to prod
```powershell
vercel --prod
```

### Purge Rubin's playlist library
```powershell
Get-Content .env.local | ForEach-Object {
  if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
    Set-Item "env:$($matches[1])" $matches[2]
  }
}
node scripts/purge-rubin-playlists.mjs             # dry-run
node scripts/purge-rubin-playlists.mjs --confirm   # actually unfollow
```
Source: `created_playlists` ledger (not `GET /me/playlists`) — written before the refresh token could read playlists; to sweep by what's actually in Rubin's library (incl. pre-ledger playlists) use `scripts/purge-pre-cron-playlists.mjs`, which reads `GET /me/playlists`. Ledger row marked `deleted_at` automatically so the cron doesn't re-process.

### Reset a user for re-testing
Supabase Dashboard → SQL Editor:
```sql
DELETE FROM public.businesses WHERE owner_id = (SELECT id FROM auth.users WHERE email = 'test@you.com');
DELETE FROM auth.users WHERE email = 'test@you.com';
```
Also visit `/v6/?reset=1` to wipe the localStorage session (v7 onboarding + account apps honor `?reset=1` too — clears all `sb-*` keys).

### Benchmark OpenAI vs Anthropic
```powershell
node scripts/benchmark-directions.mjs --out=benchmark-results/run.json
# Override with env vars: OPENAI_MODEL, ANTHROPIC_MODEL, BIZ_DESC, ATMOSPHERES
```

### Precompute batch flags (RapidAPI analysis pipeline)
`v4/precompute/batch.mjs` gained three CLI knobs during the late-Aug / early-Sep batch push:
- `--max-error-retries=N` — caps the 5xx/network retry ladder at N retries after the initial failure. Default is the full 6-step ladder. `=0` = true fail-fast: first server_error / network_error / gateway_html marks the track `status='error'` immediately, no backoff, no retry call. Doesn't affect 429 (rate-limit retries are always worth waiting).
- `--no-storm-abort` — bypasses the 8-of-10 rolling-window terminal-failure abort. Pair with `--max-error-retries=0` when you know upstream is patchy and you don't care about quota — the batch churns through everything, marking failures for a later `--retry-errors` sweep. HTML-gateway abort and cap abort still fire (those are hard "impossible to proceed" signals).
- Genre-name suffix on every outcome log line (added 2026-08-31) — batch startup bulk-loads `playlist_tracks` + `playlist_genres` for the run's toAnalyze set and appends the track's genres to each `ok` / `not_found` / `WARN terminal` line, so you can diagnose "which genre is storming" without grepping cross-tables.

Older knobs still in use:
- `--concurrency=N` — worker count, default 3, refused above 8 (`MAX_CONCURRENCY`). Higher concurrency has made runs SLOWER, because RapidAPI degrades under load.
- `--retry-errors` — re-analyses tracks at `status='error'`; without it batch treats them as done and skips them.

`batch.mjs` always runs the plan in `v4/precompute/state/dry-run.json`, written by one of the dry-run planners (no RapidAPI calls, no writes). **Re-run a planner before every batch** — rerunning batch alone re-reads the last plan (on 2026-09-25 that gave "to analyze this run: 0").

`v4/precompute/dry-run-fill.mjs` — plans new playlists from Data Box Tab 2 (needs `vercel dev`):
- `--target-playlists=N|max` — fill each genre up to N playlists (default 5), or `max` = every playlist the sheet lists for it.
- `--genres="a,b,c"` — only these genres (case-insensitive).
- New entries are emitted round-robin (every genre's next playlist, then the next), so an early abort still leaves each genre some coverage.

`v4/precompute/dry-run-orphans.mjs` gained:
- `--exclude-genres="a,b,c"` — drops orphans whose playlist is tagged to any of the listed genres. Use when a specific genre's playlists are causing upstream storms and you want to keep filling everything else without touching the DB (they stay orphans, no blacklist).
- `--include-genres="a,b,c"` (added 2026-09-26) — the inverse: keeps ONLY orphans whose playlist is tagged to one of the listed genres. Use it to scan newly added genres first (e.g. the first playlists of each new genre, then the rest). If both flags are passed, `--exclude-genres` is ignored.
- `--include-errors` — also queues tracks currently at `status='error'`. Pair with `batch.mjs --retry-errors`, or batch skips them.

Typical fail-fast recovery run:
```powershell
node v4/precompute/dry-run-orphans.mjs --exclude-genres="samba-choro"
node v4/precompute/batch.mjs --max-rapidapi-calls=1000000 --max-error-retries=0 --no-storm-abort
```

**Digesting newly added genres** (the workflow used for the 8 genres added 2026-09-26). Run each line in Roni's own terminal — these take hours:
```powershell
# 1. First 2 playlists per new genre, fail-fast
node v4/precompute/dry-run-fill.mjs --target-playlists=2 --genres="genre a,genre b"; node v4/precompute/batch.mjs --max-rapidapi-calls=50000 --max-error-retries=0 --no-storm-abort
# 2. Every other playlist of those genres
node v4/precompute/dry-run-fill.mjs --target-playlists=max --genres="genre a,genre b"; node v4/precompute/batch.mjs --max-rapidapi-calls=50000 --max-error-retries=0 --no-storm-abort
# 3. Retry the errors from 1-2 with the full 6-step ladder (add --include-genres="..." to scope it)
node v4/precompute/dry-run-orphans.mjs --include-errors; node v4/precompute/batch.mjs --max-rapidapi-calls=50000 --retry-errors --no-storm-abort
```
Then count OK tracks per genre with `node v4/precompute/genre-status.mjs` (read-only, ~2 min), and add the genres that digested well to `shared/genre-universe.js` (see § PROMPT EDITING PROTOCOL).

**One-off playlist analysis to JSON: `v4/precompute/playlist-scan.mjs`** (2026-09-28; was `tmp-playlist-scan.mjs` at the repo root until 2026-09-30). It runs every track of the playlists in its hard-coded `PLAYLIST_IDS` through RapidAPI and writes `v4/precompute/playlist-scans/<id>.json`. Nothing is read from or written to Supabase. It uses the full 6-step retry ladder with 3 workers and saves after each track. Needs `vercel dev` on :3000 plus `TRACK_ANALYSIS_RAPIDAPI_KEY` + `INTERNAL_API_KEY` in `.env.local`. Edit `PLAYLIST_IDS`, then run `node v4/precompute/playlist-scan.mjs`. **Running (or importing) it starts spending RapidAPI calls and overwrites that playlist's JSON.**

---

## KNOWN ISSUES / ROUGH EDGES

1. **`GOOGLE_PLACES_API_KEY` may be empty in Vercel** — endpoint silently no-ops. Check with a debug-length endpoint if uncertain. Places confirmation step is optional in v6.
2. **Spotify iframe autoplay blocked** in preview swipe deck. Custom play button on the artwrap requires user gesture. This is expected browser behavior; not a bug.
3. **Track pool coverage varies by genre** — niche genres (e.g., Klezmer, Medieval music) have small pools. Event playlists floor at 5 tracks; below that the endpoint returns an error asking user to describe differently.
4. **v5 tests + v3/v4 legacy scripts** may reference stale endpoints. Prefer building fresh under `scripts/` for new tools.
5. **Prod deploys are manual** (`vercel --prod`). Easy to forget after code changes.
6. **Vercel dev + moved files race**: if you move a file, update `vercel.json` in the same edit — otherwise `vercel dev` picks up the mismatch and crashes with "pattern doesn't match any Serverless Functions". Recovery: fix vercel.json and restart.
7. **Vercel dev's `VERCEL_URL=localhost:3000` quirk**: server-to-server URLs built as `https://${VERCEL_URL}` resolve to `https://localhost:3000` in dev — every fetch fails with a bare "fetch failed". Both cron files use a `resolveSpotifyBase()` helper that scheme-normalises via a `/^(localhost|127\.)/` regex → http, everything else → https. If you add another server-to-server caller that builds a base URL from `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL`, copy the same helper — do NOT hard-code `https://`.
8. **Vercel serverless kills fire-and-forget promises after `res.end()`**: this bit us on 2026-08-29 when cron cluster alerts never arrived despite the code running. Any Resend / logging / analytics send that started with `.catch(() => {})` and wasn't awaited was cut mid-flight when the function returned. If you're adding async work in a handler, either await it before responding OR collect the promises and `await Promise.allSettled(alertPromises)` at the end. See "Alerts via Resend" mechanism for the pattern.

---

## OPEN QUESTIONS FOR V7 PIPELINE BUILD

Originally a punch list from the 2026-09-23 v7 prompt-authoring session. Most of it was **resolved by the runtime build later that day** — those are marked RESOLVED below (kept, not deleted, so the reasoning is on record). The genuinely-still-open items follow.

### RESOLVED — Downstream persistence

v7 does NOT reuse `business_directions`. Signup persists the flat taste profile to the new **`business_taste_profiles`** table (plus `business_v7_settings` and, for Option 1, `business_v7_directions`) — effectively option (b) from the original write-up, but WITHOUT refactoring v6's readers: v6's daily cron is shut off, and v6's direction-chat / admin API simply see no v7 rows (acceptable for now). See § V7 ARCHITECTURE + DATA MODEL. Remaining sub-item: the internal admin API has no v7 view yet.

### RESOLVED — Playlist builder for v7

Built as two delivery modes (see the v7 daily runtime mechanism in § V7 ARCHITECTURE): **Option 1** = 4 playlists/day (2 high + 2 low energy-tier directions from `business_v7_directions`); **Option 2** = 2 mixes/day whose energy follows the owner-drawn timeline, placed by track duration (built 2026-09-24 — `api/v7/account/_option2-builder.js`; see "Option 2: energy timeline" in § V7 ARCHITECTURE; needs migration `2026-09-24-v7-timeline-pool.sql`). Driven by `api/cron/v7-generate-daily.js`. Still-open refinements: Option 1 is still count-based (3.5 min/track assumed vs 4.16 measured — could reuse the duration pool); the Home tab's "חידודים מוזיקליים" chat (v6's dormant direction-chat, moved from Profile 2026-10-03) is next in line for a v7 version — likely a taste-profile edit chat (styles in/out, instrumental / well-known preferences; energy waits for Ami's tests), not yet designed; the `conditional` bucket is stored but not consumed (below).

### RESOLVED (interim) — BPM parameter on `v5_*_tracks` RPCs

The swipe deck no longer touches these RPCs — it uses the tempo-free `v7_anchor_tracks` (next item). The v7 daily builders still pass a wide-open `0–300` window to `v6_direction_tracks_recent` as a no-op tempo filter (service key, server-side). A real "no-filter" mode on that RPC remains an optional cleanup.

### RESOLVED for v7 — anchor query cost

`v5_anchor_tracks` is slow because it random-sorts every tempo-matching track to return one (its cost follows the tempo window via `track_analyses`' tempo index, not the genre). v7 now uses **`v7_anchor_tracks`** (migration `2026-09-24-v7-anchor-tracks.sql`): per spec it samples 8 random playlists of the genre and picks from their tracks, with bounded work and no tempo. Verified 2026-09-24 against prod on the anon key: 4-card pages in ~0.3–0.5s warm / ~0.5–1.5s on never-touched genres, 0/14 failures (only the function's very first execution ever 57014'd — one-off warmup, and the endpoint + client retries absorb that). Hard-instrumental parity with the exhaustive old function: where v7 returns no card (e.g. Country, Trap), `v5_anchor_tracks` also finds nothing in the whole genre — a data limit, not a sampling miss. **v6 intentionally stays on `v5_anchor_tracks`** (kept alive by choice); its 4-card call sits at ~2.2–2.5s against the anon 3s ceiling (see § SUPABASE PERFORMANCE NOTES). If v6 ever needs relief, a tempo-aware sampling variant is the natural next step.

### RESOLVED — `vercel.json` `/v7/(.*)` no-cache rule

The `/v7` + `/v7/(.*)` no-cache header blocks now exist in `vercel.json` (added when v7 grew its UI), matching the `/v5` + `/v6` pattern.

### OPEN — v7 browser-flow gaps found in the 2026-09-23 audit

Confirmed by reading both sides; not yet fixed (each needs a decision):
- **v6 and v7 share one browser session.** Same origin → same `sb-*-auth-token` localStorage key. A v6-logged-in owner opening `/v7` is redirected to `/v7/account` (head script in `v7/index.html`) and sees their v6 business behind the v7 delivery-mode gate; `v7/account/app.js` never checks `businesses.version`, so picking a mode writes `business_v7_settings` for a `version='v6'` business the v7 cron never builds. Reverse also holds. Test with `?reset=1`. Likely fix: route by `business.version` in both account apps.
- ~~**Misleading copy:** the v7 registration heading "הפלייליסטים שלכם מוכנים!" (`v7/result.js`) claims playlists are ready; v7 hasn't built any at that point.~~ RESOLVED — the heading no longer exists anywhere in `v7/` (checked 2026-09-28).

Fixed in the same audit: taste-profile retry ReferenceError loop, R1 page-2 / R2 rank collisions in the R2 + taste-profile prompt inputs, and silent Option-1 energy-directions failures (see `prompt-history-v7.md` and `v7/account/app.js energyBuildFailed`). Fixed 2026-09-24: the v7 dashboard's "צור פלייליסטים" / "המקום פתוח?" links called v6's `/api/v6/account/generate-daily` (reads v6 `business_directions` → always 400 for v7); they now call the new `api/v7/account/generate-daily.js`. The taste-profile call (~57–88s, estimated from `gemini_call_log` token counts at ~150 tok/s) exceeded `/api/v6/gemini`'s 60s `maxDuration` — raised to 300s (`vercel dev` doesn't enforce the limit, so local runs never showed it). Verified 2026-09-24: `/v7/account` is on Supabase Auth's Redirect URLs allowlist.

### `conditional_genres` bucket — DATA ONLY for v7 launch

The taste-profile prompt emits `conditional_genres` with full `energy_level` + `note_en` fields, but the initial v7 playlist builder should IGNORE this bucket. Rationale: activate later as we learn what "maybe" territory should feed into. Any v7 persistence design should still store `conditional_genres` (it's cheap data and captures real signal).

### Ami's deferred R1 improvements

In the 2026-09-23 R1 patch, Ami proposed a broader rewrite. Five specific items were adopted (Jazz simpler, Distinctness preserved, Beat-Percussion groove-family disambiguation, BPM removed, popularity fixed-def kept). His other proposed changes were **NOT adopted** in that pass — not rejected, just deferred for separate evaluation. Full text of Ami's proposal is in `prompt-history-v7.md` under the 2026-09-23 five-edits entry. The deferred items:

- **Inflexible Genre Energy Assumption** — treat every genre as a non-flexible unit representing its whole energy spectrum; don't place natively-loud genres in a quiet direction on the assumption of downstream track-picking.
- **Cluster Homogeneity OVER User Emphases** — with the "American music" split example (must not blob Country + Hip Hop + Rock under "user said they like American music").
- **Prioritizing User Preferences in Direction Ordering** — composition is objective; ordering is subjective. Preferred → slot 1 or 2.
- **Afro Label Disambiguation Rule** — `Afro Funk` / `Afro House` / `AfroBeats` are three different taste vectors that share only the "Afro" prefix.
- **Organic House & DownTempo Isolation** — don't pair Organic House / DownTempo with driving House.
- ~~**Hebrew description reframing** as explicit probe language (`בודק פתיחות ל…` / `בודק חיבור ל…`).~~ ADOPTED 2026-09-30 (Ami's R1 rewrite).

Ami separately said he'd apply his own fix for the barbershop bug (Funk + Neo Soul + Acid Jazz cluster) after that session; his output may supersede or complement the current `BEAT_PERCUSSION_RULE` groove-family disambiguation. Check with Ami before treating the current v7 R1 as settled. (His 2026-09-30 rewrite didn't touch it. The Gemini edit he made it with had dropped the "Funk + Neo Soul / Funk + Acid Jazz is invalid" sentence, and it was restored.)

### v5 dead-code cleanup

`v5/generation/musical-directions.js` has a stale header comment describing "TWO Claude calls" and a `MODEL = 'claude-sonnet-4-6'` constant + `MAX_TOKENS = 4000` that nothing references. v5's dashboard now imports from v7; v5's `app.js` imports `generateMusicalDirections` but production is on Gemini via the (now-swapped) dashboard-side ai-provider. Roni acknowledged; deferred to keep scope tight. Safe to `git rm` or clean up in a small pass.

### RESOLVED (2026-09-28) — Dashboard's `formatDirection` preference render

Ami's dashboard now shows each direction's `instrumentalness_preference` / `popularity_preference` in place of the dead `BPM: —` line.

### Cache-bust identifier drift (cosmetic)

Some cache-bust `?v=` identifiers in the dashboard use `20092026a` (September 20). Actual date of the edit was 2026-09-23. Identifier scheme is `DDMMYYYY{letter}` per this doc's Cache Busting rules; the values are just uniqueness tokens now. If we bump for another cache invalidation, use the current date.
