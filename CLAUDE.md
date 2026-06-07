# Robin / Rubin · SonicBrands — AI Context Document
> Optimized for Claude and other AI coding assistants.
> Read this entire file before touching any code.

## ⚠️ READ FIRST — MIGRATION + DEPRECATIONS STATUS

**Mid-migration.** The project is being rewritten from a single legacy pipeline to a new one. Both coexist in the codebase right now, gated by `USE_NEW_GEN` in `v3/app.js`. Sections below are labeled **OLD** (legacy, partially broken — see deprecations) or **NEW** (active development). Don't conflate them.

**Brand rename in progress.** Old name "Robin" still appears throughout existing code, comments, file names, and even some constants. New name is "Rubin". Existing references will be renamed in a future pass; new code should use "Rubin".

**Spotify API deprecations** (late 2024 / early 2025) affect this project significantly:

| Old endpoint / feature | Status | Replacement |
|---|---|---|
| `POST /v1/users/{id}/playlists` | **REMOVED** | `POST /v1/me/playlists` |
| `POST /v1/playlists/{id}/tracks` | **REMOVED** | `POST /v1/playlists/{id}/items` |
| `DELETE /v1/playlists/{id}/tracks` | **REMOVED** | `DELETE /v1/playlists/{id}/items` — body format also changed from `{tracks:[{uri}]}` to `{uris:[…]}` |
| Audio Features | **DEAD for all apps**, including Michael's grandfathered one | External API (TBD) |
| Audio Analysis | DEAD for all apps | External API |
| Recommendations | DEAD for all apps | (none) |
| Related Artists | DEAD for all apps | (none) |
| 30-second `preview_url` | Removed for newer apps | (none) |

The **one thing** Michael's app retains grandfathered access to: `GET /v1/playlists/{id}/tracks` (reading public playlist contents). This is why the NEW pipeline uses Michael's app credentials specifically for Client Credentials reads.

The legacy `api/spotify.js` proxy's `create_playlist` and `add_tracks` actions still call the removed endpoints, so the OLD pipeline's "Save to Spotify" is silently broken. Not maintaining it (user direction).

---

## WHAT IS THIS

AI-powered Spotify playlist builder for physical businesses (cafés, bars, restaurants, stores). A business owner describes their venue → the app generates two playlists, one calm (🌙 רגוע) and one energetic (🔥 מקפיץ / אנרגטי), sourced exclusively from curated Spotify playlists in a "Data Box" Google Sheet.

**Live URL:** https://sonic-brand.vercel.app/v3
**Repo:** https://github.com/michaelavs-1/sonic-brand
**Owner:** Michael Avshalom (avshalom.michael@gmail.com)

---

## ARCHITECTURE

### NEW pipeline (active development)

```
User describes business (free-text + optional business name)
        ↓
matchBusinessType(input, rows)                          [v3/generation/new/matcher.js]
  Pass 1 — GPT (gpt-5.4): semantic match against business-type names
           + keywords across all live Data Box rows.
  Pass 2 — only if Pass 1 returns null: GPT atmosphere fallback,
           matching by vibe ("youthful", "intimate", etc.) against
           the column-D atmospheres list of each business type.
  → { matched, bizType, rows, reasoning, [fallback: 'atmosphere'] }
        ↓
assignEnergyRows(rows)                                  [v3/generation/new/row-energy-assignment.js]
  Picks which row's playlists feed calm vs energetic:
  - 2-row biz: row.energy="1" → calm, "2" → energetic
  - 1-row biz with energy="1+2" or empty: same row for both
  → { calm, energetic, isCalmAndEnergeticFromSameRow }
        ↓
buildPlaylists(assignment, bizType, bizName?)           [v3/generation/new/playlist-builder.js]
  If isCalmAndEnergeticFromSameRow=true → returns { skipped: true } (audio-features-based
  energy split not implemented yet — deferred until external API in place).
  Otherwise:
    - For each row, randomly pick ≤5 of its source playlists.
    - For each picked playlist, GET /tracks with random offset (0–100), limit 50.
    - Pool + dedupe + Fisher-Yates shuffle, take 30 unique IDs.
    - Create a PRIVATE + COLLABORATIVE playlist on Rubin's Spotify account.
    - Add the 30 tracks.
  → { skipped: false, calm: {url, id, trackCount}, energetic: {…} }
```

