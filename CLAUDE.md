# Rubin · SonicBrands — AI Context Document

> Optimized for Claude and other AI coding assistants.
> Read this entire file before touching any code.

## ⚠️ READ FIRST — VERSION LANDSCAPE

The codebase contains multiple parallel "versions" that coexist. **v6 is the current active version.** Others are kept but see the notes:

| Version | State | Where |
|---|---|---|
| **v6** | **Still served at root, but NO v6 accounts exist** (all deleted 2026-09-24) and its daily cron is hard-disabled. New signups at `/` still create v6 accounts, which get no daily playlists. Michael's v4 UI shell + our v5 pipeline (Claude musical directions). This is what the user is iterating on. | `v6/`, `api/v6/` |
| v7 | **Runtime built + live-verified (2026-09-23).** Full parallel onboarding→signup→account→daily-cron runtime under `/v7`, separate from v6 (still live at root). Reframes onboarding directions as diagnostic taste PROBES that dissolve into a flat 116-genre bucketed taste profile at signup. Signup fires AFTER a (placeholder) payment step, and the owner enters the account only via the emailed magic link (email verification required, like v6). Daily playlists via two delivery modes (Option 1 / Option 2). v7's daily cron is now the ONLY scheduled daily builder — v6's is shut off. Ami still tunes the R1 prompt via the Ami dashboard. See § V7 ARCHITECTURE and § OPEN QUESTIONS FOR V7 PIPELINE BUILD. | `v7/`, `api/v7/`, `api/cron/v7-generate-daily.js`, `shared/`, `prompt-history-v7.md` |
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

### Special event playlists

- **UI — chat, not textarea.** `v6/account/index.html` `#chatMessages` +
  `#chatInput` + `#chatSend`. Owner describes the event in a chat that
  goes back and forth with Gemini until Gemini offers a summary + inline
  "צור פלייליסט" button (see `chatState` and `appendConfirmActions` in
  `v6/account/app.js`). System prompt lives in
  `v6/generation/event-chat-prompt.js`; Gemini 3.6-flash, thinking=low,
  responseMimeType=JSON. Off-topic messages get a polite redirect.
- **Chat is now persisted** (2026-08-30 migration). Client hits
  `POST /api/v6/account/event-chat` (a wrapper mirroring direction-chat's
  design) which loads context, calls the shared Gemini proxy with
  `label:'event-chat'`, and INSERTs both the user turn and the assistant
  turn into `business_event_chats`. Client-side, the visible transcript
  still clears on hard refresh and on a successful finalize — a
  `SESSION_START_AT_ISO` client-generated timestamp (bumped after every
  finalize) filters BOTH the on-screen transcript AND the tail messages
  the server includes in Gemini's context, so display + model memory stay
  in sync. Persistence is orthogonal — every turn is durably logged for
  admin visibility regardless of what the client shows. Rate-limited
  20/min per IP.
- **Editing existing events was dropped** with the chat rewrite (no
  pencil button on cards). Delete + re-chat is the workflow. Restore
  by adding an "edit this event" chat flow if needed.
- **Finalize is a two-step client chain** in `finalizeAndGenerate`:
  1. `POST /api/v6/account/upsert-event` inserts the `business_events`
     row using Gemini's `proposed.name_he` + `proposed.description_he`.
     Also backfills `business_event_chats.event_id` on every chat row
     from this session (WHERE `created_at >= sessionStartAt` AND
     `event_id IS NULL`) so the admin API can surface "here's the
     conversation that produced this event".
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

## V7 ARCHITECTURE (runtime built + live-verified 2026-09-23)

