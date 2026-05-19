# Robin · SonicBrands — AI Context Document
> Optimized for Claude and other AI coding assistants.
> Read this entire file before touching any code.

## WHAT IS THIS

Robin is an AI-powered Spotify playlist builder for physical businesses (cafes, bars, restaurants, stores). A business owner describes their venue → Robin generates two playlists: one calm (🌙 רגוע) and one energetic (🔥 מקפיץ), sourced exclusively from curated Spotify playlists in a "Data Box" spreadsheet.

**Live URL:** https://sonic-brand.vercel.app/v3
**Repo:** https://github.com/michaelavs-1/sonic-brand
**Owner:** Michael Avshalom (avshalom.michael@gmail.com)

---

## ARCHITECTURE OVERVIEW

```
User describes business
        ↓
SB_matchDataBox() → matches business type to Data Box entry
        ↓
buildTrackPool(entry, energyLevel)
  → fetches ALL playlists for business+energy from Data Box
  → random offset per playlist (different tracks each run)
  → BPM/energy filter (energy 1: <0.72 energy, <138 BPM | energy 2: >0.35 energy, >85 BPM)
  → returns pool of 200-500 Spotify track objects
        ↓
selectFromPool(pool, faders, moods, energyLevel)
  → filters session history (no repeats)
  → stratifies: 35% popular / 45% mid / 20% niche
  → sends up to 200 tracks to GPT with indices
  → GPT returns {"tracks":[{"n":1},{"n":5},...]} — picks by NUMBER, never invents
  → maps indices back to Spotify track objects with IDs
        ↓
Two playlists generated sequentially (energy 1 first, then energy 2)
Playlist 2 receives Set of playlist1 IDs → zero shared tracks guaranteed
Hard post-dedup: any track in playlist1 is removed from playlist2
```

---

## FILE STRUCTURE

```
sonic-brand/
├── v3/
│   ├── index.html          ← UI: 5 screens, all CSS/HTML, loads scripts at bottom
│   ├── app.js              ← ALL logic: Robin brain, Spotify OAuth, generation pipeline
│   ├── data-box.js         ← Static Data Box: keyword matching + old-format entries
│   ├── data-box-energy.js  ← Energy separation map: label → {1:{playlists,genres}, 2:{playlists,genres}}
│   └── mc-mappings.js      ← MC questions (familiarity, Hebrew/foreign) + fader conversion
├── api/
│   ├── spotify.js          ← Spotify proxy (CC tokens + user tokens, all Spotify API calls)
│   ├── openai.js           ← OpenAI proxy (GPT calls, manages API key from Supabase)
│   └── databox.js          ← Fetches Google Sheet CSV, returns parsed entries (currently broken — sheet not public)
├── vercel.json             ← Rewrites /v3→/v3/index.html, no-cache headers, function timeouts
└── CLAUDE.md               ← This file
```

---

## KEY CONSTANTS (v3/app.js top of file)

```javascript
const SUPABASE_URL    = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON   = 'eyJhbGci...'; // anon key, safe to keep in client
const SPOTIFY_CLIENT_ID = 'b6404b5ae1684143b79d9a86bb4b6cba';
const SPOTIFY_SCOPES  = 'playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative user-read-private user-read-email';
const SPOTIFY_REDIRECT = location.origin + location.pathname; // https://sonic-brand.vercel.app/v3
```

---

## STATE OBJECT (v3/app.js)

```javascript
const state = {
  step: 1,                    // current screen (1-5)
  totalSteps: 5,
  energyLevel: 1,             // 1=calm/רגוע, 2=energetic/מקפיץ (used internally during generation)
  useDataBox: true,           // toggle L0 on/off (📋 button in header)
  bizName: '',                // business name (new field, screen 3)
  bizDesc: '',                // business description text
  bizType: null,              // detected biz type (e.g., "בר יין")
  bizFunc: '',                // GPT-generated music function sentence
  selectedMoods: new Set(),   // selected mood chips
  selectedUserPlaylists: [],  // IDs picked from playlist picker (screen 3, max 3)
  mc: { familiarity: 3, hebrew: 3 }, // MC slider values (1-5)
  refPlaylist: '',            // optional reference playlist URL
  playlist1: [],              // final calm playlist (30 tracks)
  playlist2: [],              // final energetic playlist (30 tracks)
  _generatedHistory: new Set(), // IDs generated this session — excluded from next run
  generatedTracks: [],        // legacy (still referenced in some places)
  spotifyToken: null,         // current user access token
  spotifyUser: null,          // {id, display_name, images}
  userPlaylists: [],          // user's Spotify playlists (screen 3 picker)
  feedback: {},               // trackKey → 'up'|'down'
  brainContext: {             // assembled by buildBrainContext()
    l0: null, l1: null, l2: null, l3: null, l4: null,
    assembled: false,
  },
  regenCount: 0,
  selectedModel: 'gpt-5.4',
};
```