Output: two Spotify playlist URLs ready to share. The end user opens the link in whichever browser session they're logged into Spotify with — no app-side OAuth is required for them in the new pipeline.

### OLD pipeline (legacy, partially broken — kept until cutover)

```
User describes business
        ↓
SB_matchDataBox()  ← static keyword scoring, in v3/data-box.js
        ↓
buildTrackPool(entry, energyLevel)  ← uses audio-features API (DEAD endpoint)
        ↓
selectFromPool(pool, faders, moods, energyLevel)  ← GPT picks by index
        ↓
generateTracklist for energy 1, then energy 2 (sequential)
        ↓
Save to Spotify  ← uses POST /v1/users/{id}/playlists (DEAD endpoint)
```

The OLD pipeline still runs when `USE_NEW_GEN=false` in `v3/app.js`. Its BPM filter is broken (audio-features dead). Its save-to-Spotify is broken (endpoint removed). It's there because the migration isn't complete and the new UI hasn't been built yet.

---

## FILE STRUCTURE

```
sonic-brand/
├── v3/
│   ├── index.html              ← UI: 5 screens. Loads 6 scripts at bottom (cache-busted with ?v=…)
│   ├── app.js                  ← Legacy app shell + screen flow + OAuth + GEN()/USE_NEW_GEN flag
│   ├── data-box.js             ← OLD: Static Data Box (keyword scoring + entries)
│   ├── data-box-energy.js      ← OLD: Energy separation map for ~14 business types
│   ├── mc-mappings.js          ← OLD: MC questions (familiarity, Hebrew/foreign) + fader conversion
│   └── generation/             ← OLD pipeline (modular split of what used to live in app.js)
│       ├── index.js            ← Exposes window.SB_GEN with old-pipeline functions
│       ├── pipeline.js, tracklist.js, pool.js, selector.js, fallback.js, diversity.js
│       ├── api.js, utils.js
│       ├── brain/              ← OLD: L0–L4 context layers (largely dead even in old pipeline)
│       │   └── index.js, l0.js, l1.js, l2.js, l3.js, l4.js, audio.js
│       └── new/                ← NEW pipeline (the rewrite)
│           ├── index.js                  ← Exposes window.SB_GEN_NEW.{matcher,rowEnergyAssignment,playlistBuilder}
│           ├── matcher.js                ← matchBusinessType: GPT semantic + atmosphere fallback
│           ├── row-energy-assignment.js  ← assignEnergyRows
│           └── playlist-builder.js       ← buildPlaylists + Rubin playlist creation
├── api/
│   ├── spotify.js              ← OLD Spotify proxy. Internally uses removed endpoints — broken
│   ├── openai.js               ← OLD OpenAI proxy. Reads key from Supabase app_settings
│   ├── databox.js              ← OLD: Pre-grouped Data Box JSON. Skips rows w/o energy level
│   └── new/                    ← NEW proxies (lean, self-contained)
│       ├── databox.js                    ← Returns raw rows 8–100, no grouping, no skipping
│       ├── openai.js                     ← Reads OPENAI_API_KEY from env (no Supabase)
│       ├── spotify.js                    ← get_playlist_tracks (Michael CC) + create_playlist & add_tracks (Rubin user)
│       └── rubin-oauth-callback.js       ← One-time-use endpoint for seeding RUBIN_REFRESH_TOKEN
├── tests/                      ← All test scripts live here (run as `node tests/.test-*.mjs`)
│   ├── .test-databox.mjs           ← Matcher + energy assignment (no Spotify side effects)
│   ├── .test-playlist-builder.mjs  ← Playlist builder with hardcoded rows (no matcher)
│   ├── .test-full-pipeline.mjs     ← End-to-end (matcher → assignEnergyRows → buildPlaylists)
│   ├── .test-gpt-fallback.mjs      ← GPT fallback flow (unit + live cases)
│   ├── .test-new-pipeline.mjs      ← Single end-to-end run; inputs from .test-new-pipeline.json
│   ├── .test-new-pipeline.json     ← Input config consumed by .test-new-pipeline.mjs
│   ├── .test-playlist-analysis.mjs ← Pulls a playlist + runs every track through track-analysis
│   └── .test-track-analysis-diagnose.mjs ← Diagnostic for the track-analysis RapidAPI proxy
├── .env.example                ← Documents required env vars
├── vercel.json                 ← Routing, headers, function timeouts
└── CLAUDE.md                   ← This file
```