v7 is a full parallel runtime under `/v7` (onboarding UI, account UI, API endpoints, signup, taste-profile bucketing, two daily-playlist delivery modes, and its own daily cron). It was built and live-end-to-end-verified on 2026-09-23 against `vercel dev` → prod Supabase. **v6 stays live at root and is untouched**; v7 is reached at `/v7`. The version split is enforced by `businesses.version` ('v6' default, 'v7' stamped at v7 signup): v6's daily cron is now shut off and v7's targets only `version='v7'` businesses (see § VERCEL DEPLOYMENT and the v7 cron mechanism). Ami still tunes the R1 prompt via the Ami dashboard (imports v7's prompt + ai-provider since 2026-09-23). A short list of intentionally-deferred decisions remains — see § OPEN QUESTIONS FOR V7 PIPELINE BUILD.

### Design shift from v6

- **v6 directions were curated blends.** Each picked direction became the seed for a real playlist post-signup. Multi-Cultural Fusion and Cross-Regional blends were actively encouraged within a direction. Rules like Jazz Isolation and House Containment framed pairings as "can blend with X" — an appropriate framing for the diverse-playlist world.
- **v7 directions are diagnostic PROBES.** Each is a small cluster of near-identical genres (same energy tier / instrumentation family / cultural register / mood — 4 axes; no tempo axis after 2026-09-23). Liking or disliking one representative track flags the whole cluster as one taste vector. Downstream, the picked directions DISSOLVE into a flat liked-genres list — playlists are built off that list, NOT per-direction. Overlapping genres across two liked directions become a stronger genre-level signal, not a duplicate.
- **Rules rewritten for the shift.** `BEAT_PERCUSSION_RULE` was rewritten as a "Groove-Family Disambiguation" that explicitly splits RnB / Funk / Neo Soul / Hip Hop / Trap-Drill into five disjoint tight-cluster families (v6's version listed those first four in a single example set, which the model read as a single-cluster license — barbershop-bug root cause). `JAZZ_ISOLATION_RULE` was simplified to remove the explicit "Ethio-Jazz and Acid Jazz can blend with Afro/Funk/R&B styles" clause. `MULTI_CULTURAL_RULE` (v6 §3) and `EQUAL_GENRE_WEIGHT_RULE` (v6 §4) were dropped entirely. New sections `HOMOGENEITY_SECTION` and `DISTINCTNESS_SECTION` codify the tight-cluster / 8-distinct-archetypes design.

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
         → full 116-genre bucketing + per-user energy scale + carry-through prefs
         label='v7-taste-profile'
       ↓
[registration → placeholder payment → taste-profile bar
  → signup (api/v7/account/signup.js: account + taste profile saved + magic link emailed)
  → "בדקו את המייל ✉️"]
       ↓
[owner clicks the emailed magic link (= email verification) → /v7/account → first-login delivery-mode gate]
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
  "instrumentalness_preference": "none",
  "popularity_preference": "none",
  "reasoning_en": "..."
}
```

Bucketing rules (in the prompt):
- **approved** — appears in liked direction OR super-liked genre OR all-4-axes tight-cluster neighbour of one OR explicitly requested in emphases.
- **conditional** — 2–3 axis neighbour of a liked genre; OR mixed signals; OR untouched but plausibly adjacent. **DATA ONLY in v7's initial cut** — first playlist builder ignores this bucket. Kept because the signal is real and the model is already reasoning over the full catalog.
- **excluded** — appears only in disliked directions with no positive counterweight; OR explicitly banned in emphases; OR Japanese Folk restriction triggers. The model expresses this by LEAVING THE GENRE OUT of both lists (since 2026-09-24 — saves ~500 output tokens per onboarding vs. having it re-list ~70 genres).

Energy calibration:
- `energy_levels_total` is DYNAMIC per user (2..6). Narrow spread of taste → N=2. Very wide spread (chamber music AND dubstep both in the profile) → N=6. Prefer the smallest N that meaningfully distinguishes operational contexts.
- Each approved/conditional genre gets an `energy_level` 1..N. **RELATIVE to the user's own range**, not absolute. Hip Hop is level N for a mostly-chill user; level 3 for a rave user who also picked Dubstep. Same-energy genres get the same level.
- Excluded genres get no level.

Hard schema invariant: every one of the 124 canonical genres must land in EXACTLY ONE bucket. `normalizeTasteProfile` in `v7/generation/taste-profile.js` guarantees this by construction — `excluded_genres` = every canonical genre not in approved or conditional (any `excluded_genres` the model sends anyway is ignored); approved wins over conditional on duplicates; case drift is canonicalised via a lowercase→canonical map; invented genres (e.g. "Slow Funk") are dropped; energy levels clamped to `[1..N]`.

**No Places injection at this stage.** Google Places is venue context; the taste profile is a property of the USER, not the venue. Places was already baked into R1/R2 when the model built the probes the user swiped on. Reusing Places here would mix venue-appropriateness signal into a user-taste extrapolation.

### Prompt stack

All three v7 prompts route through **`v7/generation/ai-provider.js`** — same shape as v6's (`PROVIDER='gemini' | 'anthropic'`, model `gemini-3.6-flash`, thinking `high`) but INDEPENDENT. Flipping v6's PROVIDER doesn't touch v7. Ami's dashboard (which imports from v7's ai-provider since 2026-09-23) follows v7's switch.

`gemini_call_log.label` values in use:
- v6: `onboarding` (R1), `onboarding-refined` (R2), plus post-signup labels for event chat / direction-edit chat / preview-direction.
- v7: `v7-onboarding` (R1), `v7-onboarding-refined` (R2), `v7-taste-profile`, `v7-energy-directions` (Option-1 energy-tier generation at the delivery-mode gate).

Admin API `/api/internal/gemini-spend`'s `by_label[]` breaks these out separately, so v7 spend is trackable from day one of runtime.

### v7 does NOT emit `bpm_range`

Removed 2026-09-23. v7's homogeneity axes (energy / instrumentation / register / mood) don't include tempo. The `validateBpmRange` function was deleted from both v7 files; `validateDirection` no longer checks BPM. Downstream:
- **Swipe deck → its own RPC, no tempo at all.** v7's preview (R1, R2 and the swap button) calls `/api/v7/anchor-tracks` → **`v7_anchor_tracks(p_specs)`** (migration `v5/precompute/migrations/2026-09-24-v7-anchor-tracks.sql`, **RUN 2026-09-24**). Specs are `{rank, genre, inst_pref, pop_pref}`. Per spec it samples 8 random playlists tagged with the genre, takes their tracks, applies the inst/pop filters and biases, and picks one at random; a second tier re-samples 200 playlists only for specs the first tier couldn't satisfy. Work is bounded by the sample, so it's fast regardless of genre, and it runs on the normal **anon** key like v6's endpoint. v6's `v5_anchor_tracks` + `/api/v5/anchor-tracks` are untouched and still v6-only.
- **Daily builders still pass `0–300`.** `api/v7/account/_daily-builder.js` reuses v6's `v6_direction_tracks_recent`, which REQUIRES `bpm_lo`/`bpm_hi` (NULLs would make `tempo BETWEEN NULL AND NULL` drop every row), so v7 directions carry `bpm_range:{min:0,max:300}` as a no-op tempo filter. That runs server-side on the service key, so it isn't subject to the anon 3s limit.

**Why the swipe deck needed its own function (measured 2026-09-23).** `v5_anchor_tracks` picks its one track with `ORDER BY random() LIMIT 1` over *every* track matching genre + tempo + popularity. `track_analyses` has a tempo index, so its cost tracks the tempo window, not the genre: a `0–300` spec cost ~2× a v6-style narrow window even for small genres. A 4-card v7 call (~4.6s wall-clock) blew the anon role's 3s `statement_timeout` on 6/6 calls → 57014 → empty deck → forced into R2, which failed the same way. A service-key workaround briefly shipped on 2026-09-23 and was replaced by `v7_anchor_tracks` on 2026-09-24.

### v7 persists a taste profile, NOT `business_directions`

v7 does NOT write `business_directions` (v6's per-direction table). Instead, signup persists the flat taste profile to **`business_taste_profiles`**, the chosen delivery mode to **`business_v7_settings`**, and (Option 1 only) energy-tiered directions to **`business_v7_directions`** — three new tables (see DATA MODEL). Consequences: v6's daily-gen cron, direction-edit chat, and admin API all read `business_directions` and see nothing for v7 businesses — which is correct (v6's cron is shut off; v7 has its own cron; the account-tab direction-chat ships dormant for v7). The admin API's v7 view is a future item.

### v7 daily runtime (Option 1 / Option 2) — BUILT

After signup, `/v7/account` shows a first-login **delivery-mode gate**, labelled "סוג פלייליסטים יומיים" in the UI (`set-delivery-mode.js` writes `business_v7_settings.delivery_mode` + `updated_at`). **As soon as the owner picks a type in the gate, the dashboard builds TODAY's set** (`checkV7ModeGate` returns true → `runGenerateDaily` → `api/v7/account/generate-daily.js`; expires 2h after today's close, or next 04:00 IL on a closed day / after closing). From tomorrow the v7 cron builds. Two duplicate guards: the cron skips a business as `mode-just-set` (silent) for 15 min after `updated_at`, so it can't race the in-flight first build; and the endpoint returns 409 if a live daily set already exists for the current business day (IL, overnight-aware) or another build for the business is running. If the first build fails entirely, the next cron tick builds.
- **Option 1 — 4 playlists/day.** On selecting option1, energy-tiered directions are generated (`v7/generation/energy-directions.js`, `label='v7-energy-directions'`) and stored in `business_v7_directions` (2+ high-energy, 2+ low-energy tiers). Each day the builder fills 4 fixed names — 2 per tier — with a **random** pick of 2 directions from that tier's active pool (`pickTwo` in `api/v7/account/_daily-builder.js`; 2 distinct directions when the pool has ≥ 2, the same direction twice when it has 1 — the second playlist still gets different tracks via same-day history). So every name gets a random direction of the right energy each day; with exactly 2 directions per tier only the #1/#2 assignment varies, and variety comes from the tracks (random draw + 7-day dedup). **Owner-facing names are fixed** (since 2026-09-24): "אנרגיה גבוהה #1/#2" and "אנרגיה רגועה #1/#2", derived at build time from `energy_tier` + position within the tier (`tierPlaylistName` in `api/v7/account/_daily-builder.js`) — used for the dashboard label (`business_playlists.label`) and the Spotify playlist title/description. Gemini's `business_v7_directions.title_en` (e.g. "Smooth Jazz Lounge") is kept as an internal descriptor only and never shown to owners. Tiers are RELATIVE to the owner's own energy scale (high = upper half of their `energy_levels_total`), so a calm-jazz owner's "אנרגיה גבוהה" can be smooth jazz. **Length** (since 2026-09-24): each of the 4 playlists is sized to half of today's opening minutes + 90 min, at the assumed 3.5 min/track (`buildOption1Batch`; e.g. 09:00–21:00 → (360+90)/3.5 = 129 tracks). Count-based, so real playing time runs ~19% long — measured catalog average is 4.16 min/track (3k-row sample of `track_analyses.raw_analysis->>'duration'`, 2026-09-24). Becomes exact once builders fill by duration.
- **Option 2 — 2 mixes/day whose energy follows the owner's timeline (BUILT 2026-09-24).** Named **"Daily Mix #1"** and **"Daily Mix #2"**. See "Option 2: energy timeline" below.

#### Option 2: energy timeline

The owner draws the day's energy as a curve through draggable dots (the editor approved in the `/v7/test-timeline` sandbox). Decisions (Roni, 2026-09-24):
- **One timeline per hours group** — days with identical opening hours share one; the editor shows a tab per group ("א׳–ה׳ · 09:00–17:00"). Closed days have none. **Opening on the LEFT.** Dots: 5 to start, 2–12, move freely (energy continuous, time snaps to the clock's :00/:30 + exact opening/closing, two dots never share a time); "+" adds one; drag onto the trash (visible only while a dot is held) deletes. Grid rows = the taste profile's `energy_levels_total` (never shown to the owner).
- **Where:** one modal (`#timelineModal`, `openTimelineModal` in `v7/account/app.js`) — first-login gate (choosing Option 2 opens it; "חזרה" returns to the gate; saving = choosing Option 2), Profile tab "עריכת ציר האנרגיה" (button carries a mini preview of today's curve), and Profile Option 1 → 2 (**mandatory** — the type only switches on save; cancel keeps Option 1).
- **Opening hours edited → the timeline updates in the same request, keeping clock times** (`api/v7/account/update-hours.js`, v7's own copy of v6's endpoint): dots stay at their hours, a dot on the old opening/closing moves to the new one, out-of-hours dots are dropped (≥ 2 kept), a day that gets its own hours copies its old group's curve, merged groups prefer the one whose hours didn't change. No replace question on an hours change.
- **Replace question:** after a timeline save or a type switch (1→2 or 2→1 — on 2→1 it's asked right after the switch is saved, BEFORE the ~1-minute energy-directions build; a "now" answer rebuilds once the directions exist) in the Profile tab, if today has live daily playlists and the venue hasn't closed yet (right up to closing time), step 2 of the modal asks v6's "להחליף את הפלייליסטים של היום עכשיו, או להשאיר את הקיימים עד סגירה?". **"החליפו עכשיו"** → Home tab + `runGenerateDaily({replaceToday:true})`: the new set **starts at the current time** and runs to closing + 30; each old playlist leaves the dashboard as its replacement lands (`business_playlists.expires_at = now` only — the ledger keeps the original close + 2h so a phone still playing it isn't cut off at the next :30 sweep). **Cap: 2 replacements per business day**, visible in the question ("נותרה החלפה אחת להיום"; at the cap the button is disabled with "הגעתם למקסימום של 2 החלפות ביום — השינוי ייכנס לתוקף מחר"). Counted as `business_settings_changes` rows `field='daily_playlists_replaced'` (written only once something actually built). One build at a time per business (Upstash lock, `_build-lock.js` → 409 `build-in-progress`).
- **Builder** (`api/v7/account/_option2-builder.js`): window = `businessWindowAt` (IL + overnight-aware) → **start = max(now, opening)** (any build after opening — first login mid-day, late cron, "צור פלייליסטים", replace — starts at the build time), **end = closing + 30 min** (energy after closing = closing value). Closed day / after closing on demand ("המקום פתוח?"): the main group's curve (most days) stretched over now → now + 12h, expiring next 04:00. Level at any moment = the grid row the curve is in (`min(N, 1+floor(e·N))`); a level with no approved genres falls back to the nearest one. Pool: `v7_timeline_pool` RPC (random playlists per genre → tracks with `duration_sec`, 7-day no-repeat across the whole business, wider sample for short genres, recently-served refill for short levels). Assembly (`v7/generation/timeline-assembler.js`, pure, seeded): tracks end to end **by duration**, **short genre runs** (3–5 songs, then another genre at the same level), two mixes never share a track. Rows carry `expansion.v7_timeline` (window, dots, per-track start minute / level / run genre, seed) + the usual `track_genres`. History key `'v7-option2'`. Falls back to the naive `planOption2` if the RPC isn't deployed.
- **Storage:** `business_v7_settings.timeline` = `{ version: 2, groups: [{ days, open, close, points: [{ m, e }] }] }` — `m` = clock minutes from midnight of the opening day (overnight > 1440), `e` 0..1. Always normalised against the current hours (`reconcileTimeline`). Timeline saves don't touch `updated_at` (the cron's `mode-just-set` skip means "mode changed").
- **Model** (`v7/generation/energy-timeline.js`, browser + server): hours groups, slots, curve (Fritsch–Carlson monotone cubic, verbatim from the sandbox), levels, reconciliation, `businessWindowAt`. Offline tests: `node --test scripts/test-energy-timeline.mjs`. Read-only plan preview: `node scripts/_v7-option2-dryrun.mjs [businessId] [--at=HH:MM]`. Live E2E (real Spotify, Roni runs): `scripts/_v7-option2-walkthrough.mjs`.
- **Loading placeholders:** the dashboard draws today's cards with their final names the moment a build starts (`expectedDailySlots` in `v7/account/app.js` — names are fixed per type); the server's `plan` line then takes over.
- **TEMPORARY testing log (Ami, 2026-09-24):** `DEBUG_TASTE_LOG` in `v7/account/app.js` prints the account's taste profile (genres by energy level), Option-1 directions / Option-2 timeline, and today's playlists (Option 2: level/genre runs) to the browser console on every dashboard load. Turn off / delete when testing ends.
- **Needs migration `v5/precompute/migrations/2026-09-24-v7-timeline-pool.sql`** (track_analyses.duration_sec + trigger + backfill, and the pool RPC).

