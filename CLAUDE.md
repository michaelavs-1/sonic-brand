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
    orange play button (bottom-right, larger 36px icon) + super-like button
    (bottom-left, 44px, tilted -12°). Below the art: title, artist,
    Spotify-green "נסו שיר אחר מהכיוון הזה" pill (with a shuffle icon),
    reason line, and the scrubbable playback progress bar.
  - Spotify iframe hidden inside .sw2-artwrap with opacity:.01 (fully
    offscreen kills media). Custom sw2-play button drives it via the
    IFrame API.
  - Super-like button (.sw2-superlike): the current model is NOT a plain
    toggle — clicking it (a) records the trackId in state.superLikedTracks
    (Set), (b) counts the card's direction as LIKED, (c) advances to the
    next card. A short "סופר לייק" toast confirms. Idle glow (breathing
    halo) sits on the button between cards.
  - Pointer guards in the swipe handler ignore clicks on .sw2-play,
    .sw2-superlike, .swap-btn, and .sw2-prog-bar so those buttons never
    accidentally trigger a swipe gesture.
  - Swiping right = "build a playlist for this direction" (same effect
    as super-like's implicit "liked").
        ↓
STEP 6: Playlist build (v6/generation/playlist-builder.js buildDirectionPlaylists)
  - TARGET_TRACKS = 10 per playlist, one per picked direction, built with
    BUILD_CONCURRENCY=3 (worker pool, was Promise.all — capped after
    Spotify 429s during the pilot-hardening pass).
  - Each playlist:
    - POST /api/v5/direction-tracks → 10 track IDs (instrumentalness_pref
      forwarded so the pool honors the emphasis-derived filter/bias)
    - POST /api/new/spotify create_playlist + add_tracks (Rubin account)
    - POST /api/v5/record-playlist → 24h expiry ledger entry
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
Boot: loads user, businesses, meta.b[businessId]
        ↓
renderAll:
  - Greeting + business name
  - Place banner (if Google Places was confirmed during onboarding)
  - renderPlaylists: reads bmeta().playlists
    - Playlist entries with expansion:{...} and !expandedAt get an animated
      progress bar and a background expansion kicks off
  - renderEvents: reads bmeta().events. Per-row layout is
    [🎪 name/description] [red trash SVG button (btn-danger)] [action button].
    The pencil edit icon was dropped in the 2026-08-20 chat rewrite —
    workflow is now delete + re-chat. Trash uses a Feather-style outline
    SVG in a red `.btn.btn-danger.event-del` button (no emoji), spinner
    only while deleting (no "מוחק…" label).
    - "צרו פלייליסט" button hits /api/v6/account/event-playlist
        ↓
Background: expandPendingPlaylists (v6/account/app.js) — STRICT one-time
per-business event. Runs on the very first dashboard visit after onboarding:
the 10-track sample playlists each grow to today's opening hours + 1h.
  - Enforcement: business-level flag `b[bizId].onboardingExpanded = true`
    is set BEFORE any expansion work starts, so a mid-pass tab close /
    refresh / crash never causes a second pass. Even if some playlists
    end up under-populated, they are never re-populated. Daily-gen
    (separate future task) handles fresh playlists on subsequent days.
  - Expansions run SEQUENTIALLY (not Promise.all). Parallel writes to
    user_metadata previously caused a last-writer-wins race that clobbered
    sibling expandedAt fields and led to real duplicate tracks piling up
    in Spotify on refresh. Cost: total time ≈ Σ per-playlist expansions.
  - Server: /api/v6/account/expand-playlist re-reads user_metadata just
    before writing so unrelated concurrent writes (name edit, event
    playlist prepend) are preserved.
  - Client computes per-day target via v6/generation/playlist-length.js:
    computeTargetForToday({ hours }) → (todaysOpenMinutes + 60) / 3.5min
    Closed day / hours missing → CLOSED_DAY_MINUTES (12h) + 1h ≈ 223 tracks.
    Floors at 10 tracks, cap at 500 on server.
  - Example (open day): Tuesday 09:00-21:00 → 12h + 1h buffer → ~223 tracks
  - Example (closed day, no playlists for today): title flips to
    "יום ש' - המקום סגור  [המקום פתוח?]" — link opens a confirm modal
    that POSTs /api/v6/account/generate-daily. That endpoint reuses the
    LATEST direction set (grouped by createdAt) and builds one 12h playlist
    per direction, prepending them to user_metadata.b[bizId].playlists
    with today's createdAt so the closed-day title flips back to normal.
```

### Direction-edit chat (profile tab)

Gemini chatbot on `/v6/account`'s Profile tab, between שם העסק and שעות פעילות. Lets the owner refine their `business_directions` after onboarding: add (up to the 8-active cap), remove (soft-disable — the row is preserved with `active=false`), or fine-tune an existing direction (exclude/add genres, adjust BPM, flip inst_pref, rename, reshape description_he).

- **UI** (`v6/account/index.html` + `v6/account/direction-chat.js`):
  - Row of clickable direction cards (`.dir-card`, title + description_he) above the chat. Clicking a card sets `state.selectedDirectionId` — the next chat turn is scoped to that direction unless the message names a different one. Click the same card again to deselect.
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

- **Chat prompt** (`v6/generation/direction-edit-chat-prompt.js`) enforces:
  - Exposure rules: chat may freely mention title / description_he / qualitative BPM feel, but never enumerates a direction's genres unprompted. Owner-named genres are fair game. Never exposes numeric BPM or the inst_pref enum.
  - Contradiction rule: if the ask contradicts the initial onboarding context or a prior committed change, surface it in one sentence and let the owner override. Latest chat wins.
  - Add is two-step: paraphrase intent → owner confirms → full spec (title + description + genres + bpm + inst_pref) emitted as an `add` proposal.
  - Genre universe pinned to the same 73-genre canonical list as musical-directions; the model must return canonical strings verbatim.

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
- Returns instant login link (magic-link admin API) so client can jump to `/v6/account` without email round-trip
- **Magic-link redirect** (`accountRedirectUrl`) derives the target from the request host (`x-forwarded-host` || `host`) so signup on localhost / preview / robin-music.com / sonic-brand.vercel.app each redirects back to where the user came from — no per-env config needed. The derived host is validated via `isAllowedHost()` in `api/v6/origin-guard.js` to block `x-forwarded-host: attacker.com` spoofing. Whatever host wins must also be on Supabase's Redirect URLs allowlist (Auth → URL Configuration) — otherwise Supabase silently substitutes its Site URL. `V6_ACCOUNT_REDIRECT_URL` env var overrides derivation entirely if you need a pinned target.

---

## FILE STRUCTURE (V6-focused)

```
sonic-brand/
├── v6/                                     ← CURRENT ACTIVE UI
│   ├── index.html                          ← Onboarding shell + all v6 CSS (splash, swipe, hours, progress bars)
│   ├── app.js                              ← Onboarding orchestrator: state machine, clickable 6-step nav
│   ├── atmosphere.js                       ← Atmosphere-selection screen driver
│   ├── atmosphere-bubbles.js               ← Bubble-grid renderer used by atmosphere.js (rewrite of the old chip grid)
│   ├── emphases.js                         ← Step 3 "דגשים מוזיקליים" — one textarea + skip button
│   ├── hours-selector.js                   ← Opening hours picker (shared + master days, "שעות שונות" override)
│   ├── preview.js                          ← Michael's swipe deck + preparePreview (background prefetch)
│   ├── result.js                           ← Progressive results shell + "אני רוצה את רובין" CTA + signup card
│   ├── generation/
│   │   ├── ai-provider.js                  ← PROVIDER='gemini'|'anthropic' switch. Shared by v6 + Ami dashboard.
│   │   ├── musical-directions.js           ← Direction generator prompt + call (uses ai-provider). Split
│   │   │                                      into EDITABLE + FIXED prompt sections; mirrored in v5/.
│   │   ├── event-chat-prompt.js            ← System prompt for the special-events chat on /v6/account
│   │   ├── direction-edit-chat-prompt.js   ← System prompt for the profile-tab direction-edit chat
│   │   ├── genre-list.js                   ← Canonical 73-genre list (shared with event-playlist server)
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
│   ├── v6/
│   │   ├── origin-guard.js                 ← requireSite / requireSiteOrInternal helpers
│   │   ├── ratelimit.js                    ← Upstash-Redis fixed-window guard (see mechanism section)
│   │   ├── gemini.js                       ← Google Gemini generateContent proxy (multi-turn via `history`)
│   │   ├── place-lookup.js                 ← Google Places (New) v1 textsearch
│   │   ├── transcribe.js                   ← Whisper (OpenAI)
│   │   └── account/
│   │       ├── _daily-builder.js           ← Shared build+persist module: buildDailyBatch, activeDirections
│   │       ├── _expire-playlist.js         ← Shared expirePlaylistNow() — rename + empty + unfollow + mark deleted.
│   │       │                                  Used by both the hourly cron and direction-chat's apply endpoint.
│   │       ├── signup.js                   ← Supabase admin user + business + business_directions + super_liked_tracks
│   │       ├── event-playlist.js           ← Claude Haiku → direction-tracks → Spotify create+add + ledger
│   │       ├── expand-playlist.js          ← Streaming ndjson: grow onboarding playlists to per-day target
│   │       ├── generate-daily.js           ← Closed-day "המקום פתוח?" flow (delegates to _daily-builder)
│   │       ├── update-hours.js             ← Profile-page hours edit
│   │       ├── upsert-event.js             ← business_events insert/update from the event chat finalize
│   │       ├── delete-event.js             ← Card-level delete
│   │       ├── direction-chat.js           ← One Gemini turn for the direction-edit chat; persists both messages
│   │       ├── preview-direction.js        ← Round-robin anchor track for a merged (edit) or inline (add) spec
│   │       ├── apply-direction-change.js   ← Commit add/edit/remove; rebuild playlist; audit row
│   │       └── toggle-super-like.js        ← Upsert/delete one super_liked_tracks row (decoupled from apply)
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
│   │   └── ...                             ← Legacy v4 endpoints (openai, spotify, biztype-match, cached-*)
│   ├── new/
│   │   ├── spotify.js                      ← Two-app Spotify proxy (Michael CC reads + Rubin user writes)
│   │   │                                      429 handler capped at 5s (was 30s — see cron section)
│   │   ├── openai.js                       ← GPT proxy (legacy)
│   │   └── rubin-oauth-callback.js         ← One-time OAuth seed for RUBIN_REFRESH_TOKEN
│   ├── cron/
│   │   ├── expire-playlists.js             ← Hourly cron. Renames + empties + unfollows expired playlists.
│   │   │                                      Tolerates 404 (isGone helper) so purged playlists don't loop.
│   │   └── generate-daily.js               ← Hourly cron. Skip guards: not-onboarding-done, no-hours,
│   │                                          closed-today, past-close, already-built-today, too-early,
│   │                                          no-directions. Then buildDailyBatch (concurrency-capped).
│   ├── internal/
│   │   ├── _guard.js                       ← Shared bearer-token guard for the /api/internal/* admin surface
│   │   ├── users.js                        ← GET list of businesses + owner emails (Michael's dashboard)
│   │   └── business.js                     ← GET one business's full onboarding prompt + directions + playlists
│   ├── openai.js, spotify.js, databox.js   ← Root-level legacy proxies (v1/v2/v3-era)
├── scripts/
│   ├── benchmark-directions.mjs            ← OpenAI vs Anthropic timing/quality benchmark
│   ├── purge-rubin-playlists.mjs           ← Unfollow all Rubin playlists (source: created_playlists ledger)
│   ├── purge-users.mjs, purge-users-except.mjs ← Tear down test users end-to-end
│   ├── migrate-directions-to-table.mjs     ← Backfill business_directions from historical business_playlists.expansion
│   ├── test-super-liked-tracks.mjs         ← Integration test for the super-like DB path
│   ├── test-instrumentalness-preference.mjs ← Integration test for the 3-state inst_pref RPC behavior
│   ├── test-cron-daily-guards.mjs          ← Integration test for the past-close + anyBuiltToday guards
│   ├── mirror-vercel-deployment.mjs        ← Pull deployment source via Vercel API
│   └── mirror-live-site.mjs                ← Pull deployed static assets via HTTP
├── benchmark-results/                      ← JSON outputs from benchmark script
├── prompt-history.md                       ← Audit log for EDITABLE_PROMPT_SECTION changes — update on every prompt edit
├── tests/                                  ← Legacy test scripts (mostly v3/v4 era)
├── .env.local                              ← Gitignored. Has ANTHROPIC_KEY, GEMINI_API_KEY, RUBIN_*, SUPABASE_*,
│                                              UPSTASH_REDIS_REST_KV_REST_API_URL/TOKEN, INTERNAL_API_KEY,
│                                              INTERNAL_ADMIN_API_KEY, CRON_SECRET, TRACK_ANALYSIS_*
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

### Genre list — `v6/generation/genre-list.js`

Shared 73-genre canonical menu. Both `musical-directions.js` (for the system prompt) and `api/v6/account/event-playlist.js` (Claude Haiku prompt) import from here. Kept in sync with the exact strings stored in `playlist_genres.genre` in Supabase — the RPCs lowercase-match.

### Playlist auto-expiry

Every playlist created via `/api/new/spotify` create_playlist gets a row in
`created_playlists` (`spotify_id`, `name`, `expires_at`, `deleted_at`,
`error`). Hourly cron `/api/cron/expire-playlists` picks up any row with
`expires_at <= now()` and unfollows on Rubin's side (rename → empty →
unfollow → mark `deleted_at`; 404 treated as already-gone via `isGone`).

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
   Spotify playlist per direction, with `BUILD_CONCURRENCY=2` + a 300ms
   stagger between starts (was `Promise.all` — capped after Spotify
   create_playlist 429s tripped the api/new/spotify 30s Vercel budget
   during the same 2026-08-22 incident). Single batch INSERT into
   business_playlists at the end.
9. Ledger row's `expires_at` reuses the `todaysExpiryIso` computed for
   the past-close check in step 4 (same source of truth as the
   `business_playlists.expires_at` column).
10. Opportunistic prune: DELETE `v6_daily_track_history` rows > 14 days old.

Auth: `Authorization: Bearer ${CRON_SECRET}` (same as `expire-playlists`).

**Related hardening in the Spotify proxy**: `api/new/spotify.js` used to
sleep up to 30s on a Spotify `Retry-After` header (429), which could eat
the whole 30s Vercel `maxDuration` and produce a 504. Cap is now 5s.
Combined with the daily-gen guards, hourly 429 bursts became impossible
in practice.

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
- **Resend account**: separate login, owned by Roni. API key kept in
  Supabase — NOT in `.env.local` or Vercel env, since nothing in our
  own code talks to Resend directly.
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
- `business_directions` — permanent per-business direction storage. Columns: { id, business_id, rank, title_en, description_he, genres (jsonb), bpm_range (jsonb), popularity_window (jsonb), **instrumentalness_preference** (`'none'|'soft'|'hard'`, added 2026-08-21), active (bool, soft-disable), created_at, updated_at }. Added 2026-08-20 migration — replaced the fragile "reconstruct directions from recent playlist_playlists.expansion" approach that cascaded to zero when the cron partially failed. Now the source of truth for daily-gen; `activeDirections(bizId)` in `_daily-builder.js` reads from here.
- `business_playlists` — one row per built Spotify playlist (onboarding sample, expanded daily, cron-generated daily, or event). Columns include { spotify_id, business_id, url, label, ico, track_count, genres, bpm_range, expansion (jsonb, legacy), event_id (nullable back-ref), direction_id (nullable FK → business_directions), track_ids (jsonb, ordered), expanded_at, expires_at, created_at }. Nothing deletes rows — `expires_at` gates dashboard visibility only.
- `business_hours` — one row per business: { business_id, hours (jsonb — 0..6 day map with `{open,close,closed}`), longest_minutes, updated_at }. Upsert on business_id.
- `business_place` — one row per business (Google Places snapshot): { business_id, place_id, name, address, primary_type, types, editorial_summary, price_level, website_uri, vibe (jsonb), updated_at }. Upsert on business_id.
- `business_events` — { id, business_id, name, description, created_at }. Owner's chat-generated one-off event descriptions.
- `super_liked_tracks` — { id, business_id, spotify_id, created_at, UNIQUE(business_id, spotify_id) }. Persisted at signup from `state.superLikedTracks`; also topped up by the direction-edit preview modal when the owner taps super-like on a track. Nothing consumes yet — captured for future taste-tuning.
- `business_direction_chats` — { id, business_id, role ('user'|'assistant'), content (raw JSON for assistant / plain text for user), proposal (jsonb — parsed structured payload attached to an assistant turn: `{kind, direction_id?, updates?, spec?}`), selected_direction_id (nullable FK, which card the owner had selected when they sent this), created_at }. Rolling per-business message log for the profile-tab direction-edit chat. Client renders the transcript on tab open; server loads the tail (last 40) as Gemini chat history each turn.
- `business_direction_changes` — { id, business_id, direction_id (nullable — null when the pre-insert direction hasn't landed yet), kind ('add'|'edit'|'remove'), before (jsonb direction snapshot), after (jsonb direction snapshot), message_id_first, message_id_last (nullable FKs into business_direction_chats — the message range that produced this change), playlist_action ('rebuilt'|'expired'|'kept'|null), applied_at }. Written by `/api/v6/account/apply-direction-change` on every commit; surfaced by the internal admin API as the audit feed per business.

**Ledgers + operational state:**
- `created_playlists` — the expiry ledger. Columns: `spotify_id` (PK), `name`, `expires_at`, `deleted_at`, `error`, `owner_id` (nullable FK → auth.users), `business_id` (nullable FK → businesses). Both FKs use ON DELETE SET NULL so the cron can still unfollow expired playlists after their owner/business is deleted. Rows written by onboarding (via /api/v5/record-playlist) start with NULL owner/business — signup.js back-fills them. Renamed from `v5_created_playlists` on 2026-08-02; migration in `v5/precompute/migrations/`.
- `v6_daily_track_history` — { business_id, direction_key, spotify_id, served_at }. Per-(biz, direction) served-track history for cross-day dedup. See "Cross-day track dedup" mechanism below. Cron opportunistically prunes rows older than 14 days.

**Historical / vestigial:** `analyses`, `track_feedback`, `app_settings` (old OpenAI key storage — the `openai_key` row + its permissive RLS were removed during the 2026-08-14 security audit), `spotify_tokens` (v1 era).

### Track pool coverage

**~90.5k successfully-analyzed tracks** in `track_analyses` as of 2026-08-01. This is the pool `v5_direction_tracks` and `v6_direction_tracks_recent` select from. To refresh the count: `grep -Ec "\] ok [A-Za-z0-9]{22} " v4/precompute/state/batch.log`. **Do not trust exploration-agent estimates over this number** — an Explore agent once returned a bogus 31k and misled a planning session. Distribution across the 73 canonical genres is uneven; biz types added earlier (café, pizzeria) have deeper pools.

---

## SPOTIFY SETUP

### Two-app architecture (unchanged)

- **Michael's app** (`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`): Client Credentials reads of public-playlist tracks (grandfathered access to the deprecated `GET /playlists/{id}/tracks` endpoint).
- **Rubin's app** (`RUBIN_SPOTIFY_CLIENT_ID` / `RUBIN_SPOTIFY_CLIENT_SECRET`): user-context writes on the dedicated "Robin - Sonic Brands" account (id `316gotb2mutzdjmghprpgmxwq62i`).

### `RUBIN_REFRESH_TOKEN` scope

Currently seeded with `playlist-modify-private` only. **Cannot enumerate the account's playlists** — `GET /me/playlists` returns 403 "insufficient client scope".

If you need enumeration (e.g., cleaning up pre-ledger cruft), re-seed with wider scope:

```
https://accounts.spotify.com/authorize?client_id=431c55feb024444c979f2aa51e04426d&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fnew%2Frubin-oauth-callback&scope=playlist-modify-private%20playlist-read-private&show_dialog=true
```

Otherwise, `scripts/purge-rubin-playlists.mjs` uses the `created_playlists` ledger as the enumeration source instead — no scope needed.

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
- `ami-toggle-*.js`, `ami-track-*.js` — manage skip flags, tombstone bad tracks
- `ami-cron-tick.js` — **cron schedule REMOVED from `vercel.json` on 2026-08-13**. Endpoint file kept so the batch worker can be revived, but no longer runs hourly. Was the driver for the RapidAPI-based track analysis pipeline; when we stopped needing it, keeping the hourly tick just consumed function invocations and served no purpose. Re-add `{"path": "/api/v4/ami-cron-tick", "schedule": "* * * * *"}` to `vercel.json crons` to bring it back.
- `ami-sync-usage.js`, `ami-reorder.js` — housekeeping

Ami also has a separate **prompt-tuning dashboard** at `/v5/ami-prompt-dashboard/`
that imports `EDITABLE_PROMPT_SECTION` from `v5/generation/musical-directions.js`
and lets him edit + preview the prompt output before it goes to prod. That
dashboard uses the same `ai-provider.js` switch as v6, so whatever provider
production is on, Ami's testing is on the same one. He also has a "דגשים
מוזיקליים" textarea there that mirrors the onboarding field, so he can
test emphases + instrumentalness classification behavior end-to-end.

Because the atmospheres endpoint has no server cache, Ami's scan is
immediately visible to v6 onboarding sessions without waiting for cache
expiry.

---

## INTERNAL ADMIN API (Michael's dashboard)

Read-only endpoints under `api/internal/*` for Michael's forthcoming admin dashboard (his own repo, host TBD — not in this repo). Auth: single shared bearer token in `INTERNAL_ADMIN_API_KEY` env var, presented as `Authorization: Bearer <key>` or `x-internal-admin-key: <key>`. CORS is `*` because the bearer token IS the security boundary (no cookies, so cross-origin attacks can't attach it). Fail-CLOSED on missing env — misconfig 500s loudly, same philosophy as `requireSiteOrInternal`.

- `GET /api/internal/users` → `{ count, businesses: [ { business_id, name, owner_id, owner_email, created_at, has_prompt } ] }`. `has_prompt` is true iff `business_description` or `musical_emphases` is non-null (rows signed up after the 2026-08-23 migration).
- `GET /api/internal/business?id=<uuid>` → full detail: `{ business, onboarding: { business_description, musical_emphases, atmospheres }, place, hours, directions[], playlists[], direction_changes[], chat_transcript[] }`. `playlists[].track_ids` is the ordered Spotify-ID array as of build time (null for pre-2026-08-20 rows — see the business-directions migration). `direction_changes[]` and `chat_transcript[]` are the profile-tab direction-edit chat's audit + full message log (empty for owners who haven't used the chat yet — see the 2026-08-25-direction-chat migration).

Notes on the data shape:
- `onboarding.atmospheres` is read from `auth.users.raw_user_meta_data.sonic.onboarding.atmospheres`. That field only gets written on FIRST signup for a given email, so a user who did a second onboarding under the same email still shows the atmospheres from their first flow.
- `playlists[]` includes both live and expired rows (nothing deletes `business_playlists`; `expires_at` only gates dashboard visibility). Michael's dashboard should filter itself if it only wants live playlists.
- Michael's dashboard is expected to iterate: `GET /users` for the list, `GET /business?id=<row.business_id>` per user for detail. No server-side pagination — pilot scale.

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
| `UPSTASH_REDIS_REST_KV_REST_API_URL` / `_TOKEN` | `api/v6/ratelimit.js` | Auto-injected by Vercel's Upstash integration with the `UPSTASH_REDIS_REST` custom prefix. If unset, rate limiting is DISABLED (fail-open) and one warning line prints at cold start. |
| `GOOGLE_PLACES_API_KEY` | `api/v6/place-lookup.js` | Optional — endpoint silently skips if unset. Currently sensitive in Vercel + set to empty on some environments. |
| `CRON_SECRET` | `api/cron/expire-playlists.js`, `api/cron/generate-daily.js` auth check | Vercel Cron sets `Authorization: Bearer <secret>` header |
| `V6_ACCOUNT_REDIRECT_URL` | `api/v6/account/signup.js accountRedirectUrl` | Optional pin. When unset, magic-link redirect derives from request host (validated against `isAllowedHost`). |
| `TRACK_ANALYSIS_RAPIDAPI_KEY` | `v4/precompute/batch.mjs`, `api/v4/track-analysis.js` | RapidAPI plan quota tracked in `.rapidapi-call-count.json`. Batch worker is inactive (ami-cron-tick killed) but the endpoint stays available. |
| `RAPIDAPI_BILLING_CYCLE_DAY` | Precompute batch | Day of month billing resets |

**Not in `.env.local` — configured in external dashboards:**
- **Resend API key** — set in Supabase Dashboard → Auth → SMTP Settings.
  No app code reads it; Supabase uses it directly to send magic-link
  emails from `noreply@robin-music.com`. See "Auth email" mechanism.

---

## VERCEL DEPLOYMENT

**Tier:** Vercel Pro (paid). 1M function invocations/month, up to 900s function duration, commercial use allowed. Supabase is also on Pro ($25/mo) — 8GB DB, unlimited API requests, no auto-pause. Assume both when reasoning about limits.

**Prod deploys are MANUAL:** `vercel --prod`. Pushing to `main` does NOT auto-deploy.

`vercel.json` configures:
- Function `maxDuration` per endpoint (30s default; 60s for anthropic + gemini + transcribe + event-playlist + expand-playlist + generate-daily; 300s for the cron entrypoints)
- **Cron schedule (two crons, both hourly at :00)**:
  - `/api/cron/expire-playlists` — sweeps expired ledger rows (rename + empty + unfollow on Rubin)
  - `/api/cron/generate-daily` — per-business daily playlist builder (see the Daily-gen cron mechanism above for the full skip-reason list)
  - `/api/v4/ami-cron-tick` was **removed** from the cron schedule on 2026-08-13. Endpoint file still exists so it can be revived, but nothing schedules it now.
- Cache headers: `no-cache` for `/` + `/index.html` + all `/vX/*` paths
- Security headers (global): `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(self), camera=()` — added during the 2026-08-22 security audit
- Rewrites: `/` → `/v6/index.html` (added 2026-08-20, replaced the deleted legacy root index.html), plus per-version paths `/v6`, `/v6/account`, `/v5`, `/v5/ami-prompt-dashboard`, `/v4`, `/v4/ami`, etc.

### Cache busting

`v6/index.html` script tag uses `?v=DDMMYYYY{letter}` (e.g., `02082026a`). Bump when JS/CSS changes — and bump the matching `?v=` on every `import` inside `v6/app.js` too (they use the same query so browsers pick up the new module bytes).

`v6/account/index.html` similarly at `01082026b`.

---

## PROMPT EDITING PROTOCOL

Every time you edit `EDITABLE_PROMPT_SECTION` in `v6/generation/musical-directions.js` (and the mirrored `v5/generation/musical-directions.js`), append a NEW entry at the top of `prompt-history.md` at the repo root. Each entry contains: today's date, a one-sentence summary of what changed and why, and the FULL text of the new EDITABLE section as it lives in the code. Never delete old entries — the file is the audit log. Ami's dashboard reads the same section, so v6 and v5 must stay identical; check both after every edit.

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