---

## SCREEN FLOW

```
Screen 1: Welcome → "בואו נתחיל"
Screen 2: Spotify OAuth (PKCE) → connect account
Screen 3: Business name + description + optional playlist picker (user's Spotify playlists)
Screen 4: Detected business type banner + mood chips + MC faders (familiarity, Hebrew/foreign)
          → "צרו פלייליסט" button calls startGeneration()
Screen 5: Loading spinner → two accordion playlists (🌙 רגוע, 🔥 מקפיץ)
          Each has: track list with Spotify embed, Save to Spotify, Regenerate
```

**Navigation:** `setStep(n)` handles all screen transitions.
**Screen 3 special:** loads user's Spotify playlists asynchronously (fetchUserPlaylists).
**Screen 5 special:** startGeneration() called from Screen 4 button.

---

## CORE FUNCTIONS — GENERATION PIPELINE

### `startGeneration()` — entry point
```
1. setStep(5) + show loading
2. verify Spotify token
3. playlist1 = await generateTracklist(1, regenCount, [])
4. p1ids = new Set(playlist1.map(t=>t.id))
5. playlist2 = await generateTracklist(2, regenCount, p1ids)
6. hard dedup: remove any playlist1 IDs from playlist2
7. hide loading, show result, renderPlaylist(1), renderPlaylist(2)
8. saveAnalysis()
```

### `generateTracklist(energyLevel, attempt, excludeIds)` — per-playlist generation
```
1. match business to Data Box (SB_matchDataBox)
2. buildTrackPool(l0Match, energyLevel) → pool[]
3. filter pool by excludeIds (cross-playlist dedup)
4. selectFromPool(pool, faders, moods, energyLevel) → 30 tracks
5. fallback: if <20 tracks, use old GPT generation + validateOnSpotify
6. diversity filter: max 2 per artist, remove disliked artists
7. fill to 30 from pool if diversity filter reduced count
```

### `buildTrackPool(entry, energyLevel)` — builds track pool from Data Box
```
Priority: entry.liveEnergy[energyLevel] → entry.energy[energyLevel] → entry.playlists (fallback)
1. get playlist IDs for this energy level
2. shuffle playlist order (different each run)
3. fetch 50 tracks per playlist at random offset (Math.floor(Math.random()*80))
4. deduplicate
5. get audio features for first 100 tracks
6. filter by BPM/energy:
   energy 1 (calm):     f.energy < 0.72 AND f.tempo < 138
   energy 2 (energetic): f.energy > 0.35 AND f.tempo > 85
7. return filtered pool (or unfiltered if too few pass)
```

### `selectFromPool(pool, faders, moods, energyLevel)` — GPT selects from pool
```
1. filter session history (_generatedHistory)
2. stratify: popular(≥60) 35%, mid(25-60) 45%, niche(<25) 20%
3. final shuffle, cap at 200 tracks
4. build numbered list: "1. Artist — Title\n2. ..."
5. call GPT: returns {"tracks":[{"n":1},{"n":5},...]}
6. map indices back to track objects from sample[]
7. fill to 30 from pool if GPT picked fewer
8. add all picked IDs to state._generatedHistory
```

**CRITICAL:** GPT receives numbers, not artist names. It picks by index. It CANNOT invent tracks — if it returns index 201 when we sent 200 tracks, it's ignored. This ensures 100% of tracks come from the Data Box musical universe.

---

## DATA BOX SYSTEM

### Overview
The Data Box (Google Sheets) is the foundation. Every track in the final playlist comes from a playlist listed in the Data Box. GPT only selects — it never invents.

