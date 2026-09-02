# Rubin · SonicBrands — AI Context Document

> Optimized for Claude and other AI coding assistants.
> Read this entire file before touching any code.

## ⚠️ READ FIRST — VERSION LANDSCAPE

The codebase contains multiple parallel "versions" that coexist. **v6 is the current active version.** Others are kept but see the notes:

| Version | State | Where |
|---|---|---|
| **v6** | **Current active.** Michael's v4 UI shell + our v5 pipeline (Claude musical directions). This is what the user is iterating on. | `v6/`, `api/v6/` |
| v5 | Reference. `/api/v5/*` endpoints are still called by v6 (`anthropic`, `anchor-tracks`, `direction-tracks`, `databox-atmospheres`, `prewarm`, `record-playlist`). The `v5/` frontend still runs standalone. | `v5/`, `api/v5/` |
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
- Both hostnames serve the same deploy. Since 2026-08-20 there's a `"/" → "/v6/index.html"` rewrite in `vercel.json`, so hitting either URL at the root lands the user directly on the v6 onboarding — no more `/v6` suffix required. The legacy root `index.html` (v3 landing) was deleted in that same change; static-file precedence would otherwise beat the rewrite.
- Origin guard + magic-link redirect allowlist covers both plus this project's Vercel preview URLs (`sonic-brand-*.vercel.app`).

**Repo:** https://github.com/michaelavs-1/sonic-brand
**Owner:** Michael Avshalom (avshalom.michael@gmail.com)
**Developer:** Roni Mark (roni.mark@gmail.com)

---

## V6 ARCHITECTURE

### Onboarding pipeline (`v6/`)

Progress-bar labels visible to the user (six steps):
`תיאור העסק · בחירת אווירה · דגשים מוזיקליים · שעות פעילות · בחירת כיוונים · פלייליסטים לדוגמה`

```
Splash (2.65s) → "Have a Rubin account?" login | signup gate → v6/app.js state machine
        ↓
STEP 1: Business input (v6/app.js runBusinessStep)
  - Name + free-text description
  - Top-right of the .screen-card: **"יש לי חשבון"** back-arrow link → navigates
    to /v6/account. Symmetric counterpart lives on the /v6/account login card
    as **"אין לי חשבון עדיין"** (centered under the "שלח לי קישור כניסה" button)
    → navigates to /v6/?start=1. Both are for owners who arrived on the wrong
    side. The `?start=1` param (and its `?intro=1` sibling for post-logout)
    bypasses the splash + "have a Rubin account?" gate and drops the user
    straight into the description card, so the round-trip is invisible.
    See `hasSupabaseSession` and the `runIntro` param-handling in
    [v6/app.js](v6/app.js).
  - Voice dictation via round mic button → /api/v6/transcribe (OpenAI Whisper)
  - Background: /api/v5/databox-atmospheres fires as soon as this screen renders
  - Background: /api/v5/prewarm hits Supabase to warm the v5_anchor_tracks +
    v5_direction_tracks plan caches (cold plans can trip statement_timeout)
  - Sub-step: Google Places confirmation (optional; silently skips if
    GOOGLE_PLACES_API_KEY absent or Google returns no match). Same
    .screen-card, progress-bar dot stays on "תיאור העסק".
        ↓
STEP 2: Atmosphere selection (v6/atmosphere.js + v6/atmosphere-bubbles.js)
  - Bubble grid (freeform floating layout, not a rigid chip grid — the
    UI was rewritten from chips to bubbles 2026-08-21). Atmosphere rows
    already loaded via the STEP-1 prefetch.
        ↓
STEP 3: Musical emphases (v6/emphases.js runEmphasesStep)
  - Same brand-block layout as step 1 (animated logo + SonicBrands title).
  - One free-text textarea: "דגשים מוזיקליים". Owner types styles they
    love / hate / want more of ("no electronic", "prefer instrumentals",
    "hits only", etc). Optional field — a light-blue "דלג" button under
    "המשך ←" resolves with empty string so users can skip.
  - "המשך" stays disabled until the textarea has ≥4 chars of real content.
  - state.musicalEmphases is threaded into the Gemini user message on
    STEP 4 and — critically — Gemini also classifies any instrumental-
    music preference into a per-direction `instrumentalness_preference`
    enum (`none`|`soft`|`hard`) that the DB layer honors downstream.
    See "Instrumentalness preference" under KEY MECHANISMS.
        ↓
STEP 4: Hours picker + Gemini directions in parallel
  - Foreground: opening hours picker (v6/hours-selector.js — one shared
    master with per-day "שעות שונות" override).
  - Background: generateMusicalDirections (v6/generation/musical-directions.js)
    fires via v6/generation/ai-provider.js. Provider switch (Gemini vs
    Anthropic) lives in that one file — currently PROVIDER='gemini' with
    model gemini-3.6-flash, thinking=high. Two calls in parallel:
    page 1 (top 4 directions, ranks 1-4) + page 2 (ranks 5-8, given the
    top-4 output so it complements rather than duplicates).
  - As SOON as Gemini page 1 lands, preparePreview (v6/preview.js) fires:
    - Fetches anchor tracks for page 1 (/api/v5/anchor-tracks). Per-spec
      inst_pref forwarded so instrumentalness filter/bias applies here too.
    - Awaits Gemini page 2 in parallel
    - Fetches anchor tracks for page 2 (sequenced after page 1 to keep
      the plan cache warm)
    - Fetches track metadata (Spotify get_track) for all previews
  - When user submits hours, everything above is usually already done →
    swipe deck renders instantly.
        ↓
STEP 5: Preview swipe deck (v6/preview.js runDirectionPreviewFlow)
  - Michael's Tinder-style swipe UI. Swipe LEFT = "לא בשבילי", swipe
    RIGHT = "אהבתי", swipe UP = super-like. Explicit like/dislike buttons
    have been removed (kept in code as dead handlers for possible revival);
    swipe is now the only tap-free interaction.
  - Card layout inside .sw2-artwrap: album art + Spotify badge (top-left) +
    orange play button (bottom-right, larger 36px icon). No visible
    super-like button — that's the swipe-UP gesture now. Below the art
    (OUTSIDE .sw2-artwrap): title, artist, orange "נסו שיר אחר מהכיוון
    הזה" pill (with a shuffle icon), reason line, and the scrubbable
    playback progress bar.
  - Spotify iframe hidden inside .sw2-artwrap with opacity:.01 (fully
    offscreen kills media). Custom sw2-play button drives it via the
    IFrame API.
  - Super-like is a SWIPE-UP gesture (threshold 100px). On fire it
    (a) records the trackId in state.superLikedTracks (Set), (b) records
    the CURRENTLY-DISPLAYED card's genre in state.superLikedGenres
    (Map<trackId, genre>) — the specific genre that produced the visible
    track (if the owner swapped through cycled genres before super-liking,
    the swapped-in genre is what gets attributed, NOT the whole direction's
    genre list) so Round 2 can weight those specific genres extra-strongly,
    (c) counts the card's direction as LIKED, (d) advances to the next
    card. A "סופר לייק" cyan toast confirms; the top cyan rail glows as
    the user drags upward past the threshold.
  - Swipe hit-area is scoped to .sw2-artwrap (the album art) ONLY.
    Everything else on the card — title, artist, swap button, reason
    line, progress bar — scrolls the page normally on touch. touch-action
    lives on .sw2-artwrap, not on .swipe-card. The only pointer guard
    left in the swipe handler is .sw2-play (inside artWrap).
  - Undo toast: after every yes/no/super-like decision, a gray "בטל" pill
    appears at bottom:24px for 3s. Clicking rewinds the last decision —
    pops the direction from likedDirections, removes from superLikedTracks
    (only if this call was the one that added it), decrements index, and
    re-renders the previous card. Colored feedback toast bumped to
    bottom:74px so both are visible during their ~1.8s overlap. Only the
    most recent decision is reversible (previous card is already gone
    from the deck).
  - Swiping right = "build a playlist for this direction" (same effect
    as swipe-up's implicit "liked").
        ↓
STEP 5b: Round 2 refinement (only if picked.length < 3)
  Trigger: after the R1 swipe deck resolves. If the owner picked fewer
  than 3 directions (0, 1, or 2), the flow branches into a refinement
  sub-step BEFORE STEP 6. If they picked 3+, STEP 6 fires directly.
  See the dedicated "Round 2 refinement flow" mechanism section below
  for the full model prompt / signal-priority breakdown.

  - **Refinement emphases screen** (v6/preview.js runRefinedEmphasesStep):
    "לא בחרת הרבה - נציע לך עוד קצת מוזיקה על סמך מה שכן אהבת. תרצה גם
    לדייק אותנו?" + optional textarea + המשך (gated on ≥4 chars) / דלג.
    Captured text lands in state.round2Emphases (preserved across step
    re-entry; cleared when state.directions is invalidated so a fresh
    R1 attempt starts with an empty textarea).
  - **Prewarm nudge**: /api/v5/prewarm fires alongside the R2 Gemini
    call (fire-and-forget). The ~30s Gemini call gives the Postgres
    plan cache time to warm before the R2 anchor-tracks call actually
    runs — mitigates the 57014 statement-timeout that can hit R2 hard
    (R1 has page-2 fallback; R2 has no fallback).
  - **R2 Gemini call** (v6/generation/refined-directions.js
    generateRefinedMusicalDirections): single call producing exactly 4
    refined directions. Inputs: all R1 inputs + full R1 direction set +
    owner's LIKED / DISLIKED / SUPER-LIKED GENRES + the round2 emphases
    text. Labeled `onboarding-refined` in gemini_call_log so admin API
    rollups split R1 spend from R2 spend.
  - **R2 preview swipe deck** (v6/preview.js runRefinedDirectionPreviewFlow):
    same swipe UI as R1, single-page 4 cards (no page 2). Reuses the
    same superLikedTracks + superLikedGenres references, so R2 super-
    likes flow into the same downstream (persisted to super_liked_tracks
    at signup; genres captured for parity).
  - **Failure UX** (v6/preview.js showR2FailureScreen): if R2 Gemini
    errored OR the R2 preview couldn't render any cards (usual cause:
    all 4 refined directions had empty anchor-tracks pools — 57014
    timeout despite the prewarm and client-side retry), the owner sees
    a screen offering "נסה שוב" (refires R2 pipeline including another
    prewarm) or a secondary action:
      - if R1 picks >= 1 → "המשך עם הכיוונים שבחרתי" (proceed to STEP 6
        with just R1 picks)
      - if R1 picks == 0 → "התחלה מחדש" (falls through to the restart
        screen below)
  - **Merge**: R2 liked directions get appended to state.picked. Persist
    to business_directions at signup identical to R1 picks; no schema
    difference between R1-picked and R2-picked directions downstream.
  - **Restart flow** (v6/preview.js showRestartOnboardingScreen): shown
    when total R1+R2 picks is 0. Single card, "התחלה מחדש" CTA calls
    goToStep(1) in-app — NOT a page reload, so the splash + "have a
    Rubin account?" gate do not re-fire. Preserved across the restart:
    bizName, bizDesc, musicalEmphases, confirmedPlace, selectedAtmos,
    hours, superLikedTracks, superLikedGenres. Cleared: directions,
    picked, round2Emphases, results (all downstream of the R1 model
    call). Hard refresh (F5) is the only way to fully reset session
    state.
        ↓
STEP 6: Playlist build (v6/generation/playlist-builder.js buildDirectionPlaylists)
  - TARGET_TRACKS = 10 per playlist, one per picked direction. Serial
    with a 2s inter-playlist stagger (was `Promise.all`, then
    CONCURRENCY=3 worker pool, dropped to serial+2s stagger on 2026-08-29
    as part of the Spotify resilience layer — the onboarding path can
    burst-fire 4-8 playlists per user and contributed to the Aug 22
    rate-limit escalation).
  - Each playlist:
    - POST /api/v5/direction-tracks → 10 track IDs (instrumentalness_pref
      forwarded so the pool honors the emphasis-derived filter/bias)
    - POST /api/new/spotify create_playlist + add_tracks (Rubin account)
    - POST /api/v5/record-playlist → 24h expiry ledger entry
  - `postSpotify` retry (added 2026-08-24): 3 attempts with 500ms/1000ms
    backoff on 5xx / 429 / network. `postSpotifyOnce` also inspects the
    add_tracks response shape — /api/new/spotify returns 200 with a
    `results[]` array where individual chunks can carry a >= 400 status;
    without that check a partial chunk failure would silently look like
    success. Non-retriable statuses (4xx bad request, auth failure)
    throw immediately so the outer catch in buildDirectionPlaylists
    marks the playlist as skipped rather than fabricating success.
    Also since 2026-08-29: the retry classifier explicitly recognises
    the `spotify_paused` error and refuses to retry it — hammering
    during a global pause is what caused the Aug 22 escalation. Only
    the onboarding path uses this — the daily-gen cron uses
    api/v6/account/_daily-builder.js which has the same paused-marker
    check.
  - Result carries expansion:{direction, popularityWindow} so the dashboard
    can grow it later.
        ↓
       Results screen (v6/result.js showRubinCTA + showSignupCard)
  - Progressive placeholder cards → real cards as each playlist finishes
  - "אני רוצה את רובין לעסק שלי" CTA gates the signup form
  - Signup: email → /api/v6/account/signup (magic-link, no password)
  - Signup payload: playlists, hours, longestMinutes, atmospheres, place,
    business_name, business_description (bizDesc verbatim),
    musical_emphases (verbatim), superLikedTracks (array of spotify_ids
    the user tapped super-like on — persisted to super_liked_tracks table
    for future taste-tuning; nothing consumes them yet).
  - Redirect → /v6/account
```