---

## KEY CONSTANTS

In `v3/app.js`:
```javascript
const SUPABASE_URL      = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON     = 'eyJhbGci…';      // anon key, safe to keep in client
const SPOTIFY_CLIENT_ID = 'b6404b5ae1684143b79d9a86bb4b6cba';  // Michael's app
const SPOTIFY_SCOPES    = 'playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative user-read-private user-read-email';
const SPOTIFY_REDIRECT  = location.origin + location.pathname;

const USE_NEW_GEN = false;                  // Feature flag: route generation through new pipeline
const GEN = () => USE_NEW_GEN ? window.SB_GEN_NEW : window.SB_GEN;
```

Rubin app's client_id (used by `api/new/spotify.js` and the OAuth callback): `431c55feb024444c979f2aa51e04426d`.

---

## SPOTIFY SETUP

### Two-app architecture (NEW pipeline)

- **Michael's app** (`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`): used for **Client Credentials** reads of public-playlist tracks. The grandfathered access path. Doesn't represent any user.
- **Rubin's app** (`RUBIN_SPOTIFY_CLIENT_ID` / `RUBIN_SPOTIFY_CLIENT_SECRET`): used for **user-context** writes (`create_playlist`, `add_tracks`). Acts as a dedicated **Rubin Spotify user account** via the long-lived `RUBIN_REFRESH_TOKEN`. Playlists are created on that account.

Why split: Michael's app is grandfathered into the public playlist `/tracks` endpoint that newer apps no longer have. We can't move reads to Rubin's app or they'd break. But Rubin's app is what owns the dedicated Spotify user account where playlists land. So both apps have a distinct job.

### Seeding `RUBIN_REFRESH_TOKEN`

One-time setup:

1. In the Rubin app's Spotify Developer Dashboard, register redirect URI `http://127.0.0.1:3000/api/new/rubin-oauth-callback`.
2. Start `vercel dev`.
3. In a browser signed into Spotify as the **Rubin user**, visit:
   ```
   https://accounts.spotify.com/authorize?client_id=431c55feb024444c979f2aa51e04426d&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fnew%2Frubin-oauth-callback&scope=playlist-modify-private&show_dialog=true
   ```
4. Approve consent. The callback page displays `access_token` (1 hour) and `refresh_token` (long-lived).
5. Copy the refresh_token. Add it as `RUBIN_REFRESH_TOKEN` to the Vercel cloud project's Environment Variables. Restart `vercel dev` so it pulls the new value.

Important: this project is linked to a Vercel cloud project, so `vercel dev` reads env vars from cloud, not from `.env.local`. Local additions to `.env.local` are ignored at function runtime. Always add env vars via the Vercel dashboard or `vercel env add`.