### Google Sheet
URL: `https://docs.google.com/spreadsheets/d/1b-0rsKBvTSqE0ju7EfGRnpOQiVESZR8hsJBsuITns_E`

Columns: `Type Of business | Key Words | Energy level | Atmospheres | Known/Unknown | Hebrew/Foreign | Style/Genres | Example 1 ... Example 15 | Purpose`

Structure: each business type has TWO rows:
- Row with `Energy level = 1` → calm playlists (Reggae, Jazz, LoFi, etc.)
- Row with `Energy level = 2` → energetic playlists (Tropical House, Punk, Electronic, etc.)

### Static energy map (data-box-energy.js)
Since `/api/databox` can't fetch the sheet (not public), `data-box-energy.js` provides hardcoded energy separation for 14 business types. Loaded as script before `app.js`. Structure:
```javascript
window.SB_ENERGY_MAP = {
  'בר יין': {
    1: { genres: 'Smooth Jazz / Bossa Nova', playlists: ['37i9dQZF1DWWgccrbg3zbJ', ...] },
    2: { genres: 'LoFi Beats / RnB / Funk',  playlists: ['6bX6RfpkoRwqH3at702xja', ...] },
  },
  // ... 13 more business types
};
```
On load, this enriches `SB_DATA_BOX.entries` with `entry.energy = {1:{...}, 2:{...}}`.

### Keyword matching
`SB_matchDataBox(bizDesc)` scores each entry by keyword length (longer = more specific = more points). Minimum score 3 to match. Checks live entries first (`SB_LIVE_ENTRIES` from `/api/databox`), falls back to static.

### Adding a new business type
1. Add 2 rows to Google Sheet (energy 1 + energy 2) with playlists
2. Update `data-box-energy.js` with the new label and playlists
3. Update `data-box.js` with a new entry (id, label, keywords, genres, playlists, energyLow, energyHigh)

---

## SPOTIFY INTEGRATION

### OAuth flow (PKCE)
```
spotifyLogin() → generates verifier/challenge → stores in localStorage + sessionStorage + cookie
              → redirects to accounts.spotify.com/authorize?show_dialog=true
handleSpotifyCallback() → exchanges code for tokens → validates scopes
                        → on missing scopes: shows iOS fix screen (revoke app access)
                        → stores in localStorage: sp3_access, sp3_refresh, sp3_expiry, sp3_user
```

### iOS known issue
iOS Spotify app intercepts OAuth and returns cached old scopes. Fix shown to user:
`Spotify → Settings → Privacy → Apps → sonic-brand → Remove Access → Reconnect`

### Development Mode limit
App is in Spotify Development Mode → max 25 users. Each user must be manually added at:
`developer.spotify.com/dashboard → sonic-brand → User Management`

Currently allowlisted: Michael Avshalom and Ami Nir (added by Roni). The Spotify app is owned by a dedicated sonic-brand Spotify account managed by Roni — separate from Michael's personal Spotify Developer dashboard. For production (unlimited users), apply for Extended Quota Mode.

### Spotify API proxy (/api/spotify.js)
All Spotify API calls from the frontend go through `/api/spotify` (POST):
```javascript
// Actions:
{ action: 'search', query: '...', neutral: true }      // track search
{ action: 'fetch', url: 'https://api.spotify.com/...', neutral: true } // any GET
{ action: 'save_token', access_token, refresh_token, expiry } // save to Supabase
{ action: 'me' }                                        // get user profile
{ action: 'create_playlist', name, description }        // create playlist
{ action: 'add_tracks', playlist_id, uris }             // add tracks to playlist
```
`neutral: true` → uses Client Credentials (no user needed, for search/recommendations).
Without neutral → uses user token from Supabase `spotify_tokens` table (admin/service token).

---

## OPENAI INTEGRATION

### Model
`gpt-5.4` — specified in `state.selectedModel`. Uses `max_completion_tokens` (not `max_tokens`).

### Two GPT calls per playlist generation

**Call 1: Business analysis** (in `detectBusinessType()` + `submitBizInfo()`)
- Model: mini (faster/cheaper)
- Input: business description
- Output: `{biz_type, music_function, recommended_moods}`
- Also calls `buildBrainContext()` which runs L1-L4

**Call 2: Track selection** (in `selectFromPool()`)
- Model: main gpt-5.4
- Temperature: 0.82
- Input: numbered list of up to 200 tracks + business context
- Output: `{"tracks":[{"n":1},{"n":5},...]}` — indices only
- Max tokens: 800