### Account dashboard (`v6/account/`)

```
Auth: Supabase Auth (JWT in localStorage). Access via /v6/account.
        ↓
Boot: loads user, businesses, then fans out four parallel Postgres reads
      (business_playlists / business_events / business_hours / business_place)
      via `loadDashboardData(businessId)` — cached on `state.dashboard`.
      RLS gates each SELECT to the caller's own businesses.
        ↓
renderAll:
  - Greeting + business name
  - Place banner (if Google Places was confirmed during onboarding)
  - renderPlaylists: reads bmeta().playlists (mirror of business_playlists rows)
    - Playlist entries with expansion:{...} and !expandedAt get an animated
      progress bar and a background expansion kicks off
    - Per-playlist edit + trash icons (added 2026-08-25): every row whose
      backing business_playlists row has a `direction_id` FK gets a pencil-
      edit and red-trash SVG button between the info column and the
      "▶ פתח" button (pre-migration rows without direction_id show neither).
      Edit → switches to Profile tab and calls `selectDirectionInChat(id)`
      in direction-chat.js, which primes the direction-edit chat with that
      direction selected (synthetic "מה תרצו לשנות בכיוון X?" bubble).
      Trash → opens the `trashDirModal` confirmation with three choices:
      "בואו נערוך" (same jump as the edit icon), "כן, למחוק" (fires
      `removeDirectionFromCard(id, { expireLive: true })` → apply-direction-
      change with kind='remove' + expireLivePlaylist=true), or cancel. The
      modal closes IMMEDIATELY on confirm (before the multi-second Spotify
      round-trip); the trash icon rotates a spinner in place so the owner
      isn't stuck on a modal spinner. Row disappears via the
      `direction-change-applied` event listener → loadDashboardData
      re-render. Handlers: `editDirectionFromCard`, `openTrashDirectionModal`,
      `confirmTrashDirectionRemove` in [v6/account/app.js].
  - renderEvents: reads bmeta().events (mirror of business_events rows).
    Per-row layout is [🎪 name/description] [red trash SVG button (btn-danger)] [action button].
    The pencil edit icon was dropped in the 2026-08-20 chat rewrite —
    workflow is now delete + re-chat. Trash uses a Feather-style outline
    SVG in a red `.btn.btn-danger.event-del` button (no emoji), spinner
    only while deleting (no "מוחק…" label).
    - "צרו פלייליסט" button hits /api/v6/account/event-playlist
        ↓
Background: expandPendingPlaylists (v6/account/app.js) — STRICT one-time
per-business event. Runs on the very first dashboard visit after onboarding:
the 10-track sample playlists each grow to today's opening hours + 1h.
  - Enforcement: `businesses.onboarding_expanded` column (a proper
    per-business row-level flag, not user_metadata) is set BEFORE any
    expansion work starts, so a mid-pass tab close / refresh / crash
    never causes a second pass. Even if some playlists end up under-
    populated, they are never re-populated. Daily-gen (separate future
    task) handles fresh playlists on subsequent days.
  - Expansions run SEQUENTIALLY (not Promise.all). Parallel writes to
    the same business_playlists rows could theoretically race — sequential
    keeps things simple. Cost: total time ≈ Σ per-playlist expansions.
  - Server: /api/v6/account/expand-playlist writes go through row-level
    PATCH on business_playlists (PK = spotify_id), so the read-modify-write
    dance on user_metadata is gone. Unrelated concurrent writes (name
    edit, event playlist insert) never collide with expansion writes.
  - Client computes per-day target via v6/generation/playlist-length.js:
    computeTargetForToday({ hours }) → (todaysOpenMinutes + 60) / 3.5min
    Closed day / hours missing → CLOSED_DAY_MINUTES (12h) + 1h ≈ 223 tracks.
    Floors at 10 tracks, cap at 500 on server.
  - Example (open day): Tuesday 09:00-21:00 → 12h + 1h buffer → ~223 tracks
  - Example (closed day, no playlists for today): title flips to
    "יום ש' - המקום סגור  [המקום פתוח?]" — link opens a confirm modal
    that POSTs /api/v6/account/generate-daily. That endpoint reuses the
    LATEST direction set (from business_directions where active=true)
    and builds one 12h playlist per direction, INSERTing them into
    business_playlists with today's created_at so the closed-day title
    flips back to normal.
```

### Direction-edit chat (profile tab)

Gemini chatbot on `/v6/account`'s Profile tab, between שם העסק and שעות פעילות. Lets the owner refine their `business_directions` after onboarding: add (up to the 8-active cap), remove (soft-disable — the row is preserved with `active=false`), or fine-tune an existing direction (exclude/add genres, adjust BPM, flip inst_pref, rename, reshape description_he).