For wider scopes later (e.g., reading Rubin's private playlists for the delete flow), include them in the auth URL's `scope=` param space-separated (URL-encoded as `%20`).

### Legacy OAuth (OLD pipeline)

`v3/index.html` screen 2 still runs an end-user OAuth via Michael's app. In the NEW pipeline this is purely cosmetic — it makes sure the end user is signed into Spotify in their browser session so the returned playlist URLs open cleanly. Tokens land in `localStorage` (`sp3_access`, `sp3_refresh`, etc.) and are NOT used by `api/new/spotify.js`.

`handleSpotifyCallback` in `v3/app.js` does the code-exchange. It does NOT persist tokens to Supabase (a previous experiment added that, then reverted). The legacy `spotify_tokens` Supabase table still gets written by the root `/index.html`'s `saveUserSpotifyTokens` function for the legacy v1 app — not by `/v3`.

### Spotify Development Mode

Rubin's app is in Development Mode → max 25 users allowed via OAuth. Add users at:
`developer.spotify.com/dashboard → <Rubin app> → User Management`

Currently allowlisted (Rubin app): Michael Avshalom, Ami Nir, **Rubin (the dedicated user account)**.

Note: during the audit we observed that the Rubin OAuth succeeded even before adding Rubin to the allowlist — Spotify's Dev Mode allowlist enforcement may be inconsistent or applies differently than docs imply. For production, apply for Extended Quota Mode.

### iOS scope-caching known issue

iOS Spotify app intercepts OAuth and returns cached old scopes, even with `show_dialog=true`. Fix shown to user:
`Spotify → Settings → Privacy → Apps → <app> → Remove Access → Reconnect`

---

## NEW PIPELINE — CORE FUNCTIONS

All in `v3/generation/new/`, exposed via `window.SB_GEN_NEW.*` from `index.js`.

### `matchBusinessType(userInput, rows)` — matcher.js
Two-pass GPT classification. Pass 1 matches against business-type names + column-B keywords. If null, Pass 2 falls back to atmosphere (column D) matching. Both passes use gpt-5.4 via `/api/new/openai` with `response_format: json_object` and tight system prompts that explicitly tell the model when to return null. Returns the canonical `bizType` plus all rows for that type — downstream decides energy mapping.

### `assignEnergyRows(rows)` — row-energy-assignment.js
Tiny pure function. Picks `row.energy === '1'` for calm, `'2'` for energetic. Falls back to `'1+2'` row if a specific energy isn't present, else first usable row. Output includes `isCalmAndEnergeticFromSameRow` so the next stage knows whether to do two-row or one-row handling.

### `buildPlaylists(assignment, bizType, bizName?)` — playlist-builder.js
For 1-row biz types where the same row covers both energies (`isCalmAndEnergeticFromSameRow=true`), returns `{ skipped: true, reason: '…' }` because we'd need audio-features to split the single track pool by energy. For 2-row cases, the function:
- For each row, randomly picks ≤5 source playlists, GETs ~50 tracks per playlist at a random offset.
- Pools, dedupes, shuffles, takes 30 unique tracks per output playlist.
- Creates a **private + collaborative** playlist on the Rubin Spotify user account.
- Adds the 30 tracks.
- Returns `{ calm: {url, id, trackCount}, energetic: {…} }`.

Playlist name format: `{bizName || bizType} · רגוע · DD.MM.YYYY` (and `אנרגטי` for energetic). The third parameter `bizName` is optional — when provided, it replaces `bizType` in the title. Description is just the display name.

`buildPlaylists` accepts an internal escape-hatch: passing `_user_access_token` in any `/api/new/spotify` call's body lets you override the refresh-token flow with a directly-supplied Spotify access token (used by `tests/.test-playlist-builder.mjs` via CLI arg).

---

## OLD PIPELINE — CORE FUNCTIONS (legacy)

Documented here for reference. **(Legacy, partially broken.)**

- `startGeneration()` — entry point in `v3/app.js`; sequentially generates playlist1 (energy 1) then playlist2 (energy 2), with cross-playlist dedup.
- `generateTracklist(energyLevel, attempt, excludeIds)` — per-playlist; matches Data Box, builds pool, selects via GPT, falls back to GPT-invents-then-validates if pool too small.
- `buildTrackPool(entry, energyLevel)` — was supposed to filter by BPM/energy via audio-features (dead). Currently it'd just return the unfiltered pool.
- `selectFromPool(pool, faders, moods, energyLevel)` — stratifies popular/mid/niche 35/45/20, sends ≤200 tracks to GPT with numeric indices, maps response back.
- "Brain" L0–L4 in `v3/generation/brain/` — historical cohort, genre archive, feedback reranker. Earlier audit showed these only run in the fallback branch, which rarely fires. Effectively dead even when the OLD pipeline runs.

---

## DATA BOX SYSTEM

### Google Sheet
URL: `https://docs.google.com/spreadsheets/d/1b-0rsKBvTSqE0ju7EfGRnpOQiVESZR8hsJBsuITns_E`

Columns: `Type Of business | Key Words | Energy level | Atmospheres | Known/Unknown | Hebrew/Foreign | Style/Genres | Example 1 … Example 15 | Purpose`

Row layout varies by business type:
- Most common: two consecutive rows for the same biz type, `Energy level=1` (calm) and `=2` (energetic).
- Some rows have `Energy level=1+2` (single row covers both).
- Some have no energy level (single row, treated as 1+2 by the new pipeline).

### NEW pipeline data flow
`api/new/databox.js` returns rows 8–100 raw, no grouping, no row-dropping. Atmospheres parsed as array. Playlists pre-extracted to `{url, id}` objects. Cached in-memory for 30 min per warm Vercel function instance.

The matcher groups rows by exact column-A value, so multi-row business types are aggregated automatically.

### Adding a new business type (NEW pipeline)
Add 1 or 2 rows to the Google Sheet. That's it. The new pipeline reads them live within 30 minutes (or instantly on a cold function start). No static files to update.

### OLD pipeline (legacy, optional to maintain)
The old workflow also required editing `data-box.js` (keyword scoring entry) and `data-box-energy.js` (energy split map). Not needed for the new pipeline.

---

## OPENAI INTEGRATION

### Default model
`gpt-5.4` — used by both pipelines. The proxy(s) auto-translate to `max_completion_tokens` and omit `temperature` for gpt-5.x.

### NEW pipeline OpenAI usage
`/api/new/openai.js` reads `process.env.OPENAI_API_KEY`. No Supabase fallback (intentionally lean).

**Important env-var caveat**: `OPENAI_API_KEY` is currently NOT in `.env.local`. It lives in Vercel cloud env vars (project settings). `vercel dev` pulls cloud env at startup and exposes it to function processes, so the matcher works locally via `vercel dev` despite the key not being in any local file. If you ever need the key in `.env.local` (e.g., for non-Vercel tooling), pull it explicitly via `vercel env pull`.

The matcher makes two GPT calls max per match (Pass 1 always; Pass 2 only if Pass 1 returns null). `response_format: { type: 'json_object' }` is required to keep responses parseable. The prompts explicitly tell GPT when to return null rather than force-match — see `matcher.js` for the wording.

### OLD pipeline OpenAI usage
`/api/openai.js` reads key from Supabase `app_settings` table (`key='openai_api_key'`), falling back to `process.env.OPENAI_API_KEY` (which, again, isn't in `.env.local`). The old `selectFromPool` makes one big GPT call per playlist with up to 200 numbered tracks; GPT returns indices.

### Brain context L0–L4 (legacy, mostly dead)
Was supposed to add Data Box DNA, reference playlist DNA, historical cohort, genre archive, and feedback reranker to the GPT prompt. Earlier audit showed it only runs inside the OLD pipeline's fallback branch, which rarely fires. NEW pipeline doesn't use any of this.

---

## TEST SCRIPTS

All under `tests/`, designed to run from the repo root via `node tests/.test-*.mjs` against `vercel dev` on `localhost:3000`. New tests should also go in `tests/`.

| Script | Tests | Notes |
|---|---|---|
| `tests/.test-databox.mjs` | Matcher + energy assignment, no Spotify side effects | Has 11 input strings exercising direct matches, atmosphere fallbacks, no-match honesty, robustness (empty, English, etc.) |
| `tests/.test-playlist-builder.mjs` | Playlist builder only, with hardcoded row data | Optional CLI arg = Spotify access token (overrides Rubin refresh flow). Without arg, uses proxy default |
| `tests/.test-full-pipeline.mjs` | End-to-end: matcher → assignEnergyRows → buildPlaylists | Creates real (private+collaborative) playlists on Rubin's account |
| `tests/.test-gpt-fallback.mjs` | GPT fallback flow | `--unit` (no API calls), `--smoke` (one cheap live case), or default (full live run) |
| `tests/.test-new-pipeline.mjs` | Single end-to-end run with bizName + description from `tests/.test-new-pipeline.json` | Walks every stage incl. fallback branch |
| `tests/.test-playlist-analysis.mjs` | Pulls every track from a playlist and runs each through track-analysis | `--playlist=<id_or_url>` and `--out=<path>` overrides |
| `tests/.test-track-analysis-diagnose.mjs` | Diagnostic for track-analysis: direct RapidAPI + via our proxy | Pass key as CLI arg or via `TRACK_ANALYSIS_RAPIDAPI_KEY` |

Tests use a fetch-shim that rewrites relative `/api/new/*` URLs to `http://localhost:3000/api/new/*` so `playlist-builder.js`'s `fetch('/api/new/spotify')` (which assumes browser-relative) works in Node.

---

## SUPABASE SCHEMA

```sql
-- analyses: every OLD-pipeline generation is logged
analyses (id, user_name, description, biz_category, brain_version, faders, genres, refs,
          energy_curve, track_count, tracks, business_name, brain_logs, created_at)

-- track_feedback: thumbs up/down on tracks (OLD pipeline)
track_feedback (id, user_id, track_id, track_key, feedback, biz_category, created_at)

-- app_settings: OLD pipeline OpenAI key storage
app_settings (id, key, value, updated_at)  -- row: key='openai_api_key'

-- spotify_tokens: OLD pipeline user-token storage (NEW pipeline doesn't read this table)
spotify_tokens (id, access_token, refresh_token, expiry, updated_at)
```

NEW pipeline doesn't touch any of these. Future plan: persist Rubin's rotated refresh tokens here so cold starts pick up the latest value automatically (currently logs to console on rotation; manual env-var update needed).

---

## ENVIRONMENT VARIABLES

All set in Vercel cloud env (project settings → Environment Variables). `.env.local` is ignored for runtime by `vercel dev` when the project is cloud-linked.

| Variable | Used by | Notes |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | OLD + NEW (Michael's app for CC reads) | Hardcoded copy in `v3/app.js` for OAuth |
| `SPOTIFY_CLIENT_SECRET` | OLD + NEW (Michael's app for CC reads) | Server-side only |
| `RUBIN_SPOTIFY_CLIENT_ID` | NEW (`api/new/spotify.js`, `api/new/rubin-oauth-callback.js`) | Value: `431c55feb024444c979f2aa51e04426d` |
| `RUBIN_SPOTIFY_CLIENT_SECRET` | NEW (same files) | Used to refresh Rubin user tokens |
| `RUBIN_REFRESH_TOKEN` | NEW (`api/new/spotify.js`) | Seeded once via `/api/new/rubin-oauth-callback` |
| `OPENAI_API_KEY` | NEW (`api/new/openai.js`) | OLD pipeline reads from Supabase `app_settings` instead |
| `VERCEL_OIDC_TOKEN` | Auto-injected by Vercel CLI | Don't set manually |

Supabase URL and anon key are hardcoded (not env vars) in `v3/app.js`, legacy `api/spotify.js`, and `api/openai.js`. New `api/new/spotify.js` doesn't read Supabase. The anon key is safe to expose client-side.

---

## VERCEL DEPLOYMENT

`vercel.json` configures:
- Rewrites: `/v3` → `/v3/index.html`, `/v2` → `/v2/index.html`
- Cache headers: `no-cache, no-store, must-revalidate` for `/`, `/index.html`, `/v2/*`, `/v3/*`
- Function timeouts: `api/openai.js` 60s, `api/spotify.js` 30s

Auto-deploys on push to `main`. Vercel CLI is configured (the `.vercel/` directory contains the linked project metadata; project id `prj_l3ReTLDpDcHWvUpamXxYN39BEhp8`).

### Cache busting
`v3/index.html` loads **6 script tags**, each with a `?v=…` query string:
```html
<script src="/v3/mc-mappings.js?v=…"></script>
<script src="/v3/data-box.js?v=…"></script>
<script src="/v3/data-box-energy.js?v=…"></script>
<script type="module" src="/v3/generation/index.js?v=…"></script>
<script type="module" src="/v3/generation/new/index.js?v=…"></script>
<script src="/v3/app.js?v=…"></script>
```

To force browser refresh of any of them, bump the `?v=` string (any unique value works). Current version pattern: `DDMMYYYY{letter}` e.g., `19052026a`.

---

## COMMON TASKS

### Run the new pipeline locally
1. `vercel dev` in one terminal (loads cloud env vars including `RUBIN_REFRESH_TOKEN`, `OPENAI_API_KEY`).
2. Either:
   - `node tests/.test-full-pipeline.mjs` to run the test harness, OR
   - Open `http://127.0.0.1:3000/v3` and flip `USE_NEW_GEN = true` in `v3/app.js` (note: only the test currently exercises the full new pipeline; the v3 UI hasn't been rewired to feed the new pipeline yet).

### Re-seed the Rubin refresh token
1. Visit the auth URL (see "Seeding `RUBIN_REFRESH_TOKEN`" above) in a browser signed into the Rubin Spotify user account.
2. Approve consent. Copy the new `refresh_token` from the callback page.
3. Update `RUBIN_REFRESH_TOKEN` in Vercel cloud env (Dashboard → Project Settings → Environment Variables).
4. Restart `vercel dev`.

### Push changes
```powershell
git add <paths>
git commit -m "feat/fix: description"
git push origin main   # auto-deploys to Vercel
```

### Bump cache version
Replace all `?v=…` values in `v3/index.html`'s 6 script tags with a new unique string.

### Add user to Spotify Development Mode
`developer.spotify.com/dashboard → <app> → User Management → Add user`. Use the Spotify account email (not always the same as the user's primary email).

### Add a business type
Add rows to the Google Sheet (see "Data Box System"). New pipeline picks them up live. OLD pipeline would also need `data-box.js` + `data-box-energy.js` updates — skip unless maintaining the OLD pipeline.

---

## KNOWN ISSUES

1. **Most Spotify Web API features deprecated.** See top section. Affects OLD pipeline severely; NEW pipeline designed around remaining live endpoints.
2. **OLD pipeline's "Save to Spotify" is broken** — uses removed `POST /v1/users/{id}/playlists`. Not maintained.
3. **Spotify Development Mode 25-user limit** — applies to OAuth users. NEW pipeline doesn't OAuth end users so it's effectively unlimited there; legacy `/v3` screen 2 OAuth still hits this for users who go through the old flow.
4. **iOS Spotify scope caching** — `show_dialog=true` doesn't always work on iOS. Workaround: revoke app access in Spotify Settings, reconnect.
5. **One-row biz-type energy split is unimplemented.** When the matcher returns a business type whose single row covers both energies (e.g., `חומוסיה / שיפודיה / שווארמה`), `buildPlaylists` returns `{ skipped: true, … }`. We need an external audio-features API to split the single track pool by energy. Out of scope until that's set up.
6. **`vercel dev` + cloud-linked project quirk.** Adding env vars to `.env.local` doesn't expose them to functions; they have to be in Vercel cloud env. Be careful when seeding new variables — always use the Vercel dashboard or `vercel env add`.

---

## CONTACTS

- **Owner:** Michael Avshalom — avshalom.michael@gmail.com — GitHub: @michaelavs-1
- **Developer:** Roni Mark — roni.mark@gmail.com — GitHub: @ronimark04
- **Michael's Spotify app:** sonic-brand — developer.spotify.com/dashboard (account: Michael's)
- **Rubin's Spotify app:** the newer app for user-context writes (account: Rubin Sonic Brands)
- **Rubin Spotify user account:** "Rubin - Sonic Brands" (id `316gotb2mutzdjmghprpgmxwq62i`)
- **Supabase:** project xhkqrxljncazvbgkmqex
- **Data Box:** Google Sheets (ask Michael for access)
