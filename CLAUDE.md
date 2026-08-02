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

**Live URL:** https://sonic-brand.vercel.app (v3 landing) — v6 lives at `/v6` after deploy.
**Repo:** https://github.com/michaelavs-1/sonic-brand
**Owner:** Michael Avshalom (avshalom.michael@gmail.com)
**Developer:** Roni Mark (roni.mark@gmail.com)

---

## V6 ARCHITECTURE

### Onboarding pipeline (`v6/`)

```
Splash (2.65s) → "Have a Rubin account?" login | signup gate → v6/app.js state machine
        ↓
STEP 1: Business input (v6/app.js runBusinessStep)
  - Name + free-text description
  - Voice dictation via /api/v6/transcribe (Whisper)
  - Background: /api/v5/databox-atmospheres fires as soon as this screen renders
  - Background: /api/v5/prewarm hits Supabase to warm plan cache
        ↓
STEP 2: Google Places confirmation (optional; silently skips if GOOGLE_PLACES_API_KEY absent)
        ↓
       Atmosphere selection (v6/atmosphere.js) — chips grid, atmosphere rows already loaded
        ↓
STEP 3: Musical directions + hours picker in parallel
  - Fires generateMusicalDirections (v6/generation/musical-directions.js → /api/v5/anthropic → claude-sonnet-4-6)
    - Two Claude calls in parallel: page 1 (top 4 directions) + page 2 (next 4)
  - As SOON as Claude page 1 lands, preparePreview (v6/preview.js) fires:
    - Fetches anchor tracks for page 1 (/api/v5/anchor-tracks)
    - Awaits Claude page 2 in parallel
    - Fetches anchor tracks for page 2
    - Fetches track metadata (Spotify get_track) for all previews
  - Meanwhile, hours picker (v6/hours-selector.js) is in the foreground
  - When user submits hours, everything above is usually already done → swipe deck renders instantly
        ↓
       Preview swipe deck (v6/preview.js runDirectionPreviewFlow)
  - Michael's Tinder-style swipe UI: album art + custom play button + swap track button
  - Spotify iframe hidden inside .sw2-artwrap with opacity:.01 (fully offscreen kills media)
  - Custom sw2-play button drives it via IFrame API
  - User swipes right = "build a playlist for this direction"
        ↓
STEP 4: Playlist build (v6/generation/playlist-builder.js buildDirectionPlaylists)
  - TARGET_TRACKS = 10 per playlist, one per picked direction, built in parallel
  - Each playlist:
    - POST /api/v5/direction-tracks → 10 track IDs
    - POST /api/new/spotify create_playlist + add_tracks (Rubin account)
    - POST /api/v5/record-playlist → 24h expiry ledger entry
  - Result carries expansion:{direction, popularityWindow} so the dashboard can grow it later
        ↓
       Results screen (v6/result.js showRubinCTA + showSignupCard)
  - Progressive placeholder cards → real cards as each playlist finishes
  - "אני רוצה את רובין לעסק שלי" CTA gates the signup form
  - Signup: email + password → /api/v6/account/signup
  - Signup payload: playlists, hours, longestMinutes, atmospheres, place, business_name
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
  - renderEvents: reads bmeta().events, per-row edit ✎ + delete 🗑 icons
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

### Special event playlists

- UI: `v6/account/app.js` renderEvents. Event = { id, name (first line), description }.
- Trigger: `/api/v6/account/event-playlist`:
  - Claude Haiku 4.5 receives event description + the 73-genre canonical menu (v6/generation/genre-list.js)
  - Returns `{ genres: [...menu-subset...], bpm_range: {min, max} }`
  - Queries `v5_direction_tracks` RPC with genres + BPM (no popularity screen)
  - Creates Spotify playlist (~40 tracks target, min 5 floor) via `/api/new/spotify`
  - Prepends to `bmeta().playlists` with `eventId` back-ref + registers 24h expiry
- Event card auto-updates: shows "▶ פתח" while a live playlist exists; shows "צרו פלייליסט" once expired.

### Auth signup — `api/v6/account/signup.js`

- Uses `SUPABASE_SERVICE_ROLE_KEY` admin API to create user + `businesses` row
- Writes onboarding context (hours, longestMinutes, atmospheres, place, playlists) to `auth.users.raw_user_meta_data.sonic.b[businessId]`
- Returns instant login link (magic-link admin API) so client can jump to `/v6/account` without email round-trip

---

## FILE STRUCTURE (V6-focused)

```
sonic-brand/
├── v6/                                     ← CURRENT ACTIVE UI
│   ├── index.html                          ← Onboarding shell + all v6 CSS (splash, swipe, hours, progress bars)
│   ├── app.js                              ← Onboarding orchestrator: state machine, clickable step nav
│   ├── atmosphere.js                       ← Atmosphere chips grid
│   ├── hours-selector.js                   ← Opening hours picker (shared + master days, "שעות שונות" override)
│   ├── preview.js                          ← Michael's swipe deck + preparePreview (background prefetch)
│   ├── result.js                           ← Progressive results shell + "אני רוצה את רובין" CTA + signup card
│   ├── generation/
│   │   ├── musical-directions.js           ← Claude Sonnet 4.6 (~2400-token system prompt, 2 parallel calls)
│   │   ├── genre-list.js                   ← Canonical 73-genre list (shared with event-playlist server)
│   │   ├── popularity-window.js            ← Derives [lo,hi] from selected atmospheres
│   │   └── playlist-builder.js             ← buildDirectionPlaylists (10 tracks each, parallel)
│   ├── account/
│   │   ├── index.html                      ← Dashboard shell (Home tab only — no profile/music/plan/chat/mic)
│   │   └── app.js                          ← Supabase Auth boot, renderPlaylists, renderEvents, expand streaming
│   ├── test-hours/                         ← Standalone test page for iterating on hours-selector UX
│   └── test-player/                        ← Standalone test page for iterating on the swipe-card playback UI
│                                              (progress bar, custom play button). Uses hardcoded tracks —
│                                              no track-meta fetch, so album art shows a placeholder.
├── v5/                                     ← Reference; standalone flow still runnable
├── v4/
│   ├── ami/                                ← Ami's dashboard (scan sheet → Supabase)
│   ├── precompute/                         ← Batch worker for track analysis (fills track_analyses)
│   └── ...                                 ← v4 UI (mostly superseded by v6)
├── v3/, v2/                                ← Historical
├── michael-v4-snapshot/                    ← Gitignored. Snapshot of Michael's v4 fork. UI reference for v6.
├── api/
│   ├── v6/
│   │   ├── origin-guard.js                 ← requireSite / requireSiteOrInternal helpers
│   │   ├── place-lookup.js                 ← Google Places (New) v1 textsearch
│   │   ├── transcribe.js                   ← Whisper (OpenAI)
│   │   └── account/
│   │       ├── _daily-builder.js           ← Shared build+persist module: buildDailyBatch, latestDirections
│   │       ├── signup.js                   ← Supabase admin user + business creation + user_metadata write
│   │       ├── event-playlist.js           ← Claude Haiku → direction-tracks → Spotify create+add + ledger
│   │       ├── expand-playlist.js          ← Streaming ndjson: grow onboarding playlists to per-day target
│   │       └── generate-daily.js           ← Closed-day "המקום פתוח?" flow (delegates to _daily-builder)
│   ├── v5/
│   │   ├── anthropic.js                    ← Anthropic Messages API proxy (uses ANTHROPIC_KEY)
│   │   ├── anchor-tracks.js                ← Per-direction random preview track (BPM+popularity filter)
│   │   ├── direction-tracks.js             ← Bulk fetch tracks matching genres + BPM + popularity
│   │   ├── databox-atmospheres.js          ← Reads Supabase atmospheres table (NO CACHE — see optimization notes)
│   │   ├── prewarm.js                      ← Fire-and-forget Postgres plan warmer
│   │   ├── record-playlist.js              ← Writes 24h expiry ledger row (created_playlists)
│   │   └── supabase-client.js              ← pgrRpc/pgrSelect/pgrUpsert/pgrPatch wrappers; RETRIES ON 57014
│   ├── v4/
│   │   ├── ami-*.js                        ← Ami dashboard endpoints (scan, cron-tick, toggle, delete, etc.)
│   │   ├── ami-atmospheres-scan.js         ← Diffs sheet against Supabase, upserts changes
│   │   └── ...                             ← Legacy v4 endpoints (openai, spotify, biztype-match, cached-*)
│   ├── new/
│   │   ├── spotify.js                      ← Two-app Spotify proxy (Michael CC reads + Rubin user writes)
│   │   ├── openai.js                       ← GPT proxy (legacy)
│   │   └── rubin-oauth-callback.js         ← One-time OAuth seed for RUBIN_REFRESH_TOKEN
│   ├── cron/
│   │   ├── expire-playlists.js             ← Hourly cron. Renames + empties + unfollows expired playlists.
│   │   │                                      Tolerates 404 (isGone helper) so purged playlists don't loop.
│   │   └── generate-daily.js               ← Hourly cron. For each business, 2h before that day's opening,
│   │                                          builds one daily playlist per direction (Israel-local time).
│   ├── openai.js, spotify.js, databox.js   ← Root-level legacy proxies (v1/v2/v3-era)
├── scripts/
│   ├── benchmark-directions.mjs            ← OpenAI vs Anthropic timing/quality benchmark
│   ├── purge-rubin-playlists.mjs           ← Unfollow all Rubin playlists (source: created_playlists ledger)
│   ├── mirror-vercel-deployment.mjs        ← Pull deployment source via Vercel API
│   ├── mirror-live-site.mjs                ← Pull deployed static assets via HTTP
│   └── feedback-*                          ← Legacy feedback system helpers
├── benchmark-results/                      ← JSON outputs from benchmark script
├── tests/                                  ← Legacy test scripts (mostly v3/v4 era)
├── .env.local                              ← Gitignored. Has ANTHROPIC_KEY, RUBIN_*, SUPABASE_*, TRACK_ANALYSIS_*, CRON_SECRET
├── vercel.json                             ← Function timeouts, cron schedule (hourly), rewrites
└── CLAUDE.md                               ← This file
```

---

## KEY MECHANISMS (V6)

### The state machine — `v6/app.js goToStep(n)`

- One `state` object holds `bizName`, `bizDesc`, `confirmedPlace`, `atmosphereRows`, `selectedAtmos`, `hours`, `longestMinutes`, `directions`, `page2Promise`, `popularityWindow`, `picked`, `results`.
- Progress bar steps at top of screen ("מספרים על העסק / בוחרים אווירה / מסמנים שירים / מקבלים פלייליסט") are **clickable** for any step the user has reached — clicking navigates back with pre-filled state. Downstream state is invalidated when going back so re-submitting refreshes it.
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

- Model: `claude-sonnet-4-6` (was `gpt-5.4` in older pipelines)
- ~2400-token system prompt split into EDITABLE_PROMPT_SECTION + FIXED_PROMPT_SECTION
- Ephemeral cache via `cache_control` in the system message — first call writes to Anthropic's cache, subsequent calls read
- Two parallel calls: `subset:'top'` for ranks 1-4, `subset:'next'` for ranks 5-8 (fed the top-4 output to avoid duplication)
- Returns `{directions, page2Promise}` — caller renders page 1 first, awaits page 2 later

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

Runs hourly. For each business:
1. Skip if `!hours`, `!onboardingExpanded`, or today's day is closed.
2. Skip if any playlist with today's IL `createdAt` is already live.
3. Skip if `now < today's open - 2h` (in Asia/Jerusalem).
4. Extract latest direction batch via `latestDirections()`; skip if empty.
5. Build via shared `buildDailyBatch()` in `_daily-builder.js` — one Spotify
   playlist per direction, single user_metadata write at the end.