- **UI** (`v6/account/index.html` + `v6/account/direction-chat.js`):
  - Row of clickable direction cards (`.dir-card`, title + description_he) above the chat. Clicking a card sets `state.selectedDirectionId` AND appends a synthetic assistant bubble to the transcript ("מה תרצו לשנות בכיוון X?" using the direction's `title_en`) so the owner sees the scope shift immediately. The next chat turn is scoped to that direction unless the message names a different one. Click the same card again to deselect (no synthetic bubble on deselect). Synthetic bubbles are not persisted — Gemini gets the target via `selectedDirectionId` in the context block anyway.
  - Chat transcript (`#dirChatMessages`) + textarea (`#dirChatInput`) + send button (`#dirChatSend`), reusing the events-chat `.chat-messages` / `.chat-bubble` CSS. Transcript **starts empty on every hard refresh** — the client generates a `SESSION_START_AT_ISO` at module load and sends it with every chat turn; the server filters `business_direction_chats` to `created_at >= SESSION_START_AT_ISO` when building Gemini's context, so Gemini's memory and the owner's on-screen transcript stay in sync. Messages are still persisted to `business_direction_chats` (admin API + change-audit refs) — only the client display and Gemini's context window are per-session.
  - Assistant messages carrying a `proposal` render inline confirm buttons: "שמעו את הכיוון החדש" (edit or add → preview modal), or "הסירו את הכיוון" (remove → inline "expire live playlist too?" follow-up with two buttons).
  - Preview modal (`#dirPreviewModal`, `.dp-*` CSS): single-card variant of the onboarding swipe deck. Album art + hidden Spotify iframe + play button + scrubbable playback progress bar (`.dp-progress` — same seek-lock/RAF-interpolation pattern as onboarding's `.sw2-progress`) + "שמעו עוד שיר מהכיוון הזה" swap (round-robin over the merged direction's genres via `/api/v6/account/preview-direction`) + rotated cyan super-like button (bottom-left of art, positioned OUTSIDE the art-wrap's clip so it visually protrudes over the corner) + two action buttons (dismiss / confirm).
  - **Preview is prefetched.** As soon as a proposal-carrying assistant message renders, `ensurePreviewPrefetch(messageId, proposal)` fires a background `/api/v6/account/preview-direction` call (+ Spotify metadata) and stores the promise in `previewPrefetchByMessageId`. When the owner clicks the preview button, `loadFirstCard` awaits the cached promise instead of firing a fresh call — the modal opens with the card ready in the common case. Swap always fetches fresh (round-robin over genres). If prefetch failed for any reason, first-card falls back to an on-demand fetch.
  - **Super-like is a decoupled toggle** — matches the earlier onboarding-swipe visual pattern. Click plays a one-shot expanding-ring burst (`.dp-super.burst::after`) and flips `.saved` (brighter cyan + breathing halo); click again drains color + removes halo. Persists via `POST /api/v6/account/toggle-super-like` on every toggle (optimistic UI, rolls back on server error). **Does NOT commit the direction change** — the confirm button is the sole commit path. Even if the owner dismisses the modal without confirming, any super-likes they made stay in `super_liked_tracks`.
  - **Confirm closes the modal immediately.** Two paths from here:
    - `add` → append a spinner bubble ("בונים את הכיוון החדש…") that mutates in place into the ✓ marker on success / the cap message on `cap_reached` / the error text on other failure.
    - `edit` → append a follow-up question bubble ("החליפו עכשיו" / "השאירו עד סגירה"). No server work happens until the owner picks. On pick, the same bubble rewrites into a spinner (with a label that reflects the choice), then into the ✓ marker on success (with an inline "פתחו את הפלייליסט" link when a fresh playlist was built).
    - `remove` → after the initial "הסירו את הכיוון" click, a follow-up bubble appears with two buttons ("כבו עכשיו" / "השאירו עד סגירה"). Same in-place mutation pattern as edit: pick → spinner → ✓ marker.
    Playlist rebuild takes multiple seconds; keeping the owner staring at a modal spinner for that long was worse UX than moving them back to the transcript where they can read prior messages while the work runs.
  - **Cosmetic-only edit fast path** (title_en and/or description_he ONLY, no genre / BPM / preference changes). Detected client-side by `isCosmeticOnlyUpdates(updates)` in `direction-chat.js`. On this path the entire preview modal + "החליפו עכשיו / השאירו עד סגירה" question is skipped — the proposal bubble carries a single "אשרו את השינוי" button that goes straight to `apply-direction-change`. Server also auto-detects the same shape from its computed `patch` and takes a rename-only branch: `PUT /playlists/{id}` on Spotify (name via the shared `playlistName(bizName, mergedDir)` template + description = new description_he), plus a PATCH on `business_playlists.label` (only when `title_en` moved) and a PATCH on `created_playlists.name` so the eventual expire-cron's "(expired) <name>" rename uses the current title. No track pool is touched — the music is unchanged. Audit row records `playlist_action='renamed'` (added 2026-09-02 — see the CHECK-constraint widening migration). `expireLivePlaylist` is ignored on this path. On success the chat's spinner bubble mutates in place into "✓ השם עודכן" / "✓ התיאור עודכן" / "✓ הכיוון עודכן" (labels vary by which field moved) with NO open-playlist link — the tracks are unchanged, so there's nothing new to jump to. Server signals this by returning `playlist: null`, which the shared spinner-bubble helper already treats as "hide the link".

- **Chat prompt** (`v6/generation/direction-edit-chat-prompt.js`) enforces:
  - Exposure rules: chat may freely mention title / description_he / qualitative BPM feel, but never enumerates a direction's genres unprompted. Owner-named genres are fair game. Never exposes numeric BPM or the inst_pref enum.
  - Contradiction rule: if the ask contradicts the initial onboarding context, a prior committed change, OR any of the imported musical-coherence advisory rules, surface it in one Hebrew sentence and let the owner override. Latest chat wins.
  - Add is two-step: paraphrase intent → owner confirms → full spec (title + description + genres + bpm + inst_pref) emitted as an `add` proposal.
  - Genre universe pinned to R1's canonical list — chat now imports `GENRE_UNIVERSE_SECTION` from `v6/generation/musical-directions.js` directly (was inline verbatim copy before 2026-09-02); the model must return canonical strings verbatim.
  - **Enforcement model is DIFFERENT from R1** (rewritten 2026-09-02 — see `prompt-history.md` entry for reasoning). R1 hard-enforces its musical-coherence rules because it's generating autonomously. Chat treats those same rules as **taste advisories**: if the owner's ask would violate one (Jazz Isolation, Pop Isolation, House/Techno Containment, Beat/Percussion Pairing, Non-Overlap with other directions, genre-count band, BPM shape, Standalone-genre norms), the chat surfaces the tension in one Hebrew sentence via the Contradiction rule and honors the owner's override on affirmation ("כן", "בטוח", "יאללה"). Only genre-universe / enum / cap constraints stay HARD invariants — the server (`apply-direction-change.js`) does zero content validation, so these rules ARE the enforcement. Same policy applies to both `add` and `edit`.
  - **Rule reuse via imports** — chat prompt is composed from shared sub-constants pulled from `v6/generation/musical-directions.js`: `GENRE_UNIVERSE_SECTION`, `ENERGY_COHESION_RULE` (§1), `JAZZ_ISOLATION_RULE` (§2), `EQUAL_GENRE_WEIGHT_RULE` (§4), `POP_ISOLATION_RULE` (§5), `HOUSE_TECHNO_RULE` (§6), `NON_OVERLAP_SECTION`, `OUTPUT_LANGUAGE_SECTION`, `TITLE_RULES_SECTION`, `HEBREW_DESCRIPTION_SECTION`. Deliberately NOT imported (see file header comment for why): `PROCESSING_RULES_SECTION` (every sub-rule is N/A in chat — no emphases textarea, inst_pref set from explicit ask, Japanese Folk restriction subsumed by "every chat request is explicit"), `MULTI_CULTURAL_RULE` (§3, autonomous-mode design taste), `WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION` (chat has its own Off-topic rule). To enable this cherry-pick, `ENERGY_PAIRING_SECTION` was split into six named sub-rule exports in `musical-directions.js` and the byte-identical v5 mirror; the composed `ENERGY_PAIRING_SECTION` string is byte-identical to the pre-split version, so R1/R2 output is unchanged. Chat-specific preamble (`ENFORCEMENT_MODEL`, `CONTRADICTIONS`, `OPERATIONS_CATALOG`, `GENRE_UNIVERSE_CHAT_SUPPLEMENT`, `NON_OVERLAP_CHAT_REFRAME`) reframes the imported rules as advisories and points the non-overlap check at the `## Current directions` context block instead of R1's 8-direction batch.

- **Server endpoints**:
  - `POST /api/v6/account/direction-chat` — one Gemini turn. Loads business + atmospheres (via auth admin API) + place + all directions (active + inactive) + last 20 changes + last 40 messages. Composes a `## Business context` / `## Current directions` / `## Prior committed changes` / `## Selected direction id` block as the first user turn, followed by the multi-turn transcript, followed by the current user message. Persists both roles into `business_direction_chats`; returns both rows plus a parsed `{reply_he, state, proposal|null}` payload for the client.
  - `POST /api/v6/account/preview-direction` — one anchor track for the merged direction spec (existing direction + edit updates, OR an inline add spec). Round-robin over the genres via `cycleIndex` + `excludeSpotifyIds`. Tight pass (BPM + popularity) then wide pass (0–300 BPM, 0–100 popularity) for depleted pools.
  - `POST /api/v6/account/toggle-super-like` — one row insert or delete on `super_liked_tracks` for a (business, spotify_id) pair. Called by the preview modal's super-like toggle. Rate-limited 60/min per IP.
  - `POST /api/v6/account/apply-direction-change` — commits the proposal:
    - `add` → INSERT `business_directions` (borrowing a `popularity_window` from any existing direction so the new one is consistent), then build ONE fresh Spotify playlist for today via `buildOneDailyPlaylist` (shared with cron / generate-daily), INSERT `business_playlists`, INSERT `business_direction_changes` (before=null, after=snapshot).
    - `edit` → merge `updates` into the direction spec (mirror of preview-direction's merge), PATCH `business_directions` (only fields that moved). Playlist side is gated by the request's `expireLivePlaylist` flag — default `false` so a caller that forgets the field never nukes today's music:
      - `expireLivePlaylist: true` → expire the direction's currently-live playlist via `expirePlaylistNow` (shared helper), then rebuild via `buildTodayPlaylist`. Audit `playlist_action='rebuilt'`.
      - `expireLivePlaylist: false` → leave today's playlist alone. Tomorrow's daily-gen cron picks up the updated spec (per-day `already-built-today` guard doesn't interfere). Audit `playlist_action='kept'`.
      - The chat client asks the owner in an inline follow-up bubble (mirror of the remove flow) after they confirm the direction change in the preview modal: "החליפו עכשיו" or "השאירו עד סגירה". Only then is the apply endpoint hit — no server work happens between modal confirm and the owner's answer.
    - `remove` → PATCH `active=false` on `business_directions` (row preserved, not deleted — admin API + future queries can still see it). If `expireLivePlaylist=true`, run `expirePlaylistNow` on the direction's live playlist and mirror `expires_at=now()` onto the `business_playlists` row so the dashboard hides it immediately. `playlist_action` records what happened (`expired` | `kept`).
  - All three write an audit row to `business_direction_changes` referencing the message range that produced them.
  - Super-likes are NOT passed through the apply endpoint — they're persisted independently via `toggle-super-like`, so the DB reflects the owner's taps regardless of whether they end up confirming the direction change.

- **Shared helpers** extracted for reuse:
  - `api/v6/account/_expire-playlist.js` `expirePlaylistNow({origin, spotifyId, name})` — rename + empty + unfollow + mark `created_playlists.deleted_at`, 404-tolerant. Called by both `api/cron/expire-playlists.js` (TTL sweep) and `apply-direction-change.js` (immediate rebuild on edit / opt-in remove).
  - `api/v6/account/_daily-builder.js buildOneDailyPlaylist` (existing) is called once by the direction-chat apply endpoint to build the new playlist row; a thin wrapper `buildTodayPlaylist` in apply-direction-change reads `business_hours` for today's target + expiry and single-INSERTs the result.

- **Refresh loop**: after any successful commit, the client dispatches a `direction-change-applied` DOM event. `v6/account/app.js` listens for it and reloads `state.dashboard` so the Home tab's playlist list picks up the newly-built playlist and drops the expired one — no page refresh.

- **Rate limits**: `direction-chat` 20/min per IP, `preview-direction` shares the `anchor-tracks` bucket (60/min), `apply-direction-change` 10/min per IP, `toggle-super-like` 60/min per IP.

### Profile tab UI (`v6/account/` Profile tab)

- **שעות פעילות is a collapsible section.** Header row = h2 title + chevron; clicking the header toggles the subtitle + hours picker via `aria-expanded` on `#hoursToggle` and `.hide` on `#hoursBody`. Chevron points down when closed, rotates 180° to point up when open. State resets to closed on every tab open — `renderProfileTab` in [v6/account/app.js](v6/account/app.js) sets `aria-expanded="false"` and re-adds `.hide` to the body. `mountHoursEditor` still runs on tab open even while collapsed, so dirty-tracking + the save button behave identically to when the section was always visible. The single "שמור" button at the bottom of the tab still handles both business-name and hours edits — there's no separate save inside the collapsible.

### Special event playlists

- **UI — chat, not textarea.** `v6/account/index.html` `#chatMessages` +
  `#chatInput` + `#chatSend`. Owner describes the event in a chat that
  goes back and forth with Gemini until Gemini offers a summary + inline
  "צור פלייליסט" button (see `chatState` and `appendConfirmActions` in
  `v6/account/app.js`). System prompt lives in
  `v6/generation/event-chat-prompt.js`; Gemini 3.6-flash, thinking=low,
  responseMimeType=JSON, multi-turn via the `history` arg on
  `/api/v6/gemini`. Off-topic messages get a polite redirect. Chat is
  ephemeral — cleared on refresh and on a successful finalize.
- **Editing existing events was dropped** with the chat rewrite (no
  pencil button on cards). Delete + re-chat is the workflow. Restore
  by adding an "edit this event" chat flow if needed.
- **Finalize is a two-step client chain** in `finalizeAndGenerate`:
  1. `POST /api/v6/account/upsert-event` inserts the `business_events`
     row using Gemini's `proposed.name_he` + `proposed.description_he`.
  2. `POST /api/v6/account/event-playlist` runs unchanged from the
     previous UI — Claude Haiku 4.5 extracts genres+BPM from
     description, queries `v5_direction_tracks` (no popularity screen),
     creates ~40-track Spotify playlist on Rubin, inserts
     `business_playlists` with `event_id` back-ref, registers ledger
     expiry via `/api/v5/record-playlist`.
- Event card auto-updates: shows "▶ פתח" while a live playlist exists;
  shows "צרו פלייליסט" once expired. That button (`createEventPlaylist`)
  hits step 2 only — the `business_events` row already exists, so it
  reuses the stored description and just rebuilds the Spotify playlist.

### Auth signup — `api/v6/account/signup.js`

- Uses `SUPABASE_SERVICE_ROLE_KEY` admin API to create user + `businesses` row
- Writes onboarding context (hours, longestMinutes, atmospheres, place, playlists) to `auth.users.raw_user_meta_data.sonic.b[businessId]`
- Persists the free-text prompt inputs (`business_description`, `musical_emphases`) as columns on the `businesses` row itself. Read back by the internal admin API. PATCH path skips blanks so a repeat-onboarding with an empty field doesn't wipe a previously-recorded prompt.
- Backfills `gemini_call_log` rows: `UPDATE gemini_call_log SET business_id = <new>, onboarding_session_id = NULL WHERE onboarding_session_id = <session>`. The client mints a tab-lifetime session id at v6/app.js boot and threads it through every onboarding Gemini call; this UPDATE re-attributes those pre-signup rows to the new business so per-business spend rollups include them. Sessions that never sign up stay unattributed and form the "abandoned onboarding" bucket in the internal admin spend endpoint.
- Returns instant login link (magic-link admin API) so client can jump to `/v6/account` without email round-trip
- **Magic-link redirect** (`accountRedirectUrl`) derives the target from the request host (`x-forwarded-host` || `host`) so signup on localhost / preview / robin-music.com / sonic-brand.vercel.app each redirects back to where the user came from — no per-env config needed. The derived host is validated via `isAllowedHost()` in `api/v6/origin-guard.js` to block `x-forwarded-host: attacker.com` spoofing. Whatever host wins must also be on Supabase's Redirect URLs allowlist (Auth → URL Configuration) — otherwise Supabase silently substitutes its Site URL. `V6_ACCOUNT_REDIRECT_URL` env var overrides derivation entirely if you need a pinned target.

---

## FILE STRUCTURE (V6-focused)

```
sonic-brand/
├── v6/                                     ← CURRENT ACTIVE UI
│   ├── index.html                          ← Onboarding shell + all v6 CSS (splash, swipe, hours, progress bars)
│   ├── app.js                              ← Onboarding orchestrator: state machine, 6-step progress nav +
│   │                                          the R2 refinement sub-flow that branches inside step 5 when
│   │                                          R1 preview yielded < 3 picks. See "Round 2 refinement flow" below.
│   ├── atmosphere.js                       ← Atmosphere-selection screen driver
│   ├── atmosphere-bubbles.js               ← Bubble-grid renderer used by atmosphere.js (rewrite of the old chip grid)
│   ├── emphases.js                         ← Step 3 "דגשים מוזיקליים" — one textarea + skip button
│   ├── hours-selector.js                   ← Opening hours picker (shared + master days, "שעות שונות" override)
│   ├── preview.js                          ← R1 swipe deck (runDirectionPreviewFlow) + preparePreview
│   │                                          (background prefetch, page 1 + page 2). Also owns the R2
│   │                                          UI surface: runRefinedEmphasesStep, runRefinedDirectionPreviewFlow,
│   │                                          showRefinedDirectionsLoading, showR2FailureScreen (retry /
│   │                                          continue / restart), showRestartOnboardingScreen.
│   ├── result.js                           ← Progressive results shell + "אני רוצה את רובין" CTA + signup card
│   ├── generation/
│   │   ├── ai-provider.js                  ← PROVIDER='gemini'|'anthropic' switch. Shared by v6 + Ami dashboard.
│   │   ├── musical-directions.js           ← R1 direction generator (uses ai-provider). Both EDITABLE and
│   │   │                                      FIXED prompt sections are composed from named sub-constants
│   │   │                                      (GENRE_UNIVERSE_SECTION, PROCESSING_RULES_SECTION,
│   │   │                                      ENERGY_PAIRING_SECTION, NON_OVERLAP_SECTION,
│   │   │                                      OUTPUT_LANGUAGE_SECTION, TITLE_RULES_SECTION,
│   │   │                                      HEBREW_DESCRIPTION_SECTION, WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION)
│   │   │                                      which are EXPORTED for reuse by refined-directions.js. Composed
│   │   │                                      EDITABLE + FIXED are byte-identical to the pre-refactor
│   │   │                                      single-template-literal version. `injectPlaces()` also exported.
│   │   │                                      Mirrored in v5/ so Ami's prompt dashboard sees the same string.
│   │   ├── refined-directions.js           ← R2 direction generator. Client-side module. Composes its own
│   │   │                                      system prompt from R2-specific sub-constants (REFINED_INTRO,
│   │   │                                      REFINED_INPUTS_SECTION, LEARNING_LOGIC_SECTION,
│   │   │                                      REFINED_NON_OVERLAP_SECTION, REFINED_TASK_WORKFLOW,
│   │   │                                      REFINED_OUTPUT_FORMAT, ROUND2_ADDITIONAL_ERROR — new
│   │   │                                      `insufficient_signal` error) plus imported shared sub-constants.
│   │   │                                      Fires via callModel with label='onboarding-refined'. No v5 mirror.
│   │   ├── event-chat-prompt.js            ← System prompt for the special-events chat on /v6/account
│   │   ├── direction-edit-chat-prompt.js   ← System prompt for the profile-tab direction-edit chat
│   │   ├── genre-list.js                   ← Canonical genre list, currently 113 entries (2026-09-02) — count
│   │   │                                      moves as Ami digests new genres. Shared with event-playlist server.
│   │   │                                      One of FOUR genre-list locations — see PROMPT EDITING PROTOCOL.
│   │   ├── popularity-window.js            ← Derives [lo,hi] from selected atmospheres
│   │   ├── playlist-length.js              ← dailyPlaylistExpiryIso, computeTargetForToday, directionKey, ilPartsFromDate
│   │   └── playlist-builder.js             ← buildDirectionPlaylists (10 tracks each, concurrency-capped)
│   └── account/
│       ├── index.html                      ← Dashboard shell (Home tab; profile+hours+event chat+direction-edit chat inline)
│       ├── app.js                          ← Supabase Auth boot, renderPlaylists, renderEvents, event chat,
│       │                                     expand streaming, mounts direction-chat on Profile tab
│       └── direction-chat.js               ← Direction-edit chat UI + single-card preview modal
│                                             (lazy-loaded when Profile tab first opens)
├── v5/                                     ← Reference; standalone flow still runnable
│   ├── ami-prompt-dashboard/               ← Ami's prompt-tuning dashboard (uses shared ai-provider.js)
│   └── generation/musical-directions.js    ← MIRROR of v6's; EDITABLE_PROMPT_SECTION must stay byte-identical
├── v4/
│   ├── ami/                                ← Ami's dashboard (scan sheet → Supabase)
│   ├── precompute/                         ← Batch worker for track analysis (fills track_analyses)
│   │   ├── v5-rpc-functions.sql            ← CREATE OR REPLACE for v5_anchor_tracks, v5_direction_tracks,
│   │   │                                      v6_direction_tracks_recent (all now accept p_inst_pref)
│   │   └── migrations/                     ← Dated SQL migrations (run in Supabase SQL Editor)
│   └── ...                                 ← v4 UI (mostly superseded by v6)
├── v3/, v2/                                ← Historical
├── michael-v4-snapshot/                    ← Gitignored. Snapshot of Michael's v4 fork. UI reference for v6.
├── api/
│   ├── _alert.js                           ← Resend REST helper. Reads SUPABASE_AUTH. Callers MUST await it
│   │                                          before res.end() — see "Alerts via Resend" mechanism.
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
│   │       ├── _expire-playlist.js         ← Shared expirePlaylistNow() — rename + empty + unfollow + mark deleted.
│   │       │                                  Used by both the hourly cron and direction-chat's apply endpoint.
│   │       ├── signup.js                   ← Supabase admin user + business + business_directions + super_liked_tracks; backfills gemini_call_log with new business_id via onboarding_session_id
│   │       ├── event-playlist.js           ← Claude Haiku → direction-tracks → Spotify create+add + ledger
│   │       ├── expand-playlist.js          ← Streaming ndjson: grow onboarding playlists to per-day target
│   │       ├── generate-daily.js           ← Closed-day "המקום פתוח?" flow (delegates to _daily-builder)
│   │       ├── update-hours.js             ← Profile-page hours edit
│   │       ├── upsert-event.js             ← business_events insert/update from the event chat finalize
│   │       ├── delete-event.js             ← Card-level delete
│   │       ├── direction-chat.js           ← One Gemini turn for the direction-edit chat; persists both messages
│   │       ├── preview-direction.js        ← Round-robin anchor track for a merged (edit) or inline (add) spec
│   │       ├── apply-direction-change.js   ← Commit add/edit/remove; rebuild playlist; audit row
│   │       ├── toggle-super-like.js        ← Upsert/delete one super_liked_tracks row (decoupled from apply)
│   │       └── log-playlist-open.js        ← Append one business_playlist_opens row per dashboard "▶ פתח" click
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
│   │   │                                      reports track_analyses coverage + playlist mappings
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
│   │   │                                      cluster + chronic alert emails via api/_alert.js.
│   │   └── generate-daily.js               ← Hourly `:00`. Skip guards + concurrency-1 pacing with 3s
│   │                                          inter-playlist / 5s inter-business sleeps.
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
│   ├── admin-api-for-michael.md            ← Instructions Michael feeds his own Claude to build his admin dashboard.
│   │                                          Kept in sync with /api/internal/* endpoint shape.
│   └── playlist-opens-delta.md             ← Focused delta doc for the 2026-08-30 addition of business_playlist_opens
│                                             tracking + the new fields on /api/internal/business.
├── internal-dashboard/                     ← Gitignored. Local placeholder dashboard for eyeballing
│                                             /api/internal/* responses against `vercel dev`.
│                                             Michael's real dashboard lives in his own repo.
├── scripts/
│   ├── benchmark-directions.mjs            ← OpenAI vs Anthropic timing/quality benchmark
│   ├── purge-rubin-playlists.mjs           ← Unfollow all Rubin playlists (source: created_playlists ledger)
│   ├── purge-users.mjs, purge-users-except.mjs ← Tear down test users end-to-end
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
│   ├── post-deploy-health.mjs              ← Post-deploy sanity: cleanup ledger + daily-gen output + Redis state
│   ├── cleanup-orphaned-playlists.mjs      ← One-off (2026-08-27): direct-Spotify cleanup for the Aug-22 141-row backlog
│   ├── build-today-oneoff.mjs              ← One-off (2026-08-27): manually build today's daily playlists during the kill-switch window
│   ├── mirror-vercel-deployment.mjs        ← Pull deployment source via Vercel API
│   └── mirror-live-site.mjs                ← Pull deployed static assets via HTTP
├── benchmark-results/                      ← JSON outputs from benchmark script
├── prompt-history.md                       ← Audit log for EDITABLE_PROMPT_SECTION changes — update on every prompt edit
├── tests/                                  ← Legacy test scripts (mostly v3/v4 era)
├── .env.local                              ← Gitignored. Has ANTHROPIC_KEY, GEMINI_API_KEY, RUBIN_*, SUPABASE_*,
│                                              UPSTASH_REDIS_REST_KV_REST_API_URL/TOKEN, INTERNAL_API_KEY,
│                                              INTERNAL_ADMIN_API_KEY, CRON_SECRET, TRACK_ANALYSIS_*,
│                                              SUPABASE_AUTH (Resend key — see "Alerts via Resend"),
│                                              ALERT_EMAIL_FROM / ALERT_EMAIL_TO (optional overrides)
├── vercel.json                             ← Function timeouts, cron schedule (two: expire + generate-daily),
│                                              rewrites (incl. `/` → `/v6/index.html`), security headers
└── CLAUDE.md                               ← This file
```

Historically-referenced sandboxes that no longer exist: `v6/test-hours/`,
`v6/test-player/`, `v6/test-superlike/`. All three were deleted 2026-08-21
during the pre-pilot cleanup pass. If you need to iterate on the swipe or
hours UI in isolation, spin a fresh sandbox under a `v6/test-*/` slug and
wire it in `vercel.json`.

---

## KEY MECHANISMS (V6)

### The state machine — `v6/app.js goToStep(n)`

- One `state` object holds `bizName`, `bizDesc`, `confirmedPlace`, `atmosphereRows`, `selectedAtmos`, `hours`, `longestMinutes`, `directions`, `page2Promise`, `popularityWindow`, `picked`, `results`.
- Progress bar steps at top of screen ("תיאור העסק / בחירת אווירה / בחירת כיוונים / פלייליסטים לדוגמה") are **clickable** for any step the user has reached — clicking navigates back with pre-filled state. Downstream state is invalidated when going back so re-submitting refreshes it.
- Steps use AbortController: clicking back aborts the in-flight step's promise chain and re-enters at the target step.

### Prefetch pattern (background work during blocking user steps)

Applied twice in v6:
1. **Atmosphere rows** fire the moment the description page renders (`runBusinessStep`). Deduped via `atmosphereRowsPromise` so multiple call-sites don't fire twice.
2. **Preview prep** (`preparePreview`) chains onto the raw Claude promise the instant it lands. See "Progressive swipe-deck rendering" below for the full sequencing.

### Progressive swipe-deck rendering — `v6/preview.js`

`preparePreview` doesn't return a single "everything's ready" payload — it returns two independent promises:

```js
{ page1Ready, page2Ready }  // each resolves to { previews, trackMeta }
```

**Why:** page 1's four cards should show up as soon as page 1 is fully ready (anchors + metadata for those 4 tracks). Blocking page 1's metadata fetch until page 2 anchors also finish — the previous shape — wasted ~5-10s of user-visible wait for no reason.

**Inside `preparePreview`:**
- A `sequencedAnchors(dirs)` closure serialises the two anchor-tracks calls so page 2's query hits the warm `v5_anchor_tracks` plan cache (page 1 anchors → page 2 anchors, sequential). Metadata calls hit Spotify directly and don't need this — they run in parallel.
- `page1Ready`: anchors → metadata (4 tracks in parallel).
- `page2Ready`: waits for Claude page 2 → queues behind page 1 anchors via `sequencedAnchors` → its own metadata fetch. Runs concurrently with page 1's metadata.

**Inside `renderSwipeDeck`:** accepts `initialPreviews`, `initialTrackMeta`, and `page2Ready`. The `previews` and `trackMeta` are mutable in scope (`const previews = [...initialPreviews]`). When `page2Ready` resolves, its previews are `push`ed and `trackMeta` is `Object.assign`ed. `previews.length` is read inline every place a total is needed — the captured `total` const is gone.

**Edge case handled:** if the user swipes all 4 page-1 cards before page 2 arrives, `showCard` shows a `preview-load-column` "loading more" state inside the deck and parks a `waitingResume` closure. When `page2Ready` resolves, that closure fires and rendering resumes with the new cards.

**Progress label spinner:** `setProgress` sets `progLabel.innerHTML` (not textContent) so it can inline an `<span class="sb-spinner">` next to the `X/N` count until `page2Settled` flips true. Signals to the user that the denominator may still grow.

**Fallback shape:** `v6/app.js emptyPreparedPreview()` returns `{ page1Ready: Promise.resolve({previews:[],trackMeta:{}}), page2Ready: ... }` for error paths — matches the successful shape so `runDirectionPreviewFlow` doesn't need to branch.

### Scrubbable playback progress bar (per swipe card) — `v6/preview.js`

Each swipe card has a playback progress bar between the description line and the swap button. Not a separate iframe — it's a UI layer over the same hidden Spotify embed the custom play button drives.

- `pbState` (per-card): `lastPosition`, `lastTimestamp`, `duration`, `isPaused`, `dragging`, `pendingSeek`, `seekLockUntil`.
- The Spotify `playback_update` handler captures `position` and `duration` into `pbState` — but ignores `position` values while `Date.now() < pbState.seekLockUntil`. Spotify fires one more update with the stale pre-seek position after `controller.seek()` is called; that guard prevents the dot from briefly jerking back.
- A RAF loop (`pbTick`, self-terminates when `cardEl.isConnected` is false) interpolates position between the (sparse) `playback_update` events so the fill and thumb move smoothly.
- Click or drag on `.sw2-prog-bar` → calculates target seconds → `controller.seek(seconds)` + sets `pbState.lastPosition` + sets `pbState.seekLockUntil = Date.now() + 500`.
- Card swipe pointer guard extended to exclude `.sw2-prog-bar` (alongside `.swap-btn` and `.sw2-play`) so dragging the bar doesn't start a card swipe.
- On swap: `resetPbState()` zeroes everything so the new track starts at 0:00.
- CSS: outer `.sw2-prog-bar` has fixed 14px height (reserved layout space + touch hit area); the visible `.sw2-prog-track` inside is 6px at rest / 10px on hover; thumb appears on hover/drag. No layout shift when hovering.

### Musical directions — `v6/generation/musical-directions.js`

- **Model selection lives in one place**: `v6/generation/ai-provider.js`
  exports `PROVIDER` (`'gemini' | 'anthropic'`), `MODEL_GEMINI`, and
  `MODEL_ANTHROPIC`. Both v6 onboarding and Ami's prompt dashboard call
  through the shared `callModel()` there. Currently `PROVIDER='gemini'`,
  model `gemini-3.6-flash`, thinking=`high`. Anthropic path is retained
  and byte-for-byte tested (see the prompt-history audit rule), just not
  the default. Flip in one file to A/B either way.
- ~2400-token system prompt split into `EDITABLE_PROMPT_SECTION` (creative
  content Ami owns — genre universe, energy rules, pairing rules,
  emphases sub-rules including instrumentalness classification, title +
  description conventions) and `FIXED_PROMPT_SECTION` (schema / error
  contract that downstream parsing depends on).
- **Both sections are composed at load time from named sub-constants.**
  Refactored 2026-08-31 so `v6/generation/refined-directions.js`
  (Round 2) can `import` and reuse the shared parts — Genre Universe,
  Processing Rules, Energy & Pairing Constraints, Non-Overlap, Output
  Language, English-Title rules, Hebrew Description rules, and the full
  When-Not-To-Return error contract — without copy-paste drift. The
  composed EDITABLE + FIXED strings are byte-identical to the pre-
  refactor single-template-literal version (verified by test script),
  so Ami's dashboard imports `EDITABLE_PROMPT_SECTION` and sees the
  same textarea contents as before. `injectPlaces()` is also exported
  so R2 reuses the same Google-Places-block injection logic.
- Any edit to a shared sub-constant automatically flows to both R1 and
  R2 prompts. Edits to Round-1-only pieces (`ROUND1_INTRO`,
  `ROUND1_INPUTS_SECTION`, `ROUND1_TASK_WORKFLOW`, `ROUND1_OUTPUT_FORMAT`)
  affect only R1. R2 has its own corresponding sub-constants inside
  refined-directions.js.
- Ephemeral system-prompt cache via `cache_control` — applies only on
  the Anthropic path (Gemini has no equivalent; `callGemini` ignores
  the `cache: true` flag).
- Two parallel calls: `subset:'top'` for ranks 1-4, `subset:'next'` for
  ranks 5-8 (fed the top-4 output to avoid duplication). Under Anthropic
  the identical system prefix serves from cache after the first call.
- Returns `{directions, page2Promise}` — caller renders page 1 first,
  awaits page 2 later.
- Per-direction JSON payload includes `rank`, `title_en`, `genres`
  (flat list, no anchor), `description_he`, `bpm_range`, and
  `instrumentalness_preference` (`'none'|'soft'|'hard'` — see
  "Instrumentalness preference" mechanism below). `normalizeDirections`
  coerces + validates each field before handing to downstream code.

### Round 2 refinement flow — `v6/generation/refined-directions.js`

Fires only when the R1 preview swipe deck yielded fewer than 3 liked directions (0, 1, or 2). Same provider (`callModel` from ai-provider.js), same underlying `/api/v6/gemini` proxy, different system prompt and different labeling.

**System prompt** — assembled at module load from R2-specific sub-constants + shared sub-constants imported from `musical-directions.js`. R2-specific pieces:
- `REFINED_INTRO` — "You are refining a previously generated set..."
- `REFINED_INPUTS_SECTION` — documents the input format including the R2-only fields (Round 1 directions, LIKED / DISLIKED buckets, SUPER-LIKED GENRES, Round-2 refinement emphases).
- `LEARNING_LOGIC_SECTION` — 6-step reasoning skeleton: extract positive seeds → extract negative constraints → identify bridge genres (energy / tempo / production / cultural adjacency / atmospheric fit) → honor Musical Emphases → zero-Liked special case → Round 2 refinement emphases override (highest priority when present).
- `REFINED_NON_OVERLAP_SECTION` — R2-scoped non-overlap: within R2 ≤ 1 shared genre per pair; vs. R1-Liked may share multiple genres (similar-but-not-identical is encouraged); vs. R1-Disliked must not share more than 1 genre.
- `REFINED_TASK_WORKFLOW` — "generate exactly 4 directions" + super-liked-genre bias (spread across separate outputs when energy allows) + BPM ceiling rule + inst_pref inheritance.
- `REFINED_OUTPUT_FORMAT` — schema example with `exactly 4 directions`.
- `ROUND2_ADDITIONAL_ERROR` — new `insufficient_signal` error code (0 likes AND contradictory dislikes AND thin positive inputs).

**Signal priority hierarchy** (highest first) — enforced by the prompt:
1. **Round 2 refinement emphases** (freshest, most explicit — overrides everything below when contradictory)
2. Round-1 Musical Emphases
3. Super-liked genres (from state.superLikedGenres.values())
4. Liked directions (full R1 direction spec)
5. Disliked directions (negative filter)
6. Description + Atmospheres + Google Places (contextual)

**Client wiring** (v6/app.js step-5 handler): after R1 preview resolves with < 3 picks, the block does:
1. `runRefinedEmphasesStep({initialValue: state.round2Emphases})` — capture optional refinement text
2. `fetch('/api/v5/prewarm')` — fire-and-forget, warms Supabase plan cache in parallel with the Gemini call
3. `generateRefinedMusicalDirections({...})` with all R1 context + likedDirections + dislikedDirections + `superLikedGenres: [...new Set(state.superLikedGenres.values())]` + `round2Emphases` + `onboardingSessionId`
4. `runRefinedDirectionPreviewFlow({...})` — single-page 4-card swipe deck. Throws (not returns []) when it can't render any cards, so the caller distinguishes "swiped left on all" from "preview couldn't render".
5. On thrown / errored / empty: `showR2FailureScreen({hasR1Picks})` — loops on retry, exits on continue / restart.
6. On success: R2 picks appended to state.picked; if merged total is 0, restart screen.

**Persistence**: R2 liked directions land in `state.picked` and get persisted to `business_directions` at signup identical to R1 picks. No schema difference downstream — the direction-edit chat, daily-gen cron, dashboard rendering all treat R2-origin directions the same. `gemini_call_log` rows for R2 carry `label='onboarding-refined'` (contrast with R1's `label='onboarding'`), attributed to the same `onboarding_session_id` and backfilled with `business_id` at signup by the same UPDATE.

**Cost profile**: R2 typically ~30s Gemini call at ~6-11k tokens (thinking=high). Fires in a minority of sessions (< 3 R1 picks trigger). Only fired once per R1 outcome — retries re-fire but only when the previous R2 attempt hard-failed (Gemini error or empty preview). Admin API `by_label[]` in `/api/internal/gemini-spend` breaks it out separately.

### Genre list — `v6/generation/genre-list.js`

Shared canonical menu, currently 113 entries (as of 2026-09-02) — count moves as Ami digests new genres. `api/v6/account/event-playlist.js` (Claude Haiku prompt) imports from here; `musical-directions.js` maintains its own copy via `GENRE_UNIVERSE_SECTION`. Kept in sync with the exact strings stored in `playlist_genres.genre` in Supabase — the RPCs lowercase-match. Grew from 73 → 105 across 2026-08 as Ami added new genres to Data Box Tab 2 and RapidAPI batch runs digested their seed playlists into `track_analyses`; further churn (add / remove) has continued since. **This file is one of THREE genre-list locations that need manual sync — see the "Genre Universe invariant" rule under PROMPT EDITING PROTOCOL for the full list and the drift-check obligation.** (The direction-edit chat prompt imports from `musical-directions.js` at runtime, so it's no longer a manual-sync target.)

### Playlist auto-expiry

Every playlist created via `/api/new/spotify` create_playlist gets a row in
`created_playlists` (`spotify_id`, `name`, `expires_at`, `deleted_at`,
`error`, plus `attempts`, `last_error`, `next_attempt_at`, `alerted_at`
added 2026-08-29). Hourly cron `/api/cron/expire-playlists` (scheduled
`30 * * * *`) picks up eligible rows and unfollows on Rubin's side
(rename → empty → unfollow → mark `deleted_at`; 404 treated as
already-gone via `isGone`).

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

`user_metadata.b[bizId].playlists[i].expiresAt` (ms) mirrors the ledger
`expires_at` and drives dashboard visibility: `playlistIsLive(p)` filters
expired entries out of the render loop, `hasPlaylistsForToday()`, and
`activePlaylistForEvent()`. Missing `expiresAt` is treated as live
(backward-compat for pre-per-day entries; the cron still cleans them up on
their old 24h clock).

### Daily-gen cron (`/api/cron/generate-daily`)

Runs hourly. For each business (serial outer loop — cross-business
parallelism would race on the shared Rubin Spotify token + burn DB
plan cache):

1. Skip `not-onboarding-done` if `!business.onboarding_expanded`.
2. Skip `no-hours` if `business_hours` row missing / malformed.
3. Skip `closed-today` if `hours[dayIdx].closed = true`.
4. Skip `past-close` if `now > dailyPlaylistExpiryIso({hours, now})` —
   today's window (close + 2h in IL) has already ended. **This guard
   was added 2026-08-22** after the cron was found to be re-firing every
   hour after close for any business whose window had passed, since the
   playlists it created were born already-expired.
5. Skip `already-built-today` if any `business_playlists` row exists with
   `event_id IS NULL AND created_at::date = today (IL)`. Dedup key is
   BUILD DATE, not live-status. (Previously `anyFreshToday` also required
   `expires_at > now`, which failed for expired same-day rows and caused
   the hourly-rebuild loop above.)
6. Skip `too-early` if `now < today's open - 2h` (Asia/Jerusalem).
7. Skip `no-directions` if `activeDirections(business.id)` returns empty
   (reads `business_directions WHERE active=true`, the permanent per-biz
   direction table — no more reconstructing from playlist history).
8. Build via shared `buildDailyBatch()` in `_daily-builder.js`. One
   Spotify playlist per direction, with `BUILD_CONCURRENCY=1` + a 3s
   stagger between playlists (dropped from `Promise.all` → `CONCURRENCY=2
   / stagger=300ms` on 2026-08-22, then to fully serial with 3s stagger
   on 2026-08-29 as part of the resilience layer). Outer loop also
   sleeps 5s between businesses. Combined pacing keeps sustained write
   rate < 30/min per cron tick. Single batch INSERT into
   business_playlists at the end.
9. Ledger row's `expires_at` reuses the `todaysExpiryIso` computed for
   the past-close check in step 4 (same source of truth as the
   `business_playlists.expires_at` column).
10. Opportunistic prune: DELETE `v6_daily_track_history` rows > 14 days old.

Auth: `Authorization: Bearer ${CRON_SECRET}` (same as `expire-playlists`).

**Related hardening in the Spotify proxy**: see the "Spotify resilience
layer" mechanism below for the full 2026-08-29 rewrite. The daily-gen
guards prevent the trigger conditions; the resilience layer catches
what does slip through and stops it from escalating.

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
- `/api/v6/account/signup` — 20/hour (per IP; abuse-mitigation)
- `/api/v6/account/direction-chat` — 20/min (profile-tab chat turn)
- `/api/v6/account/preview-direction` — shares the `anchor-tracks` bucket (60/min)
- `/api/v6/account/apply-direction-change` — 10/min (commits add/edit/remove)
- `/api/v6/account/toggle-super-like` — 60/min (super-like button toggle in the preview modal)
- `/api/v6/account/log-playlist-open` — 120/min (dashboard "▶ פתח" click log; higher than other write endpoints because bursty clicking through several playlists is legitimate)

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

## DATA MODEL (V6)

### `auth.users.raw_user_meta_data.sonic`

Everything the account dashboard reads lives here:

```json
{
  "onboarding": {
    "bizType": null,
    "atmospheres": ["אלגנטי", "קליל"],
    "place": { "name": "...", "address": "...", "photo_url": "...", "hours": {...} }
  },
  "currentBizId": "<uuid>",
  "b": {
    "<businessId>": {
      "playlists": [
        {
          "ico": "🎵",              // 🎪 for event playlists
          "label": "Direction title",
          "url": "https://open.spotify.com/playlist/...",
          "id": "<spotify_id>",
          "trackCount": 10,          // starts at 10, grows to ~120 after expansion
          "genres": [...],
          "createdAt": "2026-08-01",
          "expiresAt": 1723456789000, // ms. Daily = 2h after that day's close.
                                     // Event / closed-day = next 04:00 IL.
          "eventId": "<uuid>",       // back-ref for event playlists only
          "expansion": {             // present on onboarding playlists only
            "direction": { "title_en", "description_he", "genres", "bpm_range" },
            // Legacy shape (pre-2026-08-13) also supported by readers:
            //   "direction": { ..., "anchor_genre", "secondary_genres", ... }
            "popularityWindow": [lo, hi]
          },
          "expandedAt": 1723456789000 // set after expand-playlist finishes (per-playlist)
        }
      ],
      "onboardingExpanded": true, // set BEFORE the first expansion pass; strict
                                  // one-time guard preventing any re-expansion
      "events": [
        { "id": "<uuid>", "name": "first line of description", "description": "full text" }
      ],
      "hours": {
        "0": { "closed": true },
        "1": { "closed": false, "open": "10:00", "close": "22:00" },
        // ... 2..6
      },
      "longestMinutes": 720
    }
  }
}
```

### Supabase tables

**Reference / catalog (populated by Ami's scans + precompute):**
- `atmospheres` — { name, ranges, row_in_sheet }. Populated by Ami's scan endpoint.
- `biztype_genres` — { business_type, genre, column_letter, position_in_column }. Ami's other scan.
- `playlist_genres` — playlist_id ↔ genre + position_in_genre.
- `playlist_tracks` — playlist_id ↔ spotify_id + position.
- `track_analyses` — spotify_id + typed audio-feature columns (tempo, popularity, energy, `instrumentalness`, valence, etc.) + raw_analysis jsonb.

**Per-business production data (owned by v6 signup + dashboard):**
- `businesses` — { id, owner_id, name, monthly_credits, credits_remaining, business_description, musical_emphases, onboarding_expanded }. Written by signup. `business_description` + `musical_emphases` are the free-text prompt inputs the owner typed during onboarding (bizDesc + step-3 emphases); added 2026-08-23 for the internal admin API. PATCH path in signup.js skips blank values so repeat-onboarding with an empty field doesn't clobber a previously-recorded prompt.
- `business_directions` — permanent per-business direction storage. Columns: { id, business_id, rank, title_en, description_he, genres (jsonb), bpm_range (jsonb), popularity_window (jsonb), **instrumentalness_preference** (`'none'|'soft'|'hard'`, added 2026-08-21), **popularity_preference** (`'none'|'soft'|'hard'`, added 2026-09-02), active (bool, soft-disable), created_at, updated_at }. Added 2026-08-20 migration — replaced the fragile "reconstruct directions from recent playlist_playlists.expansion" approach that cascaded to zero when the cron partially failed. Now the source of truth for daily-gen; `activeDirections(bizId)` in `_daily-builder.js` reads from here.
  - **8-active cap enforced by DB trigger** (`business_directions_cap`, added 2026-08-29). BEFORE INSERT OR UPDATE, per-business advisory-lock + count-active, raises `check_violation` if the write would push active count > 8. Closes the TOCTOU race in apply-direction-change's app-level check and rejects crafted signup payloads. Signup.js still trims client-side to the first 8 so a legitimate 8-pick onboarding never hits the trigger; apply-direction-change still returns its own friendly `cap_reached` code before the trigger fires so end-users see a nice message rather than a raw exception. Trigger is the last-line defense. See `v5/precompute/migrations/2026-08-29-directions-cap-trigger.sql`.
- `business_playlists` — one row per built Spotify playlist (onboarding sample, expanded daily, cron-generated daily, or event). Columns include { spotify_id, business_id, url, label, ico, track_count, genres, bpm_range, expansion (jsonb, legacy), event_id (nullable back-ref), direction_id (nullable FK → business_directions), track_ids (jsonb, ordered), expanded_at, expires_at, created_at }. Nothing deletes rows — `expires_at` gates dashboard visibility only.
- `business_hours` — one row per business: { business_id, hours (jsonb — 0..6 day map with `{open,close,closed}`), longest_minutes, updated_at }. Upsert on business_id.
- `business_place` — one row per business (Google Places snapshot): { business_id, place_id, name, address, primary_type, types, editorial_summary, price_level, website_uri, vibe (jsonb), updated_at }. Upsert on business_id.
- `business_events` — { id, business_id, name, description, created_at }. Owner's chat-generated one-off event descriptions.
- `super_liked_tracks` — { id, business_id, spotify_id, created_at, UNIQUE(business_id, spotify_id) }. Persisted at signup from `state.superLikedTracks`; also topped up by the direction-edit preview modal when the owner taps super-like on a track. Nothing consumes yet — captured for future taste-tuning.
- `business_playlist_opens` — { id bigserial, business_id, spotify_id, source ('home-daily' | 'home-event' | future), opened_at }. Append-only engagement log. One row per dashboard "▶ פתח" click. Not FK'd to `business_playlists` (matches `super_liked_tracks` pattern) — join manually on `spotify_id` when analyzing. `business_playlists` rows are never deleted (only `expires_at`-gated), so a click yesterday still resolves to its direction / genres / track_ids today. Client writes via fire-and-forget `POST /api/v6/account/log-playlist-open`; navigation to Spotify is never blocked on the write. Added 2026-08-26.
- `business_direction_chats` — { id, business_id, role ('user'|'assistant'), content (raw JSON for assistant / plain text for user), proposal (jsonb — parsed structured payload attached to an assistant turn: `{kind, direction_id?, updates?, spec?}`), selected_direction_id (nullable FK, which card the owner had selected when they sent this), created_at }. Rolling per-business message log for the profile-tab direction-edit chat. Client renders the transcript on tab open; server loads the tail (last 40) as Gemini chat history each turn.
- `business_direction_changes` — { id, business_id, direction_id (nullable — null when the pre-insert direction hasn't landed yet), kind ('add'|'edit'|'remove'), before (jsonb direction snapshot), after (jsonb direction snapshot), message_id_first, message_id_last (nullable FKs into business_direction_chats — the message range that produced this change), playlist_action ('rebuilt'|'expired'|'kept'|'renamed'|null), applied_at }. Written by `/api/v6/account/apply-direction-change` on every commit; surfaced by the internal admin API as the audit feed per business. `'renamed'` was added 2026-09-02 for the cosmetic-only edit fast path (title / description-only chat edits) — see the migration `2026-09-02-direction-changes-renamed-action.sql`.

**Ledgers + operational state:**
- `created_playlists` — the expiry ledger. Columns: `spotify_id` (PK), `name`, `expires_at`, `deleted_at`, `error`, `owner_id` (nullable FK → auth.users), `business_id` (nullable FK → businesses). Both FKs use ON DELETE SET NULL so the cron can still unfollow expired playlists after their owner/business is deleted. Rows written by onboarding (via /api/v5/record-playlist) start with NULL owner/business — signup.js back-fills them. Renamed from `v5_created_playlists` on 2026-08-02; migration in `v5/precompute/migrations/`.
- `v6_daily_track_history` — { business_id, direction_key, spotify_id, served_at }. Per-(biz, direction) served-track history for cross-day dedup. See "Cross-day track dedup" mechanism below. Cron opportunistically prunes rows older than 14 days.
- `gemini_call_log` — one row per Gemini API call. Columns: { id, created_at, model, label, input_tokens, output_tokens (includes thinking tokens for cost purposes), thinking_tokens (broken out for analytics), total_tokens, cost_usd (numeric 12,8), business_id (nullable FK), onboarding_session_id (nullable text), http_status, finish_reason }. Written fire-and-forget by `api/v6/gemini.js` after every call — success OR failure. Cost computed server-side via `api/v6/gemini-pricing.js` using date-aware per-model rates (Google's paid Standard tier; auto-switches on 2027-01-01 when the price doubles). Label values in use: `onboarding` (Round-1 musical directions), `onboarding-refined` (Round-2 refinement — added 2026-08-31; see the "Round 2 refinement flow" mechanism above), plus post-signup labels for event chat / direction-edit chat / preview-direction. Attribution: post-signup callers pass `business_id` directly; onboarding callers pass a client-generated tab-lifetime `onboarding_session_id` which `signup.js` backfills into `business_id` (and clears the session id) on account creation — this applies to both `onboarding` and `onboarding-refined` label rows since R2 fires during the same tab-lifetime session as R1. Rows with `onboarding_session_id` set but no `business_id` = "abandoned onboarding" bucket surfaced by the internal admin spend endpoint. Added 2026-08-25; RLS on with no policies (writes go through service_role).

**Cleanup archives (Ami's dashboard):**
- `deleted_tracks` — archive keyed by `spotify_id`. Snapshot of the track's `playlist_tracks` rows + its `track_analyses` row before deletion. Written by `api/v4/ami-track-delete.js`; consumed and dropped by `api/v4/ami-track-restore.js`. RLS on with no anon-read policy (dashboard hits go through service_role).
- `deleted_playlists` — archive keyed by `playlist_id`. Columns: { playlist_id (PK), name, owner, playlist_genres_rows (jsonb), playlist_tracks_rows (jsonb), deleted_at }. Written by `api/v4/ami-playlist-delete.js`; consumed and dropped by `api/v4/ami-playlist-restore.js`. Added 2026-08-30 (migration `2026-08-25-deleted-playlists.sql`). Same RLS posture as `deleted_tracks`. **Does not archive `track_analyses`** — that cache is shared with any other playlist the tracks live in and is expensive to rebuild via RapidAPI.

**Historical / vestigial:** `analyses`, `track_feedback`, `app_settings` (old OpenAI key storage — the `openai_key` row + its permissive RLS were removed during the 2026-08-14 security audit), `spotify_tokens` (v1 era).

### Track pool coverage

**~114k successfully-analyzed tracks** in `track_analyses` as of 2026-08-26 (up from ~90.5k a month earlier — manual CLI batches through the RapidAPI worker filled in the new genres). This is the pool `v5_direction_tracks` and `v6_direction_tracks_recent` select from. To refresh the count: `grep -Ec "\] ok [A-Za-z0-9]{22} " v4/precompute/state/batch.log`. **Do not trust exploration-agent estimates over this number** — an Explore agent once returned a bogus 31k and misled a planning session. Distribution across the 105 canonical genres is uneven; biz types added earlier (café, pizzeria) have deeper pools than newly-added Latin / Asian / world-fusion genres.

---

## SPOTIFY SETUP

### Two-app architecture (unchanged)

- **Michael's app** (`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`): Client Credentials reads of public-playlist tracks (grandfathered access to the deprecated `GET /playlists/{id}/tracks` endpoint).
- **Rubin's app** (`RUBIN_SPOTIFY_CLIENT_ID` / `RUBIN_SPOTIFY_CLIENT_SECRET`): user-context writes on the dedicated "Robin - Sonic Brands" account (id `316gotb2mutzdjmghprpgmxwq62i`).

### `RUBIN_REFRESH_TOKEN` scope

Currently seeded with `playlist-modify-private` + `playlist-modify-public` (verified via `scripts/test-rubin-spotify.mjs` — the refresh returns both scopes). **Cannot enumerate the account's playlists** — `GET /me/playlists` returns 403 "insufficient client scope" because neither `playlist-read-private` nor `playlist-read-collaborative` is present.

If you need enumeration (e.g., cleaning up pre-ledger cruft), re-seed with wider scope:

```
https://accounts.spotify.com/authorize?client_id=431c55feb024444c979f2aa51e04426d&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fnew%2Frubin-oauth-callback&scope=playlist-modify-private%20playlist-modify-public%20playlist-read-private&show_dialog=true
```

Otherwise, `scripts/purge-rubin-playlists.mjs` uses the `created_playlists` ledger as the enumeration source instead — no scope needed.

**Known 403 quirk on `DELETE /playlists/{id}/followers`:** occasional 403 "Insufficient client scope" when the expire cron tries to unfollow a playlist Rubin's app created hours earlier — even though rename + empty on the same playlist in the same tick succeed. First observed 2026-09-01 on a `בלנד 5 · Boutique World Funk & Ethio-Jazz` daily-gen playlist. Rename + empty succeed silently, unfollow 403s, `expirePlaylistNow` catches it as best-effort and marks `deleted_at` anyway → the playlist stays in Rubin's library as `(expired) <name>` with 0 tracks (cruft). Suspected trigger: `create_playlist` sets `collaborative: true` (see [api/new/spotify.js](api/new/spotify.js)), which may have quirky scope semantics on the follower-DELETE endpoint. If this becomes systematic, either (a) drop `collaborative: true` in create_playlist, or (b) treat unfollow 403s as retriable so the row stays eligible on next tick.

### Development mode

Rubin's app is in Development Mode (25-user cap on OAuth users). Only relevant for pre-v5 flows that OAuth'd end users. v6 uses Rubin's refresh token exclusively, so this cap doesn't apply to v6 playlist creation.

---

## SUPABASE PERFORMANCE NOTES

### `statement_timeout` raised to 15s

Supabase's default `statement_timeout` on the `authenticator` role is **3s**. Cold Postgres connections need to compile query plans, which for non-trivial RPCs (`v5_anchor_tracks`, `v5_direction_tracks` — JOINs across playlist_tracks + playlist_genres + track_analyses with random ordering) can push past 3s → error code **57014** "canceling statement due to statement timeout".

**Fix applied:** ran `ALTER ROLE authenticator SET statement_timeout = '15s'; NOTIFY pgrst, 'reload config';` in Supabase SQL Editor.

### Retry-on-57014 in `api/v5/supabase-client.js`

Belt-and-suspenders. `pgrRequest` catches errors whose message contains `"57014"` and retries once after 300ms. Since the 15s timeout raise, this rarely fires — but is kept as a safety net for edge cases (connection pool churn, etc.).

### Atmospheres endpoint has NO server-side cache

`/api/v5/databox-atmospheres` used to have a 30-min in-memory cache. **Removed** so that Ami's atmospheres-scan changes are immediately visible without a stale window. The client hides the ~100-500ms Supabase read behind the description page's typing time. Response is `Cache-Control: no-store`.

---

## MODEL CHOICES (V6)

### Current choices

| Feature | Model | Where selected | Rationale |
|---|---|---|---|
| Musical directions (main flow) | `gemini-3.6-flash`, thinking=high | `v6/generation/ai-provider.js` `PROVIDER='gemini'` | Faster + cheaper than Sonnet at comparable quality once thinking=high is set; better JSON compliance with `responseMimeType`. Flip `PROVIDER` back to `'anthropic'` in that one file to revert. |
| Event chat (special-events dashboard) | `gemini-3.6-flash`, thinking=low | `v6/account/app.js` (chat state machine) | Multi-turn JSON, low latency for a chat feel. Prompt in `v6/generation/event-chat-prompt.js`. |
| Direction-edit chat (profile-tab) | `gemini-3.6-flash`, thinking=low, max_tokens=3000 | hardcoded in `api/v6/account/direction-chat.js` | Same rationale as event chat — multi-turn JSON, low latency. Prompt in `v6/generation/direction-edit-chat-prompt.js`. Kept distinct from the ai-provider switch used for musical directions. |
| Event playlist genre+BPM extraction | `claude-haiku-4-5-20251001` | hardcoded in `api/v6/account/event-playlist.js` | Fast one-shot classify; kept on Anthropic because the task is narrow + the Haiku path is well-tested. |
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

Ami also has a separate **prompt-tuning dashboard** at `/v5/ami-prompt-dashboard/`
that imports `EDITABLE_PROMPT_SECTION` from `v5/generation/musical-directions.js`
and lets him edit + preview the prompt output before it goes to prod. That
dashboard uses the same `ai-provider.js` switch as v6, so whatever provider
production is on, Ami's testing is on the same one. He also has a "דגשים
מוזיקליים" textarea there that mirrors the onboarding field, so he can
test emphases + instrumentalness classification behavior end-to-end.

The dashboard's prompt assembly runs through a **lenient wrapper**
`normalizeForProdAssembly` in `v5/ami-prompt-dashboard/app.js` (added 2026-08-30)
before calling the prod `assembleSystemPrompt` helper. It widens the Google
Places anchor regex so Ami's edits don't have to preserve the exact anchor
whitespace / heading form that prod's strict `injectPlaces()` requires —
without this, Ami saw cryptic "התגובה לא הייתה JSON תקין" errors when the
Places blocks failed to inject and the model got a malformed prompt. The
wrapper applies ONLY to the dashboard preview path; prod's `injectPlaces`
is unchanged and still fails-loud on anchor mismatches. When Ami's tuned
prompt is ready to ship, Roni is the one injecting it into prod and
manually reconciling any anchor formatting.

Because the atmospheres endpoint has no server cache, Ami's scan is
immediately visible to v6 onboarding sessions without waiting for cache
expiry.

---

## INTERNAL ADMIN API (Michael's dashboard)

Read-only endpoints under `api/internal/*` for Michael's forthcoming admin dashboard (his own repo, host TBD — not in this repo). Auth: single shared bearer token in `INTERNAL_ADMIN_API_KEY` env var, presented as `Authorization: Bearer <key>` or `x-internal-admin-key: <key>`. CORS is `*` because the bearer token IS the security boundary (no cookies, so cross-origin attacks can't attach it). Fail-CLOSED on missing env — misconfig 500s loudly, same philosophy as `requireSiteOrInternal`.

- `GET /api/internal/users` → `{ count, businesses: [ { business_id, name, owner_id, owner_email, created_at, has_prompt } ] }`. `has_prompt` is true iff `business_description` or `musical_emphases` is non-null (rows signed up after the 2026-08-23 migration).
- `GET /api/internal/business?id=<uuid>` → full detail: `{ business, onboarding: { business_description, musical_emphases, atmospheres }, place, hours, directions[], playlists[], direction_changes[], chat_transcript[], gemini_spend: { total_usd, call_count, by_label[] }, gemini_calls[], cleanup_backlog[], playlist_opens[], playlist_opens_summary: { total, by_playlist[], by_source[] } }`. `playlists[].track_ids` is the ordered Spotify-ID array as of build time (null for pre-2026-08-20 rows). `direction_changes[]` and `chat_transcript[]` are the profile-tab direction-edit chat's audit + full message log (empty for owners who haven't used the chat yet). `gemini_spend` + `gemini_calls[]` are this business's Gemini API cost rollup + every logged call (both onboarding calls backfilled at signup and post-signup chat calls) — both zero/empty for businesses that signed up before 2026-08-25 when call logging started. `cleanup_backlog[]` (added 2026-08-29) is any `created_playlists` row for this business that is past-expired, not yet deleted, AND has failed at least once (attempts >= 1) — worst-offender first; empty for healthy businesses. `playlist_opens[]` + `playlist_opens_summary` (added 2026-08-30) are the dashboard "▶ פתח" click log for this business (raw log capped at 1000, plus rolled-up counts by playlist and by source).
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
| `ANTHROPIC_KEY` | `api/v5/anthropic.js`, `api/v6/account/event-playlist.js` | Sonnet 4.6 + Haiku 4.5. Anthropic path is on standby; Gemini is production. |
| `GEMINI_API_KEY` | `api/v6/gemini.js` | Google `x-goog-api-key`. Powers musical directions + event chat. |
| `OPENAI_API_KEY` | `api/v6/transcribe.js`, legacy proxies | Env-only. The old Supabase `app_settings.openai_key` fallback was removed during the 2026-08-14 security audit (was readable via the public anon key). |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Michael's app for CC reads | Hardcoded copy of client_id in v3/app.js for legacy OAuth |
| `RUBIN_SPOTIFY_CLIENT_ID` / `RUBIN_SPOTIFY_CLIENT_SECRET` | Rubin's app for user-context writes | client_id: `431c55feb024444c979f2aa51e04426d` |
| `RUBIN_REFRESH_TOKEN` | `api/new/spotify.js` refreshUserToken | Scope: `playlist-modify-private` only. Re-seed for wider scopes. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | All v5/v6 endpoints via api/v5/supabase-client.js | Anon safe to expose client-side; service role server-only |
| `INTERNAL_API_KEY` | `api/v6/origin-guard.js requireSiteOrInternal`; passed as `x-sonic-internal` header for server-to-server calls into `api/new/spotify.js`; also rate-limit bypass in `api/v6/ratelimit.js` | Fail-open if not set. |
| `INTERNAL_ADMIN_API_KEY` | `api/internal/_guard.js requireAdmin` — Michael's dashboard bearer token | Fail-CLOSED if unset (500s the endpoint). Must be set in Vercel prod + `.env.local`; share the value with Michael out-of-band. |
| `UPSTASH_REDIS_REST_KV_REST_API_URL` / `_TOKEN` | `api/v6/ratelimit.js`, `api/new/spotify.js` (pause switch + daily write counter) | Auto-injected by Vercel's Upstash integration with the `UPSTASH_REDIS_REST` custom prefix. If unset, rate limiting is DISABLED (fail-open) and one warning line prints at cold start. Same fail-open behaviour for the pause switch — logs a warning then proceeds without global backpressure. |
| `SUPABASE_AUTH` | `api/_alert.js` sendAlert; Supabase Dashboard → Auth → SMTP for magic-link emails | Resend API key (prefixed `re_`). Named `SUPABASE_AUTH` because it was originally added for Supabase's SMTP config — same key powers our operational alert emails now. Fail-open if unset. Set in Vercel + `.env.local`. |
| `GOOGLE_PLACES_API_KEY` | `api/v6/place-lookup.js` | Optional — endpoint silently skips if unset. Currently sensitive in Vercel + set to empty on some environments. |
| `CRON_SECRET` | `api/cron/expire-playlists.js`, `api/cron/generate-daily.js` auth check | Vercel Cron sets `Authorization: Bearer <secret>` header |
| `V6_ACCOUNT_REDIRECT_URL` | `api/v6/account/signup.js accountRedirectUrl` | Optional pin. When unset, magic-link redirect derives from request host (validated against `isAllowedHost`). |
| `TRACK_ANALYSIS_RAPIDAPI_KEY` | `v4/precompute/batch.mjs`, `api/v4/track-analysis.js` | RapidAPI plan quota tracked in `.rapidapi-call-count.json`. The *automated cron* is off (ami-cron-tick killed 2026-08-13) but the CLI batch worker `node v4/precompute/batch.mjs` is still run manually to digest new genres as Ami adds them. Key rotated 2026-08-25 after a paid-tier upgrade — the old key kept returning provider-side errors on the higher tier; new key resolved it. Regen a key at RapidAPI dashboard → your app → security. |
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
- Function `maxDuration` per endpoint (30s default; 60s for anthropic + gemini + transcribe + event-playlist + expand-playlist + generate-daily; 300s for the cron entrypoints)
- **Cron schedule (two hourly crons, deliberately staggered)**:
  - `/api/cron/generate-daily` at `0 * * * *` — per-business daily playlist builder (see the Daily-gen cron mechanism above for the full skip-reason list)
  - `/api/cron/expire-playlists` at `30 * * * *` — sweeps expired ledger rows (rename + empty + unfollow on Rubin). Moved off `:00` on 2026-08-29 as part of the resilience layer so it can't overlap top-of-hour daily-gen writes.
  - `/api/v4/ami-cron-tick` was **removed** from the cron schedule on 2026-08-13. Endpoint file still exists so it can be revived, but nothing schedules it now.
- Cache headers: `no-cache` for `/` + `/index.html` + all `/vX/*` paths
- Security headers (global): `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(self), camera=()` — added during the 2026-08-22 security audit
- Rewrites: `/` → `/v6/index.html` (added 2026-08-20, replaced the deleted legacy root index.html), plus per-version paths `/v6`, `/v6/account`, `/v5`, `/v5/ami-prompt-dashboard`, `/v4`, `/v4/ami`, etc.

### Cache busting

`v6/index.html` script tag uses `?v=DDMMYYYY{letter}` (e.g., `02082026a`). Bump when JS/CSS changes — and bump the matching `?v=` on every `import` inside `v6/app.js` too (they use the same query so browsers pick up the new module bytes).

`v6/account/index.html` similarly at `01082026b`.

**Server-shared modules must NOT use `?v=` on their internal imports.** Node's ESM loader treats the query string as part of the filename and prod cold-deploys crash with `Cannot find module './foo.js?v=...'`. `vercel dev` sometimes strips the query (loader-chain dependent) so this passes locally but breaks on Vercel. The specific offender that took down `/api/v6/account/direction-chat` on 2026-09-02 was `v6/generation/musical-directions.js` importing `./ai-provider.js?v=25082026a` — that file got pulled into the server bundle transitively when `direction-edit-chat-prompt.js` started importing rule sub-constants from it (2026-08-31), and the chat prompt is in turn imported by the server-side chat endpoint. Any module that is (or might become) transitively reachable from an `api/` file must use bare `import 'x'` / `import './x.js'` — no query. Browser cache freshness for those modules is handled by the `Cache-Control: no-cache` header on `/v6/*` in `vercel.json` (browsers revalidate on every load), so the `?v=` bump was redundant there anyway.

---

## PROMPT EDITING PROTOCOL

Two musical-directions prompts exist and both are tracked in `prompt-history.md`:

- **Round 1** — `EDITABLE_PROMPT_SECTION` + `FIXED_PROMPT_SECTION` in `v6/generation/musical-directions.js`, both composed from named sub-constants. Mirrored byte-for-byte in `v5/generation/musical-directions.js` — Ami's dashboard reads the v5 copy.
- **Round 2** — R2-specific sub-constants inside `v6/generation/refined-directions.js`, composed on top of shared sub-constants imported from R1's file. No v5 mirror (R2 is v6-only).

**Any edit to either prompt** — including edits to shared sub-constants (which affect both R1 and R2 automatically) — appends a NEW entry at the top of `prompt-history.md`. Each entry MUST include:
- An **Applies to:** line: `Round 1` / `Round 2` / `both`
- Today's date + one-sentence summary of what changed and why
- The FULL text of the changed sub-constants (for a substantive content change) OR a clear diff description (for a structural/refactor change with byte-identical output). Never delete old entries — the file is the audit log.

If the edit touches a shared sub-constant, mark `Applies to: both` and note both prompts are affected. If it touches only Round-1-specific pieces (`ROUND1_*`), mark `Applies to: Round 1`. Same for R2. Verify v5 mirror is still byte-identical to v6 for `EDITABLE_PROMPT_SECTION` and `FIXED_PROMPT_SECTION` after every edit (composition should keep them in sync as long as you edit them in the same way).

### Genre Universe invariant (MUST-FLAG rule)

The genre universe is enumerated in **THREE code locations** today (down from four on 2026-09-02 when the direction-edit chat prompt started importing R1's `GENRE_UNIVERSE_SECTION` instead of embedding a verbatim copy). The Round-1 prompt is the SOURCE OF TRUTH; the other two are downstream copies that must stay in sync verbatim (case-insensitive, but spelling must match):

1. `v6/generation/musical-directions.js` → `GENRE_UNIVERSE_SECTION` (**source of truth** — R1 + R2 prompts, and now transitively the direction-edit chat prompt via import)
2. `v5/generation/musical-directions.js` → `GENRE_UNIVERSE_SECTION` (byte-identical mirror; Ami's dashboard reads it)
3. `v6/generation/genre-list.js` → `GENRES` array (event-playlist Haiku prompt)

**Assistant behavior rule:** at the start of any session that touches prompts, genres, or the batch worker, verify all three lists contain the same set of genre strings. If ANY difference exists — a genre in one place and not another, an extra genre, a rename, a typo, a casing divergence between the source-of-truth and a downstream copy — **flag it to the user immediately and unprompted, before doing any other work on that request.** Do not silently pick one side or defer the flag; the drift is a real bug (silent DB-lookup drops for the affected genre) even when it looks cosmetic. The check is cheap; a scratch script can grep and compare all three in seconds.

If the user is adding, removing, or renaming a genre, the change MUST land in all three code locations in the same commit. If one place is out of scope for the current work, tell the user so they can decide whether to fix the drift now or explicitly defer it. The direction-edit chat prompt no longer needs manual sync — its `## Genre Universe` block is the imported R1 constant at runtime.

---

## COMMON TASKS

### Run v6 locally
1. `vercel dev` (reads cloud env)
2. Open `http://127.0.0.1:3000/` — root rewrite lands on v6. `http://127.0.0.1:3000/v6` also works.

### Run the integration tests (Supabase-live, cleans up after itself)
Same PowerShell env-load pattern as the purge scripts, then:
```powershell
node scripts/test-instrumentalness-preference.mjs
node scripts/test-super-liked-tracks.mjs
node scripts/test-cron-daily-guards.mjs
```
Each creates + tears down its own throwaway user + business. Safe to run against prod.

### Re-seed Rubin refresh token with wider scope
- See "Spotify Setup → RUBIN_REFRESH_TOKEN scope" above.
- Update `RUBIN_REFRESH_TOKEN` in Vercel cloud env AND `.env.local`. Restart `vercel dev`.

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
Source: `created_playlists` ledger (not `GET /me/playlists`) because current refresh token lacks read scope. Ledger row marked `deleted_at` automatically so the cron doesn't re-process.

### Reset a user for re-testing
Supabase Dashboard → SQL Editor:
```sql
DELETE FROM public.businesses WHERE owner_id = (SELECT id FROM auth.users WHERE email = 'test@you.com');
DELETE FROM auth.users WHERE email = 'test@you.com';
```
Also visit `/v6/?reset=1` to wipe localStorage session.

### Benchmark OpenAI vs Anthropic
```powershell
node scripts/benchmark-directions.mjs --out=benchmark-results/run.json
# Override with env vars: OPENAI_MODEL, ANTHROPIC_MODEL, BIZ_DESC, ATMOSPHERES
```

---

## KNOWN ISSUES / ROUGH EDGES

1. **`GOOGLE_PLACES_API_KEY` may be empty in Vercel** — endpoint silently no-ops. Check with a debug-length endpoint if uncertain. Places confirmation step is optional in v6.
2. **RUBIN_REFRESH_TOKEN lacks `playlist-read-private`** — can't enumerate playlists from Spotify API. Ledger source works for anything created since v5's record-playlist. Legacy pre-ledger playlists are invisible without re-seed.
3. **Spotify iframe autoplay blocked** in preview swipe deck. Custom play button on the artwrap requires user gesture. This is expected browser behavior; not a bug.
4. **Track pool coverage varies by genre** — niche genres (e.g., Klezmer, Medieval music) have small pools. Event playlists floor at 5 tracks; below that the endpoint returns an error asking user to describe differently.
5. **v5 tests + v3/v4 legacy scripts** may reference stale endpoints. Prefer building fresh under `scripts/` for new tools.
6. **Prod deploys are manual** (`vercel --prod`). Easy to forget after code changes.
7. **Vercel dev + moved files race**: if you move a file, update `vercel.json` in the same edit — otherwise `vercel dev` picks up the mismatch and crashes with "pattern doesn't match any Serverless Functions". Recovery: fix vercel.json and restart.
8. **Vercel dev's `VERCEL_URL=localhost:3000` quirk**: server-to-server URLs built as `https://${VERCEL_URL}` resolve to `https://localhost:3000` in dev — every fetch fails with a bare "fetch failed". Both cron files use a `resolveSpotifyBase()` helper that scheme-normalises via a `/^(localhost|127\.)/` regex → http, everything else → https. If you add another server-to-server caller that builds a base URL from `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL`, copy the same helper — do NOT hard-code `https://`.
9. **Vercel serverless kills fire-and-forget promises after `res.end()`**: this bit us on 2026-08-29 when cron cluster alerts never arrived despite the code running. Any Resend / logging / analytics send that started with `.catch(() => {})` and wasn't awaited was cut mid-flight when the function returned. If you're adding async work in a handler, either await it before responding OR collect the promises and `await Promise.allSettled(alertPromises)` at the end. See "Alerts via Resend" mechanism for the pattern.

---

## RECENT WORK — 2026-08-01 SESSION SUMMARY

Highlights from the session that produced this doc's current state:

**v6 architecture built up:**
- Full onboarding flow: splash → login gate → business input → Google Places → atmosphere → hours + Claude directions in parallel → preview swipe → build → CTA gate → signup → account
- Account dashboard: home tab with playlists (auto-expanding to 120 tracks) + events section (edit/delete + event playlist creation)
- Hours picker iterated on in `v6/test-hours/` — one shared master with per-day "שעות שונות" override

**Endpoints created:**
- `api/v6/account/event-playlist.js` — Claude Haiku → genres+BPM → `v5_direction_tracks` → Spotify → 24h ledger + user_metadata
- `api/v6/account/expand-playlist.js` — ndjson streaming for live count updates; targets ~120 tracks per playlist
- `api/v6/account/signup.js` extended to persist hours, longestMinutes, expansion metadata

**Perf optimizations:**
- Supabase `statement_timeout` raised to 15s in the SQL Editor
- 57014 retry in `supabase-client.js` kept as safety net
- Preview pre-fetch pattern: Claude directions + anchor tracks + track metadata all fire in background during hours picker → swipe deck renders instantly
- Atmosphere fetch fires on description page render; server-side cache removed to unblock Ami's live edits
- Client-side promise dedup on atmospheres endpoint

**Infrastructure moves:**
- `api/v5/cron-expire-playlists.js` → `api/cron/expire-playlists.js` (version-agnostic path)
- Cron made 404-tolerant via `isGone` helper — purged playlists don't loop forever
- `scripts/purge-rubin-playlists.mjs` uses ledger source + also marks `created_playlists.deleted_at` after each unfollow

**One-off cleanup:**
- Purged 16 test playlists from Rubin's Spotify library via the ledger source
- Ledger rows marked deleted; cron won't retry them

**UX fixes:**
- Splash timing 4650ms → 2650ms
- Time inputs: custom H:M pairs replacing native `<input type="time">` (native was cutting off digits and had unreliable typing)
- Progress bar hover on flow-progress steps: color change only, no underline
- Preview loading: 25s CSS-animated progress bar instead of spinner
- Closed day rows: cell stays clickable, dim only override/times columns, label grey with line-through (no color-change on hover)
- Custom Spotify play button on swipe cards — visible orange play/pause overlay; iframe hidden inside artwrap with opacity:.01 to keep media pipeline active

---

## RECENT WORK — 2026-08-02 SESSION SUMMARY

**Progressive swipe-deck rendering — the big refactor:**
- `preparePreview` split return shape: was `{previews, trackMeta}` after everything finished, now `{page1Ready, page2Ready}` — two independent promises each resolving to `{previews, trackMeta}`.
- Page 1 metadata fires as soon as page 1 anchors resolve, in parallel with page 2's whole pipeline (Claude → anchors → metadata). Anchor calls stay sequenced (page 2 waits for page 1) via a `sequencedAnchors` closure to keep the plan cache warm; metadata calls run parallel — they hit Spotify, not Supabase.
- `runDirectionPreviewFlow` awaits `page1Ready` and hands `page2Ready` to `renderSwipeDeck`, which appends the second batch to the same deck when it lands. If the user reaches the end of page 1 first, a `preview-load-column` "loading more" state shows inside the deck and resumes via a `waitingResume` closure when page 2 arrives.
- Progress-label spinner: `setProgress` uses `innerHTML` to inline an `sb-spinner` next to the `X/N` count while `page2Settled` is false.
- Fallback `emptyPreparedPreview()` in `app.js` matches the new shape for error paths.

**Scrubbable playback progress bar on each swipe card:**
- CSS `.sw2-progress` block added to `v6/index.html` (below `.sw2-hint`). Outer `.sw2-prog-bar` reserves fixed 14px so hover doesn't push what's below it — the visible `.sw2-prog-track` and `.sw2-prog-thumb` grow/appear via absolute positioning.
- `renderSwipeDeck` builds a per-card `pbState` mirror, wires a RAF loop that interpolates position between the (sparse) `playback_update` events, and handles click + drag to seek via `controller.seek(seconds)`.
- Post-seek `pbState.seekLockUntil = Date.now() + 500` — the `playback_update` handler ignores `position` values during that window. Fixes the visible dot flash-back when Spotify emits one more stale update after `seek()`.
- Iterated on the UX in `v6/test-player/` — same swipe-card structure as production, hardcoded track pool (Blinding Lights, Never Gonna Give You Up, Uptown Funk, Shape of You), swap button to rotate through them.

**Cron worker moved out of the v5 namespace:**
- `api/v5/cron-expire-playlists.js` → `api/cron/expire-playlists.js` (with `../v5/supabase-client.js` import path adjusted).
- `vercel.json` `crons.path` + `functions` key updated.
- `replace_tracks` step now wrapped in try/catch with an `isGone(err)` helper (matches 404/410) so a purged Spotify playlist doesn't loop forever in the retry loop.
- Log labels `[v5 cron]` → `[cron expire]`.
- **Deploy gotcha discovered**: moving a file must be paired with updating `vercel.json` in the same edit — otherwise `vercel dev` picks up the mismatch and crashes with "pattern doesn't match any Serverless Functions inside the api directory."

**Purge script hardened:**
- Enumerates from the `created_playlists` ledger (since `RUBIN_REFRESH_TOKEN` only has `playlist-modify-private` scope, not `playlist-read-private`). Cannot cover pre-ledger playlists — for those you'd need a wider-scoped token.
- After each successful Spotify unfollow, PATCHes the matching ledger row with `deleted_at = now()` so the cron doesn't retry.
- 16 old test playlists purged this session.

**Cache-bust cascade rule** now documented in the `Cache busting` section — bumping `?v=` on an `import` inside a module isn't enough; you must also bump the version of the file that imports it, up the chain until `index.html`. Chain reference is included so future edits can trace it quickly.

**One-off benchmarks:**
- `scripts/benchmark-directions.mjs` compared OpenAI (`gpt-5`, `gpt-5-mini`, `gpt-4o`) vs Anthropic (`claude-sonnet-4-6`) on the musical-directions prompt. Results in `benchmark-results/summary.json`. Takeaway: `gpt-4o` at ~3.3s is the fastest usable option, warm Sonnet at ~11s edges the quality; kept Anthropic for now.
- OpenAI API key is stored in Supabase `app_settings` table where `key='openai_key'` (legacy fallback) — that's how the benchmark script finds it without needing `OPENAI_API_KEY` in `.env.local`.