Option 1 is planned by **`api/v7/account/_daily-builder.js`** `planOption1` (Option 2 by `_option2-builder.js`, above; `planOption2` there is only the naive fallback) — directions, per-playlist target, expiry — and built either by `buildOption1Batch` (the cron: plan + `buildBatch`, a v7 copy of v6's `buildDailyBatch` that also writes the per-track genre record — v6's function is untouched) or by the owner-triggered **`api/v7/account/generate-daily.js`** (the dashboard's "צור פלייליסטים" / "המקום פתוח?" links: same plan with `onDemand:true`, then v6 `buildOneDailyPlaylist` per playlist, streaming v6's ndjson contract with `slot-N` keys). `onDemand` sizes a closed/unknown day as `CLOSED_DAY_MINUTES` and never hands out an already-passed expiry (falls back to next 04:00 IL); the cron path is unchanged. Everything reuses v6's `_daily-builder.js` primitives (`buildDailyBatch`, `fetchTracksWithHistory`, ledger + history + insert). v7 directions carry `bpm_range:{min:0,max:300}` and **`id:null`** — `business_playlists.direction_id` is an FK to v6's `business_directions`, so passing a `business_v7_directions` id would violate it. The daily cron is **`api/cron/v7-generate-daily.js`** (see § VERCEL DEPLOYMENT). Spotify resilience + alerts are inherited unchanged: v7's build path flows through the version-agnostic `api/new/spotify.js` proxy.

### v7 onboarding + signup runtime — BUILT