6. Ledger row's `expires_at` is `dailyPlaylistExpiryIso({ hours })`.
7. Opportunistic prune: DELETE `v6_daily_track_history` rows > 14 days old.

Auth: `Authorization: Bearer ${CRON_SECRET}` (same as `expire-playlists`).

### Cross-day track dedup (`v6_daily_track_history`)

To prevent the same tracks appearing in a business's daily playlists day
after day, every serve is recorded in `v6_daily_track_history (business_id,
direction_key, spotify_id, served_at)`. Direction key is
`${anchor_genre}|${bpm_min}-${bpm_max}` — see `directionKey()` in
[v6/generation/playlist-length.js]. On the next build for that (biz, dir),
`v6_direction_tracks_recent` RPC excludes tracks served within the last 7
days. Pool-shortage fallback: if the filtered pool comes back short, caller
retries with `p_exclude_days=0` and merges — playlists always hit target.

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
            "direction": { "title_en", "description_he", "anchor_genre",
                           "secondary_genres", "bpm_range" },
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

- `atmospheres` — { name, ranges, row_in_sheet }. Populated by Ami's scan endpoint.
- `biztype_genres` — { business_type, genre, column_letter, position_in_column }. Ami's other scan.
- `playlist_genres` — playlist_id ↔ genre + position_in_genre.
- `playlist_tracks` — playlist_id ↔ spotify_id + position.
- `track_analyses` — spotify_id + typed audio-feature columns (tempo, popularity, energy, etc.) + raw_analysis jsonb.
- `created_playlists` — the expiry ledger. Columns: `spotify_id` (PK), `name`, `expires_at`, `deleted_at`, `error`, `owner_id` (nullable FK → auth.users), `business_id` (nullable FK → businesses). Both FKs use ON DELETE SET NULL so the cron can still unfollow expired playlists after their owner/business is deleted. Rows written by onboarding (via /api/v5/record-playlist) start with NULL owner/business — signup.js back-fills them. Renamed from `v5_created_playlists` on 2026-08-02; migration in `v5/precompute/migrations/`.
- `businesses` — { id, owner_id, name, monthly_credits, credits_remaining }. Written by signup.
- Historical: `analyses`, `track_feedback`, `app_settings` (old OpenAI key storage), `spotify_tokens` (v1 era).

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