### Brain context (L0-L4)
Built by `buildBrainContext()`, assembled into prompt by `assembleBrainBlocks()`:
- L0: Data Box entry info (genres, top artists, energy description)
- L1: Reference playlist DNA (if user provided URL — audio stats, top artists)
- L2: Historical cohort from Supabase (similar businesses' past analyses)
- L3: Genre archive from Supabase (past analyses matching selected moods)
- L4: Feedback reranker from Supabase (thumbs up/down history)

Currently: L0 drives track selection (the pool). L1-L4 inform the GPT context in `assembleBrainBlocks()` but since GPT now SELECTS (not generates), their influence is indirect.

---

## SUPABASE SCHEMA

```sql
-- analyses: every generation is logged
analyses (id, user_name, description, biz_category, brain_version, faders, genres, refs,
          energy_curve, track_count, tracks, business_name, brain_logs, created_at)

-- track_feedback: thumbs up/down
track_feedback (id, user_id, track_id, track_key, feedback, biz_category, created_at)

-- app_settings: OpenAI key
app_settings (id, key, value, updated_at)
  -- row: key='openai_api_key', value=encrypted_key

-- spotify_tokens: admin service token (not currently used for user playlists)
spotify_tokens (id, access_token, refresh_token, expiry, updated_at)
```

---

## MC FADERS (mc-mappings.js)

Currently only 2 active questions (vocal, energy, era were removed):

```javascript
window.SB_V2_MC = {
  familiarity: { /* 5 options: "שירה בציבור" (95) → "חוויה ייחודית" (12) */ },
  hebrew:      { /* 5 options: "רק עברית" (100) → "רק לועזית" (0) */ },
};

window.SB_V2_mcToFaders = function(mc) {
  return {
    familiarity: /* 0-100 */,
    hebrew:      /* 0-100 */,
    vocal: 50,   // auto
    energy: 50,  // auto (split into two playlists)
    era: 50,     // auto
  };
};
```

Faders are passed to `generateCandidates()` (fallback GPT generation) and to `selectFromPool()` (familiarity used for popularity stratification).

---

## PLAYLIST RENDERING

### `renderPlaylist(energyLevel)`
Renders to `#tracksList1` or `#tracksList2`. Each track:
```html
<div class="track-wrap">
  <div class="track-item" id="item_N_i">
    <div class="track-num">i+1</div>
    <div class="track-cover" style="background-image:url(...)"></div>
    <div class="track-meta"><div class="track-title">...</div><div class="track-artist">...</div></div>
    <button class="play-btn" onclick="toggleEmbed(energyLevel, i, spotifyId)">▶</button>
    <div class="track-vote">
      <button class="vote-btn up" onclick="vote(energyLevel, i, 'up')">👍</button>
      <button class="vote-btn down" onclick="vote(energyLevel, i, 'down')">👎</button>
    </div>
  </div>
  <div class="track-embed" id="embed_N_i">
    <!-- Spotify iframe embed when play-btn clicked -->
  </div>
</div>
```

### Accordion
Click header → `toggleAccordion(1|2)` → opens/closes track list.
CSS: `.pl-accordion-body` with `max-height: 0 → 4000px` transition.

### Playlist naming
Format: `"[bizName] · רגוע #01"` / `"[bizName] · מקפיץ #01"`
`#01` = regenCount padded to 2 digits.

---

## SAVE TO SPOTIFY

`saveToSpotify(energyLevel)`:
1. get user token (refreshes if needed, triggers login if missing)
2. `GET /v1/me` → get user ID (if 403/401: show scope fix screen)
3. `POST /v1/users/{id}/playlists` → create public playlist with named format
4. `POST /v1/playlists/{id}/tracks` → add tracks in chunks of 100
5. open playlist URL in new tab

---

## VERCEL DEPLOYMENT

```json
// vercel.json key settings:
{
  "rewrites": [
    { "source": "/v3", "destination": "/v3/index.html" }
  ],
  "headers": [
    { "source": "/v3/(.*)", "headers": [{"key":"Cache-Control","value":"no-cache,no-store,must-revalidate"}] }
  ],
  "functions": {
    "api/openai.js": { "maxDuration": 60 },
    "api/spotify.js": { "maxDuration": 30 }
  }
}
```

Auto-deploys on push to `main`. Cache busting: update `?v=XXXXXXX` in index.html script tags.

---

## KNOWN ISSUES

1. **`/api/databox` returns 0 entries** — Google Sheet needs to be publicly accessible. Currently using `data-box-energy.js` static fallback with 14 business types.

2. **BPM filter only on first 100 tracks** — Spotify audio features API limited to 100 IDs per request. Tracks beyond index 100 in the pool pass without BPM filtering.

3. **Spotify Development Mode** — max 25 users. Need Extended Quota Mode for production.

4. **L2-L4 brain layers** — code exists but less impactful now that GPT selects from a fixed pool. May need rethinking.

5. **iOS Spotify scope caching** — show_dialog:true doesn't always work on iOS. Fix: user must revoke app access in Spotify settings.

---

## RANDOMIZATION MECHANISMS

To ensure different playlists each run:
1. Playlist order shuffled before fetching
2. Random offset (0-80) per playlist fetch → different 50 tracks each time
3. Session history (`_generatedHistory`) excludes all previously picked tracks
4. Popularity stratification (35%/45%/20%) prevents always picking most famous
5. GPT temperature 0.82
6. GPT instructions: max 2 per artist, spread picks across full list
7. Cross-playlist dedup: energy2 pool excludes all energy1 track IDs

---

## COMMON TASKS

### Add a business type to Data Box
1. Add 2 rows to Google Sheet
2. Add entry to `data-box-energy.js`:
```javascript
'שם העסק': {
  1: { genres: 'Genre1 / Genre2', playlists: ['spotifyId1', 'spotifyId2', ...] },
  2: { genres: 'Genre3 / Genre4', playlists: ['spotifyId3', 'spotifyId4', ...] },
},
```
3. Add entry to `data-box.js` (for keyword matching):
```javascript
{
  id: 'entry_id',
  label: 'שם העסק',
  keywords: ['keyword1', 'keyword2'],
  genres: 'Genre description',
  playlists: [{ id: 'spotifyId', moods: ['אווירה1'] }],
  energyLow:  { label: 'תיאור', description: '...' },
  energyHigh: { label: 'תיאור', description: '...' },
  category: 'category_name',
}
```

### Push changes
```bash
git add v3/app.js v3/index.html  # or specific files
git commit -m "feat/fix: description"
git push origin main  # auto-deploys to Vercel
```
No credentials needed if remote is configured with token.

### Bump cache version (force browser reload)
In `v3/index.html`, change `?v=08052026b` on all 4 script tags to a new string.

### Add user to Spotify Development Mode
`developer.spotify.com/dashboard → sonic-brand → User Management → Add user`
Requires their Spotify account email (not always the same as their regular email).

### Change GPT selection ratio
In `selectFromPool()`, modify the stratification percentages:
```javascript
...popular.slice(0, Math.round(MAX*0.35)),  // ← change 0.35
...mid.slice(0, Math.round(MAX*0.45)),       // ← change 0.45
...niche.slice(0, MAX - ...),               // remainder
```

### Adjust energy BPM thresholds
In `buildTrackPool()`:
```javascript
if(energyLevel===1) return f.energy < 0.72 && f.tempo < 138;  // ← adjust
if(energyLevel===2) return f.energy > 0.35 && f.tempo > 85;   // ← adjust
```

---

## ENVIRONMENT VARIABLES (Vercel)

| Variable | Source |
|----------|--------|
| `SPOTIFY_CLIENT_ID` | Spotify Developer Dashboard |
| `SPOTIFY_CLIENT_SECRET` | Spotify Developer Dashboard |

OpenAI key is stored in Supabase `app_settings` table (not Vercel env var).
Supabase URL and anon key are hardcoded in `app.js` (anon key is safe for client).

---

## CONTACTS

- **Owner:** Michael Avshalom — avshalom.michael@gmail.com — GitHub: @michaelavs-1
- **Developer:** Roni Mark — roni.mark@gmail.com — GitHub: @ronimark04
- **Spotify App:** sonic-brand — developer.spotify.com/dashboard
- **Supabase:** project xhkqrxljncazvbgkmqex
- **Data Box:** Google Sheets (ask Michael for access)