- **Client** (`v7/`): `index.html` + `app.js` (state machine) + `atmosphere.js` / `atmosphere-bubbles.js` / `emphases.js` / `hours-selector.js` / `preview.js` (R1 + R2 swipe decks) / `result.js` (registration + payment + taste-profile bar — its fill runs 35s via `.taste-profile-fill`; the swipe-deck loaders keep 25s). Funnel: desc → places → atmospheres → emphases → hours → R1 swipe → (R2 if <3 picks) → registration → **placeholder** payment → taste-profile bar → `/v7/account`.
- **Account** (`v7/account/`): `index.html` + `app.js` (delivery-mode gate, energy-directions build) + `direction-chat.js` (dormant for v7 — reads empty `business_directions`). The Home tab's special-events chat ("צריכים משהו אחר היום?") is a collapsible dropdown, closed by default (same `.hours-toggle` pattern as the Profile sections, since 2026-09-24); the saved events list ("פלייליסטים אחרים") stays visible.
- **No inline playlist rename in v7 (kept this way for now; may change).** v6's Home-tab inline rename (click a playlist title → edit) and the per-playlist edit / trash icons are NOT available in v7. This wasn't a deliberate product decision — it fell out of the build: the code was copied from v6 and is still in `v7/account/app.js` (`enterRenameMode`, `editDirectionFromCard`, `openTrashDirectionModal`), but every one of those controls only renders when the row has a `direction_id` (`canRename = !!p.directionId …`, `if (p.directionId)`), and v7 rows always insert `direction_id: null` (FK to v6's `business_directions`). Roni has chosen to keep it off for now. Reviving it would need a v7 path that edits `business_v7_directions` instead of calling v6's `apply-direction-change` — and a decision on how a rename interacts with the fixed "אנרגיה גבוהה/רגועה #N" names.
- **Payment is a placeholder** — all fields optional; no real integration yet; submitting just advances.
- **Email verification is REQUIRED (like v6; decided 2026-09-24).** Nothing in the v7 funnel logs the owner in. After payment, the bar awaits the taste profile, THEN `api/v7/account/signup.js` runs ("no non-paying clients" — no account before payment): it creates/updates the user + a `businesses` row (`version='v7'`, `paid_at=now()`), **saves the taste profile** (`business_taste_profiles`, via the shared `_taste-profile.js` row builder) BEFORE emailing, backfills `gemini_call_log` once (all onboarding calls incl. the taste profile have resolved by then), and finally emails the one-time magic link (`/auth/v1/otp`, fatal if it fails). The client shows "בדקו את המייל ✉️" with a "לא הגיע? שלחו שוב" resend that re-posts the same (idempotent) payload. The resend waits out a 60-second countdown ("אפשר לשלוח שוב בעוד 0:59") that starts when the screen appears and restarts after every resend or 429 — Supabase sends at most one login email per user per ~60s. Clicking the link verifies the email and lands on `/v7/account`. Returning owners are looked up via the admin user list's `?filter=` — NOT admin `generate_link`, which counts as a login-link send and tripped Supabase's ~60s per-user email interval (the reason v7's email never arrived before 2026-09-24; v6's signup still uses `generate_link` for returning users). A too-soon resend gets a friendly 429. Test scripts skip the email with `skipEmail:true` + a valid `x-sonic-internal` header (their addresses are `@example.invalid`) and mint their own session via admin `generate_link` + `verify`. Caveat for the real payment integration: an owner who pays and then closes the tab before the bar finishes gets no account — the payment callback will need to create it.
- **Direction ranks are globally unique across rounds:** R1 = 1–8 (page 1 = 1–4, page 2 = 5–8), R2 = **9–12** (`R2_RANK_START` in `v7/generation/refined-directions.js`). The R2 and taste-profile prompts reference LIKED/DISLIKED by rank, so `v7/app.js round1DirectionsSeen()` passes page 1 **plus** every page-2 direction that was liked/disliked (`state.directions` alone is page 1 only). `state.round2Directions` holds the R2 set so the taste-profile retry can rebuild the same call.
- **Endpoints**: `api/v7/anchor-tracks.js` (swipe-deck anchors → `v7_anchor_tracks` RPC, anon key — see the bpm_range note above) + `api/v7/account/`: `signup.js`, `save-taste-profile.js`, `set-delivery-mode.js`, `save-energy-directions.js`, `generate-daily.js`, `_daily-builder.js`.
- **Live verification scripts** (self-cleaning, throwaway user/business, safe against prod): `scripts/_v7-walkthrough.mjs` (Phase A onboarding→signup→account) and `scripts/_v7-phaseb-walkthrough.mjs` (Phase B daily builders + v7 cron + expiry). `/v7/?reset=1` (and the account app) clears the Supabase session for re-testing, same as v6.

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
│   │   │                                      copy is still imported (v5/app.js + Ami's prompt dashboard).
│   │   ├── playlist-length.js              ← dailyPlaylistExpiryIso, computeTargetForToday, directionKey, ilPartsFromDate
│   │   └── playlist-builder.js             ← buildDirectionPlaylists (10 tracks each, concurrency-capped)
│   └── account/
│       ├── index.html                      ← Dashboard shell (Home tab; profile+hours+event chat+direction-edit chat inline)
│       ├── app.js                          ← Supabase Auth boot, renderPlaylists, renderEvents, event chat,
│       │                                     expand streaming, mounts direction-chat on Profile tab
│       └── direction-chat.js               ← Direction-edit chat UI + single-card preview modal
│                                             (lazy-loaded when Profile tab first opens)
├── v7/                                     ← BUILT + LIVE-VERIFIED. Parallel runtime (v6 untouched at root).
│   ├── index.html                          ← Onboarding shell + v7 CSS
│   ├── app.js                              ← Onboarding orchestrator: desc→places→atmospheres→emphases→hours
│   │                                          →R1 swipe→(R2 if <3)→registration→payment→taste-profile bar→account.
│   ├── atmosphere.js / atmosphere-bubbles.js / emphases.js / hours-selector.js  ← ports of the v6 steps
│   ├── preview.js                          ← R1 + R2 swipe decks. Anchors via /api/v7/anchor-tracks → v7_anchor_tracks
│   │                                          (no BPM) — NOT v6's /api/v5/anchor-tracks.
│   ├── result.js                           ← registration + placeholder payment + taste-profile bar → signup →
│   │                                          "בדקו את המייל ✉️" (resend re-posts signup)
│   ├── test-timeline/index.html            ← SANDBOX (not linked from the app; /v7/test-timeline, served — ES-module
│   │                                          imports don't load from file://). Runs the SAME editor + model as the
│   │                                          account (imports both), so it can't drift. Dev panel: sample hours
│   │                                          (switching runs the real keep-clock-times reconciliation), N, time
│   │                                          direction, 15-min "translation to playlist" strip, stored JSON.
│   ├── account/
│   │   ├── index.html                      ← incl. #timelineModal (Option-2 editor + "replace today?" step)
│   │   ├── app.js                          ← type gate (option1/option2; option2 → timeline modal); Profile type
│   │   │                                      cards + "עריכת ציר האנרגיה"; replace-today flow; Option-1
│   │   │                                      energy-directions build; business-day "today" helpers
│   │   ├── energy-timeline-editor.js       ← The approved Option-2 timeline editor (TimelineEditor), extracted from
│   │   │                                      the sandbox; injects its own .etl-* styles. Client-only.
│   │   └── direction-chat.js               ← DORMANT for v7 (reads empty business_directions; kept for parity)
│   └── generation/
│       ├── energy-timeline.js              ← Option-2 timeline MODEL (browser + server): hours groups, :00/:30 slots,
│       │                                      monotone curve, levels, reconcileTimeline (keep clock times),
│       │                                      businessWindowAt (IL + overnight). Bare imports.
│       ├── timeline-assembler.js           ← Option-2 duration-based assembler (pure, seeded RNG): demand → pool
│       │                                      sizes, 3–5-song genre runs, two disjoint mixes. Bare imports.
│       ├── musical-directions.js           ← R1 diagnostic taste probes (8, 4+4 split). label='v7-onboarding'.
│       ├── refined-directions.js           ← R2 refinement (4 probes, fires when R1 picks < 3).
│       │                                      label='v7-onboarding-refined'. Imports R1 sub-constants.
│       ├── taste-profile.js                ← Full 116-genre bucketing + dynamic 2-6 energy levels.
│       │                                      Runs once after R1/R2 resolve, before signup. Output:
│       │                                      approved/conditional/excluded + energy_levels_total +
│       │                                      per-genre energy_level + inst_pref/pop_pref carry-through.
│       │                                      label='v7-taste-profile'. NO Places injection (venue
│       │                                      context is a property of the venue, not the user's taste).
│       ├── energy-directions.js            ← Option-1 energy-tiered directions from approved_genres.
│       │                                      label='v7-energy-directions'. ≥2 high + ≥2 low tiers.
│       ├── playlist-length.js              ← port of the v6 helper (server-reachable: bare imports). v7 has no
│       │                                      popularity-window.js (unused copy deleted 2026-09-24).
│       ├── event-chat-prompt.js            ← port (account-tab event chat; parity with v6)
│       └── ai-provider.js                  ← Independent copy of v6's provider switch. Currently identical
│                                              (Gemini 3.6-flash, thinking=high) but flipping v6's PROVIDER
│                                              does NOT touch v7. Both prompts + Ami's dashboard route here.
│                                              SERVER-REACHABLE — bare imports only, no ?v= query.
├── shared/                                 ← Cross-version source of truth.
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
│   └── generation/musical-directions.js    ← Still consumed by legacy v5/app.js standalone UI. No longer
│                                              read by Ami's dashboard. Header comments + `MODEL='claude…'`
│                                              constant are dead code from the pre-ai-provider era.
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
│   │       ├── _require-business-owner.js  ← requireBusinessOwner(businessId, userId) — SELECT businesses row and
│   │       │                                  verify owner_id matches the JWT-authenticated caller. Used by
│   │       │                                  expand-playlist, event-playlist, generate-daily to close an
│   │       │                                  authorization hole where any valid JWT could otherwise write to
│   │       │                                  any business's data via service-role writes.
│   │       ├── _expire-playlist.js         ← Shared expirePlaylistNow() — rename + empty + unfollow + mark deleted.
│   │       │                                  Used by both the hourly cron and direction-chat's apply endpoint.
│   │       ├── signup.js                   ← Supabase admin user + business + business_directions + super_liked_tracks; backfills gemini_call_log with new business_id via onboarding_session_id
│   │       ├── event-playlist.js           ← Claude Haiku → direction-tracks → Spotify create+add + ledger
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
│   │   ├── anchor-tracks.js                ← v7 swipe-deck anchors → v7_anchor_tracks RPC (cheap playlist-sampling
│   │   │                                      pick, no BPM; anon key). Same origin guard + `anchor-tracks` rate bucket
│   │   │                                      as v5's. Needs migration 2026-09-24-v7-anchor-tracks.sql.
│   │   └── account/
│   │       ├── signup.js                   ← v7 onboarding→account bridge, after payment + the taste-profile bar.
│   │       │                                  Creates user + businesses row (version='v7', paid_at), SAVES the taste
│   │       │                                  profile, backfills gemini_call_log, then emails the magic link.
│   │       │                                  Never returns a session — email verification required.
│   │       ├── _taste-profile.js           ← Shared taste-profile → business_taste_profiles row builder.
│   │       ├── save-taste-profile.js       ← Owner-JWT profile write. NOT used by onboarding since 2026-09-24
│   │       │                                  (signup saves the profile); kept for later profile updates.
│   │       ├── set-delivery-mode.js        ← Writes business_v7_settings.delivery_mode (+ Option 2's timeline,
│   │       │                                  normalised); audits; returns the replace-today status.
│   │       ├── update-timeline.js          ← Saves the Option-2 timeline (normalised to current hours; no updated_at
│   │       │                                  bump); audits; returns the replace-today status.
│   │       ├── update-hours.js             ← v7 copy of v6's update-hours + reconciles the timeline (keep clock times).
│   │       ├── save-energy-directions.js   ← Persists Option-1 energy tiers into business_v7_directions.
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
│   ├── admin-api-for-michael.md            ← Instructions Michael feeds his own Claude to build his admin dashboard.
│   │                                          Kept in sync with /api/internal/* endpoint shape.
│   └── playlist-opens-delta.md             ← Focused delta doc for the 2026-08-30 addition of business_playlist_opens
│                                             tracking + the new fields on /api/internal/business.
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
│   ├── _v7-option2-dryrun.mjs               ← READ-ONLY: print a planned Option-2 day (clock, level, genre, duration per
│   │                                          track) for a fixture or a real business; --at=HH:MM to plan as of a time.
│   ├── _v7-option2-walkthrough.mjs          ← Option-2 live E2E (real Spotify, ~6 playlists, self-cleaning): timeline save,
│   │                                          hours reconciliation, build, replace-today (hide old / keep ledger), lock, cap.
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

### Genre list — `v6/generation/genre-list.js`

Shared canonical menu, currently 124 entries. As of 2026-09-23 the list lives in **`shared/genre-universe.js`** — one source of truth. Every consumer (v5 / v6 / v7 musical-directions.js, v6/generation/genre-list.js, transitively the event-playlist Haiku prompt and the direction-edit chat prompt) imports or re-exports from there. Kept in sync with the exact strings stored in `playlist_genres.genre` in Supabase — the RPCs lowercase-match. Grew from 73 → 105 across 2026-08 as Ami added new genres to Data Box Tab 2 and RapidAPI batch runs digested their seed playlists into `track_analyses`. Late-Aug / early-Sep churn: `Latin Funk` and `Greek Funk` added (Greek Funk seeded from the 2 world-funk playlists that got reassigned during the world-funk purge); `World Funk` and `Brit Funk` fully removed from the DB (playlists + exclusive tracks purged); `Thai Molam Funk` renamed to `Thai Molam` to match Ami's sheet update; `Alternative R&B`, `Hawaii ukulele music`, `Musica Tropical` added on 2026-09-02 after their sheet seeds digested cleanly. **2026-09-26** — 8 more added after clean Round 1 + Round 2 digestion: `Afro Cuban Jazz`, `Doo-Wop`, `Electronic R&B`, `French Touch`, `Italian Folk`, `Mo Town`, `Soft Pop Hits`, `Surf Rock` (4,390 total OK tracks across the group). See § PROMPT EDITING PROTOCOL for the current invariant.

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
- `/api/v6/account/event-chat` — 20/min (events-tab chat turn)
- `/api/v6/account/preview-direction` — shares the `anchor-tracks` bucket (60/min)
- `/api/v6/account/apply-direction-change` — 10/min (commits add/edit/remove)
- `/api/v6/account/toggle-super-like` — 60/min (super-like button toggle in the preview modal)
- `/api/v6/account/log-playlist-open` — 120/min (dashboard "▶ פתח" click log; higher than other write endpoints because bursty clicking through several playlists is legitimate)
- `/api/v7/account/update-timeline` (`v7-update-timeline`), `/api/v7/account/update-hours` (`v7-update-hours`), `set-delivery-mode` — 20/min
- `/api/v7/account/generate-daily` (`v7-generate-daily`) — 12/hour, plus a per-business build lock and the 2/day replace cap

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
- `businesses` — { id, owner_id, name, monthly_credits, credits_remaining, business_description, musical_emphases, onboarding_expanded, **version** (`'v6'` default | `'v7'`, added 2026-09-23), **paid_at** (timestamptz, added 2026-09-23) }. Written by signup. `business_description` + `musical_emphases` are the free-text prompt inputs the owner typed during onboarding (bizDesc + step-3 emphases); added 2026-08-23 for the internal admin API. PATCH path in signup.js skips blank values so repeat-onboarding with an empty field doesn't clobber a previously-recorded prompt. **`version`** gates which daily cron targets the business (v6 cron shut off; v7 cron filters `version='v7'`); **`paid_at`** is set on the v7 signup path only (placeholder payment-completion marker) and never cleared.
- `business_directions` — permanent per-business direction storage. Columns: { id, business_id, rank, title_en, description_he, genres (jsonb), bpm_range (jsonb), popularity_window (jsonb), **instrumentalness_preference** (`'none'|'soft'|'hard'`, added 2026-08-21), **popularity_preference** (`'none'|'soft'|'hard'`, added 2026-09-02), active (bool, soft-disable), created_at, updated_at }. Added 2026-08-20 migration — replaced the fragile "reconstruct directions from recent playlist_playlists.expansion" approach that cascaded to zero when the cron partially failed. Now the source of truth for daily-gen; `activeDirections(bizId)` in `_daily-builder.js` reads from here.
  - **8-active cap enforced by DB trigger** (`business_directions_cap`, added 2026-08-29). BEFORE INSERT OR UPDATE, per-business advisory-lock + count-active, raises `check_violation` if the write would push active count > 8. Closes the TOCTOU race in apply-direction-change's app-level check and rejects crafted signup payloads. Signup.js still trims client-side to the first 8 so a legitimate 8-pick onboarding never hits the trigger; apply-direction-change still returns its own friendly `cap_reached` code before the trigger fires so end-users see a nice message rather than a raw exception. Trigger is the last-line defense. See `v5/precompute/migrations/2026-08-29-directions-cap-trigger.sql`.
- `business_playlists` — one row per built Spotify playlist (onboarding sample, expanded daily, cron-generated daily, or event). Columns include { spotify_id, business_id, url, label, ico, track_count, genres, bpm_range, expansion (jsonb, legacy), event_id (nullable back-ref), direction_id (nullable FK → business_directions), track_ids (jsonb, ordered), **track_genres** (jsonb, v7 only — see below), expanded_at, expires_at, created_at }. Nothing deletes rows — `expires_at` gates dashboard visibility only. **This table is the permanent record of every playlist a business was ever served, with its tracks** (v6 and v7 alike): after expiry the Spotify playlist itself is emptied, so `track_ids` here is the only surviving record of its contents. Deleting the business (e.g. `scripts/purge-users.mjs`) takes these rows with it — run `scripts/backup-db.mjs` first if the history matters.
- `business_hours` — one row per business: { business_id, hours (jsonb — 0..6 day map with `{open,close,closed}`), longest_minutes, updated_at }. Upsert on business_id.
- `business_place` — one row per business (Google Places snapshot): { business_id, place_id, name, address, primary_type, types, editorial_summary, price_level, website_uri, vibe (jsonb), updated_at }. Upsert on business_id.
- `business_events` — { id, business_id, name, description, created_at }. Owner's chat-generated one-off event descriptions.
- `super_liked_tracks` — { id, business_id, spotify_id, created_at, deleted_at (nullable, added 2026-09-05), UNIQUE(business_id, spotify_id) }. Persisted at signup from `state.superLikedTracks`; also topped up by the direction-edit preview modal when the owner taps super-like on a track. Nothing consumes yet — captured for future taste-tuning. **Soft-delete via `deleted_at`**: un-super-liking sets `deleted_at = now()` rather than removing the row (so a track's engagement history isn't lost even if the owner toggles it off). Re-super-liking clears `deleted_at` back to NULL via the upsert path. Future readers should filter `deleted_at IS NULL` to see "currently super-liked."
- `business_playlist_opens` — { id bigserial, business_id, spotify_id, source ('home-daily' | 'home-event' | future), opened_at }. Append-only engagement log. One row per dashboard "▶ פתח" click. Not FK'd to `business_playlists` (matches `super_liked_tracks` pattern) — join manually on `spotify_id` when analyzing. `business_playlists` rows are never deleted (only `expires_at`-gated), so a click yesterday still resolves to its direction / genres / track_ids today. Client writes via fire-and-forget `POST /api/v6/account/log-playlist-open`; navigation to Spotify is never blocked on the write. Added 2026-08-26.
- `business_direction_chats` — { id, business_id, role ('user'|'assistant'), content (raw JSON for assistant / plain text for user), proposal (jsonb — parsed structured payload attached to an assistant turn: `{kind, direction_id?, updates?, spec?}`), selected_direction_id (nullable FK, which card the owner had selected when they sent this), created_at }. Rolling per-business message log for the profile-tab direction-edit chat. Client renders the transcript on tab open; server loads the tail (last 40) as Gemini chat history each turn.
- `business_direction_changes` — { id, business_id, direction_id (nullable — null when the pre-insert direction hasn't landed yet), kind ('add'|'edit'|'remove'), before (jsonb direction snapshot), after (jsonb direction snapshot), message_id_first, message_id_last (nullable FKs into business_direction_chats — the message range that produced this change), playlist_action ('rebuilt'|'expired'|'kept'|'renamed'|null), applied_at }. Written by `/api/v6/account/apply-direction-change` on every commit; surfaced by the internal admin API as the audit feed per business. `'renamed'` was added 2026-09-02 for the cosmetic-only edit fast path (title / description-only chat edits) — see the migration `2026-09-02-direction-changes-renamed-action.sql`.
- `business_settings_changes` — { id bigserial, business_id, field (text — `'name'` or `'hours'`), before (jsonb), after (jsonb), changed_at }. Audit log for business-level settings that upsert in-place (i.e. don't produce a versioned history on their own). Written by `api/v6/account/update-business-name.js` and `api/v6/account/update-hours.js` on every non-no-op save. `field` is free text (no CHECK-enum) so future settings can join without another migration; for `'name'` the before/after are JSON-quoted strings, for `'hours'` they're `{hours, longest_minutes}` objects. Added 2026-09-05 (migration `2026-09-05-owner-change-history.sql`).
- `business_event_chats` — { id, business_id, role ('user'|'assistant'), content (raw JSON for assistant / plain text for user), proposal (jsonb — `{name_he, description_he}` on confirming assistant turns; null otherwise), event_id (nullable FK → business_events; backfilled by `upsert-event.js` when the chat produces a saved event), created_at }. Rolling per-business message log for the special-events chat on `/v6/account`. Written by `POST /api/v6/account/event-chat`. Client's on-screen transcript still resets to empty on hard refresh / after finalize — a client `SESSION_START_AT_ISO` gates both what the browser shows AND what the server includes in Gemini's context. Persistence is orthogonal (every turn logged for admin visibility regardless of what the client displays). Added 2026-08-30 (migration `2026-08-30-event-chat.sql`).

**v7 production data (owned by v7 signup + account; migration `2026-09-23-v7-tables.sql`, RUN):**
- `business_taste_profiles` — one row per v7 business (PK `business_id`). The flat, full-catalog taste profile produced by `v7/generation/taste-profile.js` and persisted by `signup.js` at onboarding (before the verification email goes out). Columns: { business_id (uuid PK), energy_levels_total (int 2..6), approved_genres (jsonb — [{genre, energy_level}]), conditional_genres (jsonb — [{genre, energy_level, note_en}]; **DATA ONLY, builders ignore it**), excluded_genres (jsonb — [string]), instrumentalness_preference (text), popularity_preference (text), reasoning_en (text), audit_tally (jsonb, analytics) }. Owner-scoped RLS SELECT; service-role writes. Replaces `business_directions` as v7's taste source of truth.
- `business_v7_settings` — one row per v7 business (PK `business_id`). { business_id (uuid PK), delivery_mode (text CHECK IN ('option1','option2'); NULL until the gate is picked), timeline (jsonb — Option 2's energy timeline, v2 shape `{version:2, groups:[{days, open, close, points:[{m,e}]}]}`, see § V7 ARCHITECTURE "Option 2: energy timeline"), updated_at (bumped only by delivery-mode changes) }. Written by `set-delivery-mode.js`, `update-timeline.js`, and `update-hours.js` (reconciliation). Changes are audited in `business_settings_changes` (fields `delivery_mode`, `energy_timeline`; plus `daily_playlists_replaced` per "replace now").
- **`track_analyses.duration_sec`** (int, added 2026-09-24, migration `2026-09-24-v7-timeline-pool.sql`) — track length parsed from `raw_analysis->>'duration'` ("m:ss"), filled by a `BEFORE INSERT OR UPDATE OF raw_analysis` trigger (covers every analysis writer) + a one-time backfill. Used by the Option-2 builder via the `v7_timeline_pool` RPC.
- `business_v7_directions` — Option-1 energy-tiered directions (populated at mode selection via `save-energy-directions.js`). { id (uuid PK), business_id (FK→businesses ON DELETE CASCADE), energy_tier (text CHECK IN ('high','low')), rank (int), title_en (text), genres (jsonb — [string], canonical), active (bool DEFAULT true), created_at }. Partial index on (business_id) WHERE active. Only Option 1 uses this; Option 2 builds straight from `business_taste_profiles.approved_genres`.
- **v7 `business_playlists` rows insert `direction_id: null`** — that column is an FK to v6's `business_directions`; a `business_v7_directions` id would violate it (the two are different tables). See the v7 daily runtime mechanism in § V7 ARCHITECTURE.
- **`business_playlists.track_genres`** (jsonb, added 2026-09-24, migration `2026-09-24-v7-track-genres.sql`) — v7's per-track genre record, next to `track_ids`: `{ "<spotify_id>": ["Bossa Nova"], ... }` = which of the playlist's OWN genres each track belongs to in the catalog (canonical names; two entries when a track is tagged with two of them; `[]` if the catalog no longer ties it to any). NULL for v6 rows. Written at build time by `attachTrackGenres` in `api/v7/account/_daily-builder.js` (cron and on-demand builds) via the server-only **`v7_track_genres(p_spotify_ids, p_genres)`** RPC (`playlist_tracks` → `playlist_genres`). Best-effort: a failed lookup never blocks the build, and `insertPlaylistRows` retries without the column if it's missing, so the playlist record itself is never lost. Rows built before the column existed: `scripts/_v7-backfill-track-genres.mjs` (dry run; `--apply` writes).

**Ledgers + operational state:**
- `created_playlists` — the expiry ledger. Columns: `spotify_id` (PK), `name`, `expires_at`, `deleted_at`, `error`, `owner_id` (nullable FK → auth.users), `business_id` (nullable FK → businesses). Both FKs use ON DELETE SET NULL so the cron can still unfollow expired playlists after their owner/business is deleted. Rows written by onboarding (via /api/v5/record-playlist) start with NULL owner/business — signup.js back-fills them. Renamed from `v5_created_playlists` on 2026-08-02; migration in `v5/precompute/migrations/`.
- `v6_daily_track_history` — { business_id, direction_key, spotify_id, served_at }. Per-(biz, direction) served-track history for cross-day dedup. See "Cross-day track dedup" mechanism below. Cron opportunistically prunes rows older than 14 days.
- `gemini_call_log` — one row per Gemini API call. Columns: { id, created_at, model, label, input_tokens, output_tokens (includes thinking tokens for cost purposes), thinking_tokens (broken out for analytics), total_tokens, cost_usd (numeric 12,8), business_id (nullable FK), onboarding_session_id (nullable text), http_status, finish_reason }. Written fire-and-forget by `api/v6/gemini.js` after every call — success OR failure. Cost computed server-side via `api/v6/gemini-pricing.js` using date-aware per-model rates (Google's paid Standard tier; auto-switches on 2027-01-01 when the price doubles). Label values in use: `onboarding` (Round-1 musical directions), `onboarding-refined` (Round-2 refinement — added 2026-08-31; see the "Round 2 refinement flow" mechanism above), plus post-signup labels for event chat / direction-edit chat / preview-direction. Attribution: post-signup callers pass `business_id` directly; onboarding callers pass a client-generated tab-lifetime `onboarding_session_id` which `signup.js` backfills into `business_id` (and clears the session id) on account creation — this applies to both `onboarding` and `onboarding-refined` label rows since R2 fires during the same tab-lifetime session as R1. Rows with `onboarding_session_id` set but no `business_id` = "abandoned onboarding" bucket surfaced by the internal admin spend endpoint. Added 2026-08-25; RLS on with no policies (writes go through service_role).

**Archive tables (owner + Ami actions):**
- `deleted_tracks` — archive keyed by `spotify_id`. Snapshot of the track's `playlist_tracks` rows + its `track_analyses` row before deletion. Written by `api/v4/ami-track-delete.js` (Ami's cleanup flow); consumed and dropped by `api/v4/ami-track-restore.js`. RLS on with no anon-read policy (dashboard hits go through service_role).
- `deleted_playlists` — archive keyed by `playlist_id`. Columns: { playlist_id (PK), name, owner, playlist_genres_rows (jsonb), playlist_tracks_rows (jsonb), deleted_at }. Written by `api/v4/ami-playlist-delete.js`; consumed and dropped by `api/v4/ami-playlist-restore.js`. Added 2026-08-30 (migration `2026-08-25-deleted-playlists.sql`). Same RLS posture as `deleted_tracks`. **Does not archive `track_analyses`** — that cache is shared with any other playlist the tracks live in and is expensive to rebuild via RapidAPI.
- `deleted_events` — archive keyed by `id` (same as the original `business_events.id`). Columns: { id (PK, uuid), business_id, name, description, original_created_at, deleted_at }. Written by `api/v6/account/delete-event.js` (owner-triggered, from the Home tab's event trash icon). No restore endpoint — the events chat flow is delete + re-chat by design (see Special event playlists section), so the archive is admin-visibility only, not a rollback mechanism. Added 2026-09-05 (migration `2026-09-05-owner-change-history.sql`). Same RLS posture as the other archives.

**Historical / vestigial:** `analyses`, `track_feedback`, `app_settings` (old OpenAI key storage — the `openai_key` row + its permissive RLS were removed during the 2026-08-14 security audit), `spotify_tokens` (v1 era).

### Track pool coverage

**~121k successfully-analyzed tracks** in `track_analyses` as of 2026-09-08; the count has grown incrementally as batch runs digest new genres (jazzhop, latin funk, Alternative R&B, Hawaii ukulele music, Musica Tropical, Israeli genres, Japanese Folk, and a handful of others through early September). This is the pool `v5_direction_tracks` and `v6_direction_tracks_recent` select from. To get the current authoritative count, run `SELECT count(*) FROM track_analyses` in Supabase (or grep the batch log: `grep -Ec "\] ok [A-Za-z0-9]{22} " v4/precompute/state/batch.log`). **Do not trust exploration-agent estimates over this number** — an Explore agent once returned a bogus 31k and misled a planning session. Distribution across the canonical genre list (116 entries as of 2026-09-02 per `v6/generation/genre-list.js`) is uneven; biz types added earlier (café, pizzeria) have deeper pools than newly-added Latin / Asian / world-fusion genres.

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
| v7 Musical directions (R1 + R2 + taste-profile + energy-directions) | `gemini-3.6-flash`, thinking=high | `v7/generation/ai-provider.js` `PROVIDER='gemini'` | INDEPENDENT of v6's switch. Same values today but decoupled — flipping v6's PROVIDER does not affect v7 or Ami's dashboard (which imports v7's ai-provider since 2026-09-23). Labels for `gemini_call_log`: `v7-onboarding`, `v7-onboarding-refined`, `v7-taste-profile`, `v7-energy-directions`. |
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
behavior end-to-end.

Known small gap: the dashboard's `formatDirection` renders title/genres/
description but NOT `instrumentalness_preference` / `popularity_preference`,
so Ami can't eyeball those classifier outputs when previewing v7. Two-line
addition when we next touch the dashboard.

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
| `CRON_SECRET` | `api/cron/expire-playlists.js`, `api/cron/v7-generate-daily.js` (+ the unscheduled `generate-daily.js`) auth check | Vercel Cron sets `Authorization: Bearer <secret>` header. Also gates the v7 walkthrough scripts' manual cron trigger. |
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
- Function `maxDuration` per endpoint (30s default; 60s for anthropic + transcribe + event-playlist + expand-playlist; 300s for the cron entrypoints, both generate-daily endpoints, and **`/api/v6/gemini`** — raised from 60s on 2026-09-24 because v7's taste-profile call generates ~8.6k–13k tokens (mostly thinking) at ~150 tok/s ≈ 57–88s, over the old limit. The proxy is shared by v6 and v7; the higher ceiling doesn't change normal calls)
- **Cron schedule (two hourly crons, deliberately staggered)** — cut over to v7 on 2026-09-23:
  - `/api/cron/v7-generate-daily` at `0 * * * *` — the LIVE per-business daily playlist builder. Targets `version='v7'` businesses only; branches option1/option2 (see the v7 daily runtime mechanism in § V7 ARCHITECTURE).
  - `/api/cron/expire-playlists` at `30 * * * *` — sweeps expired ledger rows (rename + empty + unfollow on Rubin). Version-agnostic — sweeps both v6 and v7. Moved off `:00` on 2026-08-29 as part of the resilience layer so it can't overlap top-of-hour daily-gen writes.
  - **`/api/cron/generate-daily` (v6) was REMOVED from `crons` on 2026-09-23** — the user did not want to keep making that many Spotify calls once v7's builder came online. The file stays in-tree (revivable) but nothing schedules it, so v6 businesses get no new daily playlists (existing ones expire normally). **Also hard-disabled in code (2026-09-24):** `V6_DAILY_CRON_DISABLED = true` at the top of the handler makes it a no-op even if a stale deploy still schedules it (prod did, until the next deploy) or someone triggers it by hand. It has NO `version` filter and would NOT skip v7 businesses — v7 accounts DO get `onboarding_expanded = true` (the account app copied from v6 sets it on first visit) — so reviving it needs both the flag flipped and a `version=eq.v6` filter.
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

Five musical-directions prompts exist across two versions, tracked in two audit-log files:

**v6 (production)** — tracked in `prompt-history.md`:
- **v6 Round 1** — `EDITABLE_PROMPT_SECTION` + `FIXED_PROMPT_SECTION` in `v6/generation/musical-directions.js`, both composed from named sub-constants. Mirrored byte-for-byte in `v5/generation/musical-directions.js` (kept for legacy `v5/app.js` — no longer read by Ami's dashboard).
- **v6 Round 2** — R2-specific sub-constants inside `v6/generation/refined-directions.js`, composed on top of shared sub-constants imported from R1's file. No v5 mirror (R2 is v6-only).

**v7 (runtime built)** — tracked in `prompt-history-v7.md`:
- **v7 Round 1** — `v7/generation/musical-directions.js`. Diagnostic taste probes (see § V7 ARCHITECTURE). What Ami's dashboard tunes against.
- **v7 Round 2** — `v7/generation/refined-directions.js`. Imports shared sub-constants from v7 R1.
- **v7 Taste profile** — `v7/generation/taste-profile.js`. Full 116-genre bucketing + per-user energy scale.
- **v7 Energy directions** — `v7/generation/energy-directions.js`. Option-1 energy-tiered directions from `approved_genres`. `Applies to: energy directions`.

**Any edit to any prompt** appends a NEW entry at the top of the correct history file (v6 edits → `prompt-history.md`; v7 edits → `prompt-history-v7.md`). Each entry MUST include:
- An **Applies to:** line. For v6: `Round 1` / `Round 2` / `both`. For v7: `Round 1` / `Round 2` / `taste profile` / `R1+R2` / `all v7`.
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
2. Open `http://127.0.0.1:3000/` — root rewrite lands on v6. `http://127.0.0.1:3000/v6` also works.

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
Source: `created_playlists` ledger (not `GET /me/playlists`) because current refresh token lacks read scope. Ledger row marked `deleted_at` automatically so the cron doesn't re-process.

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

`v4/precompute/dry-run-orphans.mjs` gained:
- `--exclude-genres="a,b,c"` — drops orphans whose playlist is tagged to any of the listed genres. Use when a specific genre's playlists are causing upstream storms and you want to keep filling everything else without touching the DB (they stay orphans, no blacklist).

Typical fail-fast recovery run:
```powershell
node v4/precompute/dry-run-orphans.mjs --exclude-genres="samba-choro"
node v4/precompute/batch.mjs --max-rapidapi-calls=1000000 --max-error-retries=0 --no-storm-abort
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

## OPEN QUESTIONS FOR V7 PIPELINE BUILD

Originally a punch list from the 2026-09-23 v7 prompt-authoring session. Most of it was **resolved by the runtime build later that day** — those are marked RESOLVED below (kept, not deleted, so the reasoning is on record). The genuinely-still-open items follow.

### RESOLVED — Downstream persistence

v7 does NOT reuse `business_directions`. Signup persists the flat taste profile to the new **`business_taste_profiles`** table (plus `business_v7_settings` and, for Option 1, `business_v7_directions`) — effectively option (b) from the original write-up, but WITHOUT refactoring v6's readers: v6's daily cron is shut off, and v6's direction-chat / admin API simply see no v7 rows (acceptable for now). See § V7 ARCHITECTURE + DATA MODEL. Remaining sub-item: the internal admin API has no v7 view yet.

### RESOLVED — Playlist builder for v7

Built as two delivery modes (see the v7 daily runtime mechanism in § V7 ARCHITECTURE): **Option 1** = 4 playlists/day (2 high + 2 low energy-tier directions from `business_v7_directions`); **Option 2** = 2 mixes/day whose energy follows the owner-drawn timeline, placed by track duration (built 2026-09-24 — `api/v7/account/_option2-builder.js`; see "Option 2: energy timeline" in § V7 ARCHITECTURE; needs migration `2026-09-24-v7-timeline-pool.sql`). Driven by `api/cron/v7-generate-daily.js`. Still-open refinements: Option 1 is still count-based (3.5 min/track assumed vs 4.16 measured — could reuse the duration pool); whether the account-tab direction-chat becomes a "taste-profile edit chat" is undecided (ships dormant); the `conditional` bucket is stored but not consumed (below).

### RESOLVED (interim) — BPM parameter on `v5_*_tracks` RPCs

The swipe deck no longer touches these RPCs — it uses the tempo-free `v7_anchor_tracks` (next item). The v7 daily builders still pass a wide-open `0–300` window to `v6_direction_tracks_recent` as a no-op tempo filter (service key, server-side). A real "no-filter" mode on that RPC remains an optional cleanup.

### RESOLVED for v7 — anchor query cost

`v5_anchor_tracks` is slow because it random-sorts every tempo-matching track to return one (its cost follows the tempo window via `track_analyses`' tempo index, not the genre). v7 now uses **`v7_anchor_tracks`** (migration `2026-09-24-v7-anchor-tracks.sql`): per spec it samples 8 random playlists of the genre and picks from their tracks, with bounded work and no tempo. Verified 2026-09-24 against prod on the anon key: 4-card pages in ~0.3–0.5s warm / ~0.5–1.5s on never-touched genres, 0/14 failures (only the function's very first execution ever 57014'd — one-off warmup, and the endpoint + client retries absorb that). Hard-instrumental parity with the exhaustive old function: where v7 returns no card (e.g. Country, Trap), `v5_anchor_tracks` also finds nothing in the whole genre — a data limit, not a sampling miss. **v6 intentionally stays on `v5_anchor_tracks`** (kept alive by choice); its 4-card call sits at ~2.2–2.5s against the anon 3s ceiling (see § SUPABASE PERFORMANCE NOTES). If v6 ever needs relief, a tempo-aware sampling variant is the natural next step.

### RESOLVED — `vercel.json` `/v7/(.*)` no-cache rule

The `/v7` + `/v7/(.*)` no-cache header blocks now exist in `vercel.json` (added when v7 grew its UI), matching the `/v5` + `/v6` pattern.

### OPEN — v7 browser-flow gaps found in the 2026-09-23 audit

Confirmed by reading both sides; not yet fixed (each needs a decision):
- **v6 and v7 share one browser session.** Same origin → same `sb-*-auth-token` localStorage key. A v6-logged-in owner opening `/v7` is redirected to `/v7/account` (head script in `v7/index.html`) and sees their v6 business behind the v7 delivery-mode gate; `v7/account/app.js` never checks `businesses.version`, so picking a mode writes `business_v7_settings` for a `version='v6'` business the v7 cron never builds. Reverse also holds. Test with `?reset=1`. Likely fix: route by `business.version` in both account apps.
- **Misleading copy:** the v7 registration heading "הפלייליסטים שלכם מוכנים!" (`v7/result.js`) claims playlists are ready; v7 hasn't built any at that point.

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
- **Hebrew description reframing** as explicit probe language (`בודק פתיחות ל…` / `בודק חיבור ל…`).

Ami separately said he'd apply his own fix for the barbershop bug (Funk + Neo Soul + Acid Jazz cluster) after that session; his output may supersede or complement the current `BEAT_PERCUSSION_RULE` groove-family disambiguation. Check with Ami before treating the current v7 R1 as settled.

### v5 dead-code cleanup

`v5/generation/musical-directions.js` has a stale header comment describing "TWO Claude calls" and a `MODEL = 'claude-sonnet-4-6'` constant + `MAX_TOKENS = 4000` that nothing references. v5's dashboard now imports from v7; v5's `app.js` imports `generateMusicalDirections` but production is on Gemini via the (now-swapped) dashboard-side ai-provider. Roni acknowledged; deferred to keep scope tight. Safe to `git rm` or clean up in a small pass.

### Dashboard's `formatDirection` — no `instrumentalness_preference` / `popularity_preference` render

Ami's prompt-tuning dashboard renders title/genres/bpm/description but skips the two preference fields on the preview output. Since v7 emits both and Ami is tuning against v7, Ami currently can't eyeball the classifier's output for those fields. Two-line addition to `v5/ami-prompt-dashboard/app.js`'s `formatDirection`. Not a blocker.

### Cache-bust identifier drift (cosmetic)

Some cache-bust `?v=` identifiers in the dashboard use `20092026a` (September 20). Actual date of the edit was 2026-09-23. Identifier scheme is `DDMMYYYY{letter}` per this doc's Cache Busting rules; the values are just uniqueness tokens now. If we bump for another cache invalidation, use the current date.

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