## OPENAI vs ANTHROPIC (V6)

### Current choices

| Feature | Model | Rationale |
|---|---|---|
| Musical directions (main flow) | `claude-sonnet-4-6` | Best output quality; Hebrew descriptions tightest |
| Event playlist genre+BPM | `claude-haiku-4-5-20251001` | Fast classify+extract; ~2s vs Sonnet's ~11s |
| Voice transcription | Whisper (OpenAI) | No good Anthropic ASR yet; user chose to keep for now |

### Benchmark results (this session)

`scripts/benchmark-directions.mjs` compared providers on the musical-directions prompt with input "בר יין שכונתי בלב תל אביב" + atmospheres [אלגנטי, קליל]. See `benchmark-results/summary.json`.

Headline:
- `gpt-4o`: ~3.3s (fastest; no reasoning phase)
- `claude-sonnet-4-6` warm: ~11s (steady)
- `gpt-5-mini`: ~25s (reasoning-heavy)
- `gpt-5`: ~53s (reasoning-heavy — not viable for user-facing flow)

Sonnet's output quality edges gpt-4o slightly on Hebrew description tightness. Kept Anthropic for now; benchmark script + JSONs preserved for future re-evaluation.

---

## AMI'S DASHBOARD

Ami has a dashboard at `v4/ami/` for maintaining the Data Box / atmospheres tables. Endpoints under `api/v4/ami-*`:

