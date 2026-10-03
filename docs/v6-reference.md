# Rubin · SonicBrands — v6 reference

v6 is reachable at `/v6` but has no accounts (all deleted 2026-09-24), and its daily cron is hard-disabled. **v7 is the active version — see CLAUDE.md.**

This file holds the v6 documentation that used to live in CLAUDE.md, moved here unchanged on 2026-10-03. It's still useful because v7 forks several v6 files and calls several v6 endpoints (listed in CLAUDE.md § V6). When v6 code changes, update this file the same way CLAUDE.md is updated.

References to sections that aren't in this file (KEY MECHANISMS, DATA MODEL, Special event playlists, Spotify resilience, Rate limiting, Instrumentalness / Popularity preference, …) point to CLAUDE.md.

Contents:
- V6 architecture: onboarding pipeline, account dashboard, direction-edit chat, Profile tab UI, signup
- v6 file structure (the `v6/` subtree)
- v6-only key mechanisms
- Legacy data: the `user_metadata.sonic` blob
- Session summaries, 2026-08-01 and 2026-08-02

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
    (OUTSIDE .sw2-artwrap): title, artist, orange "לא בטוחים? שמעו שיר
    נוסף מהכיוון הזה" pill (with a shuffle icon; same text in v7), reason line, and the scrubbable
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
  - renderPlaylists: reads bmeta().playlists (mirror of business_playlists rows).
    **Sorted most-clicked first** via `sortPlaylistsByClicksDesc` (added 2026-09-03) —
    aggregates `business_playlist_opens` per spotify_id in `loadDashboardData` into
    `state.dashboard.clicksBySpotifyId`, then sorts DESC with a most-recently-created
    tiebreaker (matches the previous default ordering for accounts with zero
    clicks). Same click-based ranking drives the build order of user-triggered
    generate-daily flows (see below).
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
    - **Inline direction rename** (added 2026-09-03): clicking a playlist
      row's `.s-label` (the title text inside `.s-title`) swaps it for an
      input + save-check + cancel-X icon buttons — the owner renames the
      direction without leaving the Home tab. Only enabled when the row
      has a `direction_id` FK AND `!state.generating` (mid-stream re-renders
      would clobber an in-progress rename). Save is fully optimistic: local
      `playlist.label` mutates immediately, `patchDirectionOptimistic(id,
      {title_en:newName})` from `direction-chat.js` mirrors the change onto
      the Profile-tab direction cards for zero cross-tab lag, THEN a
      background POST to `/api/v6/account/apply-direction-change` with
      `kind:'edit'`, `updates:{title_en:newName}`, `expireLivePlaylist:false`
      persists. Server takes the cosmetic-only fast path (rename the live
      Spotify playlist in place + PATCH business_playlists.label + PATCH
      created_playlists.name; audit row records `playlist_action='renamed'`)
      — see the Direction-edit chat section for the fast-path details.
      Failure path: revert both local state and Profile-tab mirror, repaint
      the whole playlist list, error toast. Handler: `enterRenameMode` in
      [v6/account/app.js](v6/account/app.js).
  - renderEvents: reads bmeta().events (mirror of business_events rows).
    Per-row layout is [🎪 name/description] [red trash SVG button (btn-danger)] [action button].
    The pencil edit icon was dropped in the 2026-08-20 chat rewrite —
    workflow is now delete + re-chat. Trash uses a Feather-style outline
    SVG in a red `.btn.btn-danger.event-del` button (no emoji).
    - Trash → opens `#trashEventModal` (added 2026-09-05, replaces the
      earlier native `confirm()` prompt) — mirrors the direction-trash
      modal's shape (styled body + red danger + ghost cancel). Modal
      closes immediately on confirm; the row's trash button spins in
      place during the delete round-trip. Server archives the row into
      `deleted_events` before DELETEing (see Archive tables in DATA MODEL)
      so admin API can still surface a full per-business event history.
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
  - Empty-state fallback for OPEN days (added 2026-09-02): if the
    dashboard renders today with zero playlists (cron errored, hadn't
    fired yet, or every direction's build failed), the "לא נוצרו
    פלייליסטים" body text is followed by an inline "צור פלייליסטים"
    link that opens the SAME `genDailyModal` used by the closed-day
    flow. Skipped when `todayIsClosed()` — the title already offers
    "המקום פתוח?" and a second CTA would be redundant. See
    `renderPlaylists` in [v6/account/app.js](v6/account/app.js).
  - **Streaming build (2026-09-03).** Both entry points (closed-day title
    link + empty-state body link) drive `runGenerateDaily`, which POSTs
    to `/api/v6/account/generate-daily` and reads the response as ndjson.
    Server contract: `{type:'plan', directions:[{direction_id,title}]}`
    first (ordered set — see click-order below), then one
    `{type:'built', direction_id, row}` OR `{type:'failed', direction_id,
    error}` per direction as each finishes (3s inter-playlist stagger
    preserved from the 2026-08-22 Spotify rate-limit lesson), then
    `{type:'done', built, failed}`. Client uses `state.generating.plan`
    + `state.generating.status` (per-direction pending/built/failed) +
    `state.generating.builtRows` (finished client-shape rows) to
    incrementally render placeholders → real rows in the plan's order.
    First playlist appears in ~15s instead of the previous ~90-150s wait
    for the whole batch. Owner can hit "▶ פתח" on it while the rest
    stream in. Closing the tab mid-stream doesn't cancel — each finished
    playlist is INSERTed per-line (vs. the previous single batch INSERT
    at the end), so a Vercel timeout or client disconnect just means
    the already-built rows persist and the next dashboard load shows
    them. Endpoint has 300s maxDuration (bumped from 60s 2026-09-03).
  - **Click-count ordering (2026-09-03).** Server sorts active directions
    by SUM of `business_playlist_opens` rows across every historical
    playlist that shared the direction_id — most-opened first. Ties
    break by rank ASC (R1 ordering), then created_at DESC. Same ranking
    (per spotify_id, not aggregated to direction_id) drives the home
    tab's steady-state row order via `sortPlaylistsByClicksDesc`. A
    popular direction's fresh playlist inherits the direction's
    historical click weight and surfaces high immediately; brand-new
    directions with zero clicks fall to the R1-rank tiebreaker.
```

### Direction-edit chat (profile tab)

Gemini chatbot on `/v6/account`'s Profile tab. The Profile tab's section order is: `שם העסק` → `שעות פעילות` → `כיוונים מוזיקליים` (chat). Both שעות פעילות and כיוונים מוזיקליים render as collapsible dropdowns (see "Profile tab UI" section below). The chat's dropdown header shows the label "כיוונים מוזיקליים" (shortened from "עריכת כיוונים מוזיקליים" on 2026-09-05 when it became a collapsible). Lets the owner refine their `business_directions` after onboarding: add (up to the 8-active cap), remove (soft-disable — the row is preserved with `active=false`), or fine-tune an existing direction (exclude/add genres, adjust BPM, flip inst_pref, rename, reshape description_he).

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
  - `POST /api/v6/account/toggle-super-like` — one row upsert (`active:true` → also clears `deleted_at`) or soft-delete PATCH (`active:false` → sets `deleted_at=now()`) on `super_liked_tracks` for a (business, spotify_id) pair. Called by the preview modal's super-like toggle. Rate-limited 60/min per IP. Soft-delete added 2026-09-05 so future taste-tuning still sees tracks the owner engaged with even if they later un-super-liked them.
  - `POST /api/v6/account/apply-direction-change` — commits the proposal:
    - `add` → INSERT `business_directions` (borrowing a `popularity_window` from any existing direction so the new one is consistent), then build ONE fresh Spotify playlist for today via `buildOneDailyPlaylist` (shared with cron / generate-daily), INSERT `business_playlists`, INSERT `business_direction_changes` (before=null, after=snapshot).
    - `edit` → merge `updates` into the direction spec (mirror of preview-direction's merge), PATCH `business_directions` (only fields that moved). Playlist side is gated by the request's `expireLivePlaylist` flag — default `false` so a caller that forgets the field never nukes today's music:
      - `expireLivePlaylist: true` → expire the direction's currently-live playlist via `expirePlaylistNow` (shared helper), then rebuild via `buildTodayPlaylist`. Audit `playlist_action='rebuilt'`.
      - `expireLivePlaylist: false` → leave today's playlist alone. Tomorrow's daily-gen cron picks up the updated spec (per-day `already-built-today` guard doesn't interfere). Audit `playlist_action='kept'`.
      - The chat client asks the owner in an inline follow-up bubble (mirror of the remove flow) after they confirm the direction change in the preview modal: "החליפו עכשיו" or "השאירו עד סגירה". Only then is the apply endpoint hit — no server work happens between modal confirm and the owner's answer.
    - `remove` → PATCH `active=false` on `business_directions` (row preserved, not deleted — admin API + future queries can still see it). If `expireLivePlaylist=true`, set `expires_at=now()` in PARALLEL on both the `business_playlists` row (drives dashboard visibility — card disappears immediately) AND the `created_playlists` ledger row (drives cleanup-cron eligibility — the next `:30` tick then does the actual Spotify-side rename+empty+unfollow via `expirePlaylistNow`). Changed 2026-09-05: this path used to call `expirePlaylistNow` inline, which made the trash-icon spinner stay on for 5-15s while three sequential Spotify calls completed; now the endpoint returns in ~500ms and the Spotify cleanup runs asynchronously via cron. Trade-off: the playlist stays under its original name in Rubin's library for up to 30 min before the cron sweeps it. Owners never see Rubin's library so this is invisible to them. `playlist_action` records `expired` on success, `kept` when the DB patch itself failed.
  - All three write an audit row to `business_direction_changes` referencing the message range that produced them.
  - Super-likes are NOT passed through the apply endpoint — they're persisted independently via `toggle-super-like`, so the DB reflects the owner's taps regardless of whether they end up confirming the direction change.

- **Shared helpers** extracted for reuse:
  - `api/v6/account/_expire-playlist.js` `expirePlaylistNow({origin, spotifyId, name})` — rename + empty + unfollow + mark `created_playlists.deleted_at`, 404-tolerant. Called by both `api/cron/expire-playlists.js` (TTL sweep) and `apply-direction-change.js` (immediate rebuild on edit / opt-in remove).
  - `api/v6/account/_daily-builder.js buildOneDailyPlaylist` (existing) is called once by the direction-chat apply endpoint to build the new playlist row; a thin wrapper `buildTodayPlaylist` in apply-direction-change reads `business_hours` for today's target + expiry and single-INSERTs the result.

- **Refresh loop**: after any successful commit, the client dispatches a `direction-change-applied` DOM event. `v6/account/app.js` listens for it and reloads `state.dashboard` so the Home tab's playlist list picks up the newly-built playlist and drops the expired one — no page refresh.

- **Rate limits**: `direction-chat` 20/min per IP, `preview-direction` shares the `anchor-tracks` bucket (60/min), `apply-direction-change` 10/min per IP, `toggle-super-like` 60/min per IP.

### Profile tab UI (`v6/account/` Profile tab)

**Section order (as of 2026-09-05):** `שם העסק` → `שעות פעילות` → `כיוונים מוזיקליים` (direction-edit chat). The business-name field is inline at the top; the two below it are collapsible dropdowns using the same aria-expanded/`.hide` pattern.

- **שעות פעילות is a collapsible section.** Header row = h2 title + chevron; clicking the header toggles the subtitle + hours picker via `aria-expanded` on `#hoursToggle` and `.hide` on `#hoursBody`. Chevron points down when closed, rotates 180° to point up when open. State resets to closed on every tab open — `renderProfileTab` in [v6/account/app.js](v6/account/app.js) sets `aria-expanded="false"` and re-adds `.hide` to the body. `mountHoursEditor` still runs on tab open even while collapsed, so dirty-tracking + the save button behave identically to when the section was always visible. The single "שמור" button at the bottom of the tab still handles both business-name and hours edits — there's no separate save inside the collapsible.
- **כיוונים מוזיקליים is also a collapsible section** (added 2026-09-05). Same header + chevron + aria-expanded pattern as שעות פעילות, toggling the direction-edit chat body (cards row + transcript + textarea + send button). State resets to closed on every tab open. Chat behavior itself is described in the "Direction-edit chat" section above — this collapsible is purely presentation. Both dropdowns default to closed so the tab opens on a compact card-shape summary and the owner picks what to touch.

### Special event playlists (v6 account)

v7 had a copy of this until 2026-10-03; it now has its own flow (CLAUDE.md § V7 "Special playlists"). Corrected 2026-10-03 against the code (the old text said Claude Haiku, ~40 tracks, a two-step finalize and `/api/v5/record-playlist`).

- **UI — chat, not textarea.** `v6/account/index.html` `#chatMessages` +
  `#chatInput` + `#chatSend`. Owner describes the event in a chat that
  goes back and forth with Gemini until Gemini offers a summary + inline
  "הכן פלייליסט" button (see `chatState` and `appendConfirmActions` in
  `v6/account/app.js`). System prompt lives in
  `v6/generation/event-chat-prompt.js` (imported by the server endpoint);
  Gemini 3.6-flash, thinking=low. Off-topic messages get a polite redirect.
  The chat gets no date, hours or business name.
- **Chat is persisted** (2026-08-30 migration). Client hits
  `POST /api/v6/account/event-chat`, which loads the session's tail, calls
  the shared Gemini proxy with `label:'event-chat'`, and INSERTs both the
  user turn and the assistant turn into `business_event_chats`. A
  `SESSION_START_AT_ISO` client timestamp (bumped after every finalize)
  filters both the on-screen transcript and the history the server sends
  Gemini. Rate-limited 20/min per IP.
- **No editing** — delete + re-chat.
- **"הכן פלייליסט" only saves the card** (`finalizeAndSaveEvent`):
  `POST /api/v6/account/upsert-event` inserts the `business_events` row
  and backfills `business_event_chats.event_id` for the session.
- **The card's "צרו פלייליסט" builds the playlist**
  (`POST /api/v6/account/event-playlist`): Gemini (v6 `ai-provider.js`,
  thinking=high, label `event-playlist`) reads only the description and
  returns genres (any of the 124, no pairing rules) + a 20–40 BPM range;
  `v5_direction_tracks` draws ~223 random tracks (`closedDayTargetTracks`,
  floor 5; no popularity / instrumental preferences, no history dedup);
  Spotify playlist on Rubin "<business> · <event> · date" (UTC date);
  ledger row written directly with `nextIl4amIso()`; `business_playlists`
  row with `event_id`. The request's description is trusted (not re-read).
- Cards stay forever: "▶ פתח" while the playlist is live, then "צרו
  פלייליסט" again after 04:00. `delete-event` archives the row into
  `deleted_events` and deletes it, but leaves the playlist live until 04:00.

### Auth signup — `api/v6/account/signup.js`

- Uses `SUPABASE_SERVICE_ROLE_KEY` admin API to create user + `businesses` row
- Writes onboarding context (hours, longestMinutes, atmospheres, place, playlists) to `auth.users.raw_user_meta_data.sonic.b[businessId]`
- Persists the free-text prompt inputs (`business_description`, `musical_emphases`) as columns on the `businesses` row itself. Read back by the internal admin API. PATCH path skips blanks so a repeat-onboarding with an empty field doesn't wipe a previously-recorded prompt.
- Backfills `gemini_call_log` rows: `UPDATE gemini_call_log SET business_id = <new>, onboarding_session_id = NULL WHERE onboarding_session_id = <session>`. The client mints a tab-lifetime session id at v6/app.js boot and threads it through every onboarding Gemini call; this UPDATE re-attributes those pre-signup rows to the new business so per-business spend rollups include them. Sessions that never sign up stay unattributed and form the "abandoned onboarding" bucket in the internal admin spend endpoint.
- Returns instant login link (magic-link admin API) so client can jump to `/v6/account` without email round-trip
- **Magic-link redirect** (`accountRedirectUrl`) derives the target from the request host (`x-forwarded-host` || `host`) so signup on localhost / preview / robin-music.com / sonic-brand.vercel.app each redirects back to where the user came from — no per-env config needed. The derived host is validated via `isAllowedHost()` in `api/v6/origin-guard.js` to block `x-forwarded-host: attacker.com` spoofing. Whatever host wins must also be on Supabase's Redirect URLs allowlist (Auth → URL Configuration) — otherwise Supabase silently substitutes its Site URL. `V6_ACCOUNT_REDIRECT_URL` env var overrides derivation entirely if you need a pinned target.

---

## V6 FILE STRUCTURE

```
sonic-brand/
├── v6/                                     ← v6 UI (legacy since v7 took over the root on 2026-09-28)
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
│   │   ├── ai-provider.js                  ← v6's PROVIDER='gemini'|'anthropic' switch. Independent from v7's copy
│   │   │                                      at `v7/generation/ai-provider.js` (identical values today; Ami's
│   │   │                                      dashboard imports from v7's since 2026-09-23).
│   │   ├── musical-directions.js           ← R1 direction generator (uses ai-provider). Both EDITABLE and
│   │   │                                      FIXED prompt sections are composed from named sub-constants
│   │   │                                      (GENRE_UNIVERSE_SECTION, PROCESSING_RULES_SECTION,
│   │   │                                      ENERGY_PAIRING_SECTION, NON_OVERLAP_SECTION,
│   │   │                                      OUTPUT_LANGUAGE_SECTION, TITLE_RULES_SECTION,
│   │   │                                      HEBREW_DESCRIPTION_SECTION, WHEN_NOT_TO_RETURN_DIRECTIONS_SECTION)
│   │   │                                      which are EXPORTED for reuse by refined-directions.js. Composed
│   │   │                                      EDITABLE + FIXED are byte-identical to the pre-refactor
│   │   │                                      single-template-literal version. `injectPlaces()` also exported.
│   │   │                                      Mirrored in v5/ (kept for legacy v5/app.js consumer;
│   │   │                                      Ami's dashboard reads v7's instead since 2026-09-23).
│   │   ├── refined-directions.js           ← R2 direction generator. Client-side module. Composes its own
│   │   │                                      system prompt from R2-specific sub-constants (REFINED_INTRO,
│   │   │                                      REFINED_INPUTS_SECTION, LEARNING_LOGIC_SECTION,
│   │   │                                      REFINED_NON_OVERLAP_SECTION, REFINED_TASK_WORKFLOW,
│   │   │                                      REFINED_OUTPUT_FORMAT, ROUND2_ADDITIONAL_ERROR — new
│   │   │                                      `insufficient_signal` error) plus imported shared sub-constants.
│   │   │                                      Fires via callModel with label='onboarding-refined'. No v5 mirror.
│   │   ├── event-chat-prompt.js            ← System prompt for the special-events chat on /v6/account
│   │   ├── direction-edit-chat-prompt.js   ← System prompt for the profile-tab direction-edit chat
│   │   ├── genre-list.js                   ← Thin re-export of GENRES + GENRE_SET from `shared/genre-universe.js`
│   │   │                                      (as of 2026-09-23). Kept for backward compat — event-playlist
│   │   │                                      Haiku prompt (api/v6/account/event-playlist.js) still imports
│   │   │                                      GENRES from this path.
│   │   ├── popularity-window.js            ← Derives [lo,hi] from selected atmospheres. UNUSED since 2026-09-02
│   │   │                                      (per-direction popularity_preference replaced it); only v5's own
│   │   │                                      copy is still imported (by v5/app.js only — Ami's prompt dashboard
│   │   │                                      dropped it 2026-09-28).
│   │   ├── playlist-length.js              ← dailyPlaylistExpiryIso, computeTargetForToday, directionKey, ilPartsFromDate
│   │   └── playlist-builder.js             ← buildDirectionPlaylists (10 tracks each, concurrency-capped)
│   └── account/
│       ├── index.html                      ← Dashboard shell (Home tab; profile+hours+event chat+direction-edit chat inline)
│       ├── app.js                          ← Supabase Auth boot, renderPlaylists, renderEvents, event chat,
│       │                                     expand streaming, mounts direction-chat on Profile tab
│       └── direction-chat.js               ← Direction-edit chat UI + single-card preview modal
│                                             (lazy-loaded when Profile tab first opens)
```

Historically-referenced sandboxes that no longer exist: `v6/test-hours/`,
`v6/test-player/`, `v6/test-superlike/`. All three were deleted 2026-08-21
during the pre-pilot cleanup pass. If you need to iterate on the swipe or
hours UI in isolation, spin a fresh sandbox under a `v6/test-*/` slug and
wire it in `vercel.json`.

---

## KEY MECHANISMS (V6-only)

### The state machine — `v6/app.js goToStep(n)`

- One `state` object holds `bizName`, `bizDesc`, `onboardingSessionId` (tab-lifetime UUID used to attribute pre-signup Gemini spend), `confirmedPlace`, `atmosphereRows`, `selectedAtmos`, `musicalEmphases` (step 3), `round2Emphases` (R2-only, cleared when `directions` is invalidated), `superLikedTracks` (Set), `superLikedGenres` (Map), `hours`, `longestMinutes`, `directions`, `page2Promise`, `picked`, `results`. **`popularityWindow` was removed 2026-09-02** when per-direction `popularity_preference` replaced the atmosphere-derived window.
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

- **Model selection lives in one place per version**: `v6/generation/ai-provider.js`
  exports `PROVIDER` (`'gemini' | 'anthropic'`), `MODEL_GEMINI`, and
  `MODEL_ANTHROPIC`. v6 onboarding calls through this file's `callModel()`.
  (Since 2026-09-23 Ami's prompt dashboard imports from `v7/generation/ai-provider.js`
  instead — v7's copy is a decoupled sibling with the same values today.)
  Currently `PROVIDER='gemini'`, model `gemini-3.6-flash`, thinking=`high`.
  Anthropic path is retained and byte-for-byte tested (see the prompt-history
  audit rule), just not
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
  refactor single-template-literal version (verified by test script).
  (Ami's dashboard imported `EDITABLE_PROMPT_SECTION` from here pre-
  2026-09-23; since then it imports from v7 instead.) `injectPlaces()`
  is also exported so R2 reuses the same Google-Places-block injection
  logic.
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
   on 2026-08-29 as part of the resilience layer). Outer loop sleeps 5s
   between businesses — but ONLY after a business that actually consumed
   Spotify budget (built/failed/threw). Businesses that skipped without
   touching Spotify (`not-onboarding-done` / `no-hours` / `closed-today`
   / `past-close` / `already-built-today` / `too-early` / `no-directions`
   / `bad-hours`) don't trigger the inter-business sleep. This
   optimisation (added 2026-09-04) drops idle-tick duration from ~85s to
   a few seconds and prevents the 300s-cron-timeout mode that first
   surfaced with 17 businesses on Sep 4. Combined pacing keeps sustained
   write rate < 30/min per cron tick. Single batch INSERT into
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

---

## LEGACY DATA

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