- `ami-scan.js` — sheet → Supabase upsert for biz-type genres
- `ami-atmospheres-scan.js` — sheet → Supabase upsert for atmospheres (writes `atmospheres.name`, `ranges`, `row_in_sheet`)
- `ami-status.js`, `ami-logs.js` — poll scan progress
- `ami-toggle-*.js`, `ami-track-*.js` — manage skip flags, tombstone bad tracks
- `ami-cron-tick.js` — hourly Vercel cron (separate from expire-playlists) that reconciles state
- `ami-sync-usage.js`, `ami-reorder.js` — housekeeping

Because the atmospheres endpoint has no server cache, Ami's scan is immediately visible to v6 onboarding sessions without waiting for cache expiry.

---

## ENVIRONMENT VARIABLES

All set in Vercel cloud env. `.env.local` also has them for local dev (`vercel dev` reads from cloud, but scripts and one-off tools use `.env.local`).

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_KEY` | `api/v5/anthropic.js`, `api/v6/account/event-playlist.js` | Sonnet 4.6 + Haiku 4.5 |
| `OPENAI_API_KEY` | `api/v6/transcribe.js`, legacy proxies | Also stored in Supabase `app_settings.value` where key='openai_key' (legacy fallback) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Michael's app for CC reads | Hardcoded copy of client_id in v3/app.js for legacy OAuth |
| `RUBIN_SPOTIFY_CLIENT_ID` / `RUBIN_SPOTIFY_CLIENT_SECRET` | Rubin's app for user-context writes | client_id: `431c55feb024444c979f2aa51e04426d` |
| `RUBIN_REFRESH_TOKEN` | `api/new/spotify.js` refreshUserToken | Scope: `playlist-modify-private` only. Re-seed for wider scopes. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | All v5/v6 endpoints via api/v5/supabase-client.js | Anon safe to expose client-side; service role server-only |
| `INTERNAL_API_KEY` | `api/v6/origin-guard.js requireSiteOrInternal`; passed as `x-sonic-internal` header for server-to-server calls into `api/new/spotify.js` | Fail-open if not set (audit surface for later) |
| `GOOGLE_PLACES_API_KEY` | `api/v6/place-lookup.js` | Optional — endpoint silently skips if unset. Currently sensitive in Vercel + set to empty on some environments. |
| `CRON_SECRET` | `api/cron/expire-playlists.js` auth check | Vercel Cron sets `Authorization: Bearer <secret>` header |
| `TRACK_ANALYSIS_RAPIDAPI_KEY` | `v4/precompute/batch.mjs`, `api/v4/track-analysis.js` | RapidAPI plan quota tracked in `.rapidapi-call-count.json` |
| `RAPIDAPI_BILLING_CYCLE_DAY` | Precompute batch | Day of month billing resets |

---

## VERCEL DEPLOYMENT

**Prod deploys are MANUAL:** `vercel --prod`. Pushing to `main` does NOT auto-deploy.

`vercel.json` configures:
- Function `maxDuration` per endpoint (30s default, up to 60s for Anthropic + event-playlist + expand-playlist)
- Cron schedule: `/api/cron/expire-playlists` runs hourly
- Cache headers: `no-cache` for all `/vX/*` paths
- Rewrites: `/v6` → `/v6/index.html`, `/v6/account` → `/v6/account/index.html`, `/v6/test-hours` → `/v6/test-hours/index.html`

### Cache busting

`v6/index.html` script tag uses `?v=DDMMYYYY{letter}` (e.g., `02082026a`). Bump when JS/CSS changes — and bump the matching `?v=` on every `import` inside `v6/app.js` too (they use the same query so browsers pick up the new module bytes).

`v6/account/index.html` similarly at `01082026b`.

---

## COMMON TASKS

### Run v6 locally
1. `vercel dev` (reads cloud env)
2. Open `http://127.0.0.1:3000/v6`

### Test hours-selector in isolation
- `http://127.0.0.1:3000/v6/test-hours`

### Test swipe-card playback UI in isolation
- `http://127.0.0.1:3000/v6/test-player`
- Rotates through 4 well-known tracks with a swap button. `?uri=spotify:track:XXXX` overrides the first track.
- Uses hardcoded track names/artists — album art shows a placeholder, since we don't wire the `/api/v4/spotify` `get_track` fetch here. If art is essential to a change, port the swipe deck's `fetchTrackMeta` call.

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
