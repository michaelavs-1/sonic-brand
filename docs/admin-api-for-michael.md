# Robin — Internal Admin API Reference

> Give this document (or paste its contents) to your Claude / AI coding
> assistant so it has everything it needs to build a dashboard against
> the Robin admin API. This is a self-contained reference — no other
> files from Robin's repo are needed.

Robin (the AI playlist builder for physical businesses) exposes a small
read-only admin API on top of its production deployment. This API is
intended for building an internal dashboard where the owner (Michael)
can browse every business that has signed up and inspect the exact
onboarding data, playlists, and direction-edit chat history each owner
generated.

The API is entirely read-only — nothing here mutates data.

---

## 0. Ground rules — read this first

Two hard rules. These apply to Michael, to any AI assistant helping
build the dashboard, and to anyone else with access to the codebase.
**Violating either can break Robin's live production deploy.**

### 0.1. Deploy the dashboard to the Vercel project `sonic-brand-preview` — NEVER to `sonic-brand`

- `sonic-brand` is Robin's **production** Vercel project. It serves
  https://robin-music.com and https://sonic-brand.vercel.app to real
  customers. Deploying anything from the dashboard repo to that project
  would replace the live site with your dashboard build — an outage.
- `sonic-brand-preview` exists as a **separate** Vercel project used
  specifically for admin / tooling work like this dashboard. Deploy
  there. Only there. Every time.
- Before running `vercel` / `vercel --prod` / any deploy command,
  verify the project link. Check `.vercel/project.json` in your
  working directory — the `projectName` (or `projectId`) MUST resolve
  to `sonic-brand-preview`. If it says `sonic-brand`, **stop**,
  unlink (`vercel unlink`), and re-link to the correct project
  (`vercel link` → choose `sonic-brand-preview`).
- No hook or CI check enforces this on Robin's side yet — the guard
  is entirely on your side. Treat it like `rm -rf` and double-check
  every time.

### 0.2. Don't modify Robin's API code, even if you have repo access

- The endpoints in this document live in Robin's repo, in three
  files: `api/internal/users.js`, `api/internal/business.js`,
  `api/internal/gemini-spend.js`. Michael has read/write access to
  that repo. **Don't use it.**
- If you need a new field, a new endpoint, a bug fix, an auth change,
  or any modification to the API response shape — **ask Roni.** He'll
  implement it in Robin's repo and re-share an updated version of
  this document.
- Reasons to route changes through Roni:
  - Robin's repo has its own testing / cache-busting / migration
    conventions. Edits made from outside easily miss them.
  - The internal admin API shares infrastructure (Supabase, auth
    guards, rate limiting) with the customer-facing product; a
    well-meaning change can cascade.
  - Both sides need to agree on the response shape so the dashboard
    and the API don't drift.

If you're unsure whether something counts as "modifying the API",
default to asking. Building your own client-side helpers, transforms,
caching layers, UI, deploy pipeline, etc. is fully your call — the
rule is only about touching files under `api/internal/*` in Robin's
repo.

---

## 1. Base URL

```
https://robin-music.com
```

`https://sonic-brand.vercel.app` also works — same deploy, different
alias. Use `robin-music.com` in new code.

---

## 2. Authentication

Every request must carry a shared bearer token:

```
Authorization: Bearer <INTERNAL_ADMIN_API_KEY>
```

Or, if it's easier for your HTTP client, the token may also be
presented as its own header:

```
x-internal-admin-key: <INTERNAL_ADMIN_API_KEY>
```

Both are accepted; use whichever fits your stack. The token itself is
delivered out-of-band by Roni. **Never commit it to source control.**
Store it in an environment variable / secret manager and read it at
runtime.

Missing or wrong token → HTTP `401` or `403` with a JSON `{ error }`
body. There is no login flow — the shared token is the entire auth
boundary.

### CORS

- `Access-Control-Allow-Origin: *` on every response
- `Access-Control-Allow-Methods: GET, OPTIONS`
- `Access-Control-Allow-Headers: Authorization, x-internal-admin-key, Content-Type`
- `Vary: Origin` (informational; the API doesn't vary its behavior by origin)

This is safe because the bearer token is not a cookie — a random
malicious page can't force the user's browser to attach it. Your
dashboard can be hosted on any origin (local dev, your own Vercel
project, GitHub Pages, etc.) without pre-registration.

### Rate limiting

None. This is a small pilot-scale surface; poll sensibly (don't refresh
faster than every few seconds) but there is no server-side quota.

### Caching

All responses set `Cache-Control: no-store`. Data may change under you
(users signing up, direction chat commits) so don't cache client-side
either.

---

## 3. Endpoints

Three endpoints. Typical dashboard flow: list all businesses via
`/users`, then fetch full detail for whichever one the admin clicks
via `/business?id=<uuid>`. `/gemini-spend` gives site-wide Gemini API
cost totals (also available per-business inside the `/business`
response).

### 3.1. `GET /api/internal/users`

List every business with its owner's email and a hint about whether
the onboarding prompt was captured.

#### Request

```http
GET /api/internal/users HTTP/1.1
Host: robin-music.com
Authorization: Bearer <INTERNAL_ADMIN_API_KEY>
```

No query params, no body.

#### Response — `200 OK`

```json
{
  "count": 12,
  "businesses": [
    {
      "business_id": "9c3f...uuid",
      "name":        "Café Mocha",
      "owner_id":    "auth-user-uuid",
      "owner_email": "owner@example.com",
      "created_at":  "2026-08-24T09:12:33.104Z",
      "has_prompt":  true
    },
    ...
  ]
}
```

Field notes:

- Ordered `created_at DESC` (newest first).
- `owner_email` may be `null` for orphaned businesses (owner user was
  deleted).
- `has_prompt` is `true` iff either the business_description or
  musical_emphases fields are non-null. Businesses that signed up
  before 2026-08-23 will have `has_prompt: false` — those columns
  only started being captured on that date. The detail endpoint still
  works for them; the two free-text fields will just come back `null`.

#### Errors

- `401` — missing `Authorization` header
- `403` — wrong token
- `500` — server misconfigured (admin key not set on the server side —
  contact Roni)

---

### 3.2. `GET /api/internal/business?id=<uuid>`

Full detail for one business. Everything the dashboard needs to render
a per-business view.

#### Request

```http
GET /api/internal/business?id=9c3f...uuid HTTP/1.1
Host: robin-music.com
Authorization: Bearer <INTERNAL_ADMIN_API_KEY>
```

`id` must be a valid UUID (from `/users` response's `business_id`).
Non-UUID → `400`.

#### Response — `200 OK`

Structure (all fields listed; a few are noted as nullable):

```jsonc
{
  "business": {
    "id":                  "uuid",
    "name":                "Café Mocha",
    "owner_id":            "auth-user-uuid",
    "owner_email":         "owner@example.com",  // null if orphaned
    "created_at":          "2026-08-24T09:12:33.104Z",
    "onboarding_expanded": true,                 // did the first-visit
                                                 // playlist expansion run?
    "monthly_credits":     30,
    "credits_remaining":   30
  },

  "onboarding": {
    // The three free-text-ish inputs each owner filled in during onboarding.
    // Any/all of these may be null for pre-migration signups.
    "business_description": "A cosy neighbourhood wine bar in Tel Aviv…",
    "musical_emphases":     "לא מוזיקה אלקטרונית, יותר אר אן בי",
    "atmospheres":          ["אלגנטי", "קליל"]
  },

  "place": {
    // Snapshot of the Google Places result the owner confirmed during
    // onboarding. `null` if they skipped / no match / Places was disabled.
    "business_id":       "uuid",
    "place_id":          "ChIJ...",
    "name":              "Café Mocha",
    "address":           "Rothschild 42, Tel Aviv",
    "primary_type":      "cafe",
    "types":             ["cafe", "point_of_interest", "food"],
    "editorial_summary": "Casual spot…",
    "price_level":       "PRICE_LEVEL_MODERATE",
    "website_uri":       "https://example.com",
    "vibe":              { /* raw Places vibe object, may be null */ },
    "updated_at":        "2026-08-24T09:13:00Z"
  },

  "hours": {
    // Weekly opening hours the owner set. `null` if never captured.
    "business_id":     "uuid",
    "hours": {
      "0": { "closed": true },
      "1": { "closed": false, "open": "10:00", "close": "22:00" },
      "2": { "closed": false, "open": "10:00", "close": "22:00" },
      "3": { "closed": false, "open": "10:00", "close": "22:00" },
      "4": { "closed": false, "open": "10:00", "close": "23:00" },
      "5": { "closed": false, "open": "10:00", "close": "23:00" },
      "6": { "closed": true }
    },
    "longest_minutes": 780,
    "updated_at":      "2026-08-24T09:13:00Z"
  },

  "directions": [
    // Every musical direction ever created for this business. Includes
    // both active and soft-removed rows (`active: false`). Ordered by
    // `rank ASC` with nulls last.
    {
      "id":                          "uuid",
      "rank":                        1,               // 1..8, informational
      "title_en":                    "Neo-Soul Sundown",
      "description_he":              "…",
      "genres":                      ["neo-soul", "r&b"],
      "bpm_range":                   { "min": 75, "max": 100 },
      "popularity_window":           [30, 80],        // [lo, hi]
      "instrumentalness_preference": "none",          // "none" | "soft" | "hard"
      "active":                      true,
      "created_at":                  "…",
      "updated_at":                  "…"
    }
  ],

  "playlists": [
    // Every Spotify playlist ever built for this business, live and
    // expired. Nothing deletes rows here — `expires_at` only controls
    // whether the owner's dashboard shows the entry. Ordered by
    // `created_at DESC`.
    {
      "spotify_id":   "37i9dQZF1DX...",
      "url":          "https://open.spotify.com/playlist/…",
      "label":        "Neo-Soul Sundown",
      "ico":          "🎵",                            // 🎪 for event playlists
      "track_count":  120,
      "genres":       ["neo-soul", "r&b"],
      "bpm_range":    { "min": 75, "max": 100 },      // present for event playlists
      "event_id":     null,                            // back-ref for event playlists
      "direction_id": "uuid",                          // FK → directions[i].id
      "track_ids":    ["4uLU6hMCjMI75M1A2tKUQC", ...], // ordered Spotify IDs
      "expanded_at":  "…",
      "expires_at":   "2026-08-25T18:00:00Z",
      "created_at":   "2026-08-24T09:15:00Z"
    }
  ],

  "direction_changes": [
    // Audit log for the direction-edit chat: one row per committed
    // add/edit/remove. Ordered `applied_at DESC` (newest first).
    // Empty array for owners who haven't used the chat.
    {
      "id":               "uuid",
      "kind":             "edit",                      // "add" | "edit" | "remove"
      "direction_id":     "uuid",                      // populated for all
                                                       // kinds; nullable only
                                                       // because a later hard-
                                                       // delete of the direction
                                                       // sets it to null (FK
                                                       // ON DELETE SET NULL)
      "before":           { /* direction snapshot */ }, // null for "add"
      "after":            { /* direction snapshot */ }, // null for "remove"
      "playlist_action":  "rebuilt",                   // "rebuilt" | "expired"
                                                       //   | "kept" | null
      "message_id_first": "uuid-of-first-chat-msg",    // may be null
      "message_id_last":  "uuid-of-last-chat-msg",     // may be null
      "applied_at":       "2026-08-25T14:30:00Z"
    }
  ],

  "chat_transcript": [
    // Full history of the direction-edit chat for this business, ordered
    // by created_at ASC (oldest first — display top-to-bottom as normal).
    // Empty array for owners who haven't used the chat.
    {
      "id":                    "uuid",
      "role":                  "user",                 // "user" | "assistant"
      "content":               "text of the message",  // for assistant turns
                                                       //   this is raw JSON
                                                       //   string; see notes
      "proposal":              { /* structured proposal */ } | null,
      "selected_direction_id": "uuid" | null,          // which direction
                                                       //   card the user
                                                       //   had highlighted
      "created_at":            "2026-08-25T14:29:12Z"
    }
  ],

  "gemini_spend": {
    // Roll-up of everything this business cost us in Gemini API calls
    // (both onboarding calls — retroactively attributed at signup — and
    // post-signup calls from event chat / direction-edit chat / etc.).
    // Always present, but `total_usd` will be 0 for businesses that
    // signed up before 2026-08-25 when call logging started.
    "total_usd":  0.0234,
    "call_count": 12,
    "by_label": [
      { "label": "onboarding",      "usd": 0.0180, "calls": 2 },
      { "label": "event-chat",      "usd": 0.0034, "calls": 4 },
      { "label": "direction-chat",  "usd": 0.0020, "calls": 6 }
    ]
  },

  "gemini_calls": [
    // Every logged Gemini call attributed to this business, newest
    // first. Empty if the business predates call logging.
    {
      "id":              "uuid",
      "created_at":      "2026-08-25T15:00:00Z",
      "model":           "gemini-3.6-flash",
      "label":           "onboarding",         // caller-supplied tag
      "input_tokens":    2400,
      "output_tokens":   1120,                  // includes thinking tokens
                                                //   for cost purposes
      "thinking_tokens": 180,                   // broken out for analytics
      "total_tokens":    3520,
      "cost_usd":        0.005780,              // priced at the rate in effect
                                                //   at created_at
      "finish_reason":   "STOP",                // "STOP" | "MAX_TOKENS" | etc.
      "http_status":     200
    }
  ],

  "playlist_opens": [
    // One row per time the owner clicked the "▶ פתח" button on a
    // playlist card in their account dashboard. Newest first. Empty
    // for businesses whose owner has never opened a playlist since
    // the feature launched (2026-08-26).
    {
      "id":         12345,                     // bigserial
      "spotify_id": "37i9dQZF1DX...",          // join back to
                                                //   `playlists[i].spotify_id`
                                                //   for label/direction/genres
      "source":     "home-daily",              // "home-daily" | "home-event"
                                                //   | future values
      "opened_at":  "2026-08-27T13:22:44Z"
    }
  ],

  "playlist_opens_summary": {
    // Pre-computed rollups so the UI doesn't have to sum on the client.
    "total":        7,                          // total clicks logged
    "by_playlist": [                            // desc by count
      { "spotify_id": "…", "count": 5, "last_opened_at": "…" },
      { "spotify_id": "…", "count": 2, "last_opened_at": "…" }
    ],
    "by_source": [                              // desc by count
      { "source": "home-daily", "count": 5 },
      { "source": "home-event", "count": 2 }
    ]
  }
}
```

Field notes:

- `direction_id` on playlist and change rows is an FK back to
  `directions[i].id`. Client-side, build a `Map(id → direction)` once
  and look up titles from there.
- `chat_transcript[i].content` for `role: "assistant"` messages is a
  JSON string (the chat backend enforces structured output). If you
  want the reply text alone, `JSON.parse(content)?.reply_he` is
  usually there. For `role: "user"` it's plain text.
- `proposal` shape: `{ kind: "add" | "edit" | "remove", ... }`. Only
  present on assistant turns that offered a confirm/preview button;
  most assistant turns have `proposal: null`.
- `before` / `after` on `direction_changes` are direction snapshots
  in the same shape as `directions[i]` (title_en, description_he,
  genres, bpm_range, instrumentalness_preference, active).
  `null` on the "missing" side (add has no `before`; remove has no
  `after`).
- Empty arrays are the norm — an unused feature returns `[]`, not
  `null`. Don't defensively null-check the arrays.

#### Errors

- `400` — `id` missing or not a valid UUID
- `401` / `403` — auth failure (same as `/users`)
- `404` — no business with that id
- `500` — server error

---

### 3.3. `GET /api/internal/gemini-spend`

Site-wide Gemini API spend totals + breakdowns. Every call through
Robin's Gemini proxy is logged with token counts and the exact price
in effect at the time; this endpoint aggregates all of it.

#### Request

```http
GET /api/internal/gemini-spend HTTP/1.1
Host: robin-music.com
Authorization: Bearer <INTERNAL_ADMIN_API_KEY>
```

No query params, no body.

#### Response — `200 OK`

```jsonc
{
  "totals": {
    // Grand total = baseline + since_logging (INCLUDES the pre-tracking
    // baseline pulled from Google Cloud Billing).
    "all_time_usd":       9.6420,

    // One-off historical amount for Gemini calls made BEFORE the
    // per-call logger was introduced (2026-08-25). Sourced from
    // Google's billing dashboard, converted to USD, hardcoded server-
    // side. See notes below.
    "baseline_usd":       9.19,

    // Sum of `cost_usd` across every logged row.
    "since_logging_usd":  0.4520,
    "all_time_calls":     287,           // logged calls only

    // Rows attributed to a specific business (either because the
    // caller had a business_id at call time, or because the row was
    // backfilled at signup from an onboarding_session_id).
    "attributed_usd":     0.4100,        // logged rows only
    "attributed_calls":   261,

    // "Abandoned onboarding" bucket — the user started onboarding,
    // Gemini spent money on their behalf, but they never signed up.
    // Row has an onboarding_session_id but no business_id.
    "abandoned_usd":      0.0420,        // logged rows only
    "abandoned_calls":    26
  },

  "by_day": [
    // UTC dates. Newest first. Up to 90 days.
    { "day": "2026-08-25", "usd": 0.0234, "calls": 12 }
  ],

  "by_label": [
    // Every label seen in the log, sorted by spend desc.
    // Current labels:
    //   'onboarding'      — musical-directions calls during signup flow
    //                       (two calls per onboarding — both use this label)
    //   'event-chat'      — special-events chat on the account dashboard
    //   'direction-chat'  — direction-edit chat on the account dashboard
    //   'event-playlist'  — genre+BPM extraction when building an event playlist
    //   '(unlabeled)'     — calls that didn't set the label field
    { "label": "onboarding", "usd": 0.2100, "calls": 130 }
  ],

  "by_business": [
    // Per-business rollup — attributed spend only (rows with business_id
    // set at call time OR backfilled from onboarding_session_id at
    // signup). Sorted by spend desc. Empty if no logged calls have
    // been attributed yet. business_name / owner_email may be null for
    // orphaned businesses.
    {
      "business_id":    "uuid",
      "business_name":  "Café Mocha",
      "owner_email":    "owner@example.com",
      "usd":            0.0234,
      "calls":          12
    }
  ],

  "recent": [
    // The last 50 calls, newest first. Same row shape as
    // `gemini_calls` in the business detail response, plus
    // `business_id` (nullable) and `onboarding_session_id` (nullable)
    // so you can attribute or link back to the business detail view.
    {
      "id":                     "uuid",
      "created_at":             "2026-08-25T15:00:00Z",
      "model":                  "gemini-3.6-flash",
      "label":                  "onboarding",
      "input_tokens":           2400,
      "output_tokens":          1120,
      "thinking_tokens":        180,
      "total_tokens":           3520,
      "cost_usd":               0.00578,
      "business_id":            "uuid" | null,
      "onboarding_session_id":  "session-uuid" | null,
      "finish_reason":          "STOP",
      "http_status":            200
    }
  ]
}
```

#### Errors

- `401` / `403` — auth failure
- `500` — server error

#### Notes

- **Pricing snapshot**: `cost_usd` is computed server-side at call time
  using per-model rates. As of the current pricing (gemini-3.6-flash
  paid Standard tier through 2026-12-31): $0.75/1M input, $3.75/1M
  output+thinking. Rates double on 2027-01-01; the server switches
  automatically. Historical rows keep the price they were computed at
  — so pre-2027 rows stay at the cheaper rates in aggregations.
- **`baseline_usd` is hardcoded** — one manual constant on the server
  representing everything Google billed us before per-call logging
  started (2026-08-25). It's included in `all_time_usd` but NOT in
  `attributed`/`abandoned`/`by_day`/`by_label` because we can't
  reconstruct that granularity from a lump-sum billing figure. UI
  should surface it separately so users understand what's from real
  logs vs. what's historical.
- **Aggregation is done in server memory** over the last 10,000 rows
  (a sanity cap). At current pilot scale that's every row ever
  logged. If the response ever looks capped, ping Roni.

---

## 4. Suggested dashboard shape

Not prescriptive — build whatever UI you want. But a workable layout:

**Nav**
- Top-of-page links: "Users" (main) and "Gemini spend" (spend view)

**Main page** (Users)
- Table of businesses from `/users`, columns: email, name, created,
  "has prompt" hint, "view →" link
- Click the email or "view →" to open detail

**Detail page**
Sections stacked top to bottom:
1. **Business** — id, owner email, created, credits, onboarding
   expansion status
2. **Onboarding prompt** — the three free-text inputs. This is the
   main deliverable of the API; put it prominently.
3. **Google Place** — the confirmed place metadata (if any)
4. **Opening hours** — weekly table
5. **Directions** — all of them (both active + inactive) with genres
   / BPM / instrumentalness / active flag
6. **Playlists** — one card per playlist. Show live/expired status
   from `expires_at`. Let the admin expand a card to see the full
   `track_ids` array.
7. **Direction-edit changes** — audit log with `kind` pill
   (add/edit/remove) and expandable before/after JSON per row
8. **Direction-edit chat transcript** — chat-log style rendering
   (user bubbles on one side, assistant on the other), with each
   message showing the direction it targeted (from
   `selected_direction_id`) and expanding the `proposal` JSON if
   present
9. **Gemini spend** — this business's total cost + per-label breakdown
   from `gemini_spend`, with a collapsible list of the individual
   calls from `gemini_calls`
10. **Playlist opens** — engagement signal. Total click count from
    `playlist_opens_summary.total`, per-source breakdown (daily vs
    event), a per-playlist ranking (join `by_playlist[].spotify_id`
    back to `playlists[]` for the label/direction), and the full
    click log from `playlist_opens`.

**Gemini spend page** (site-wide)
- Top card: totals (all-time / baseline / since-logging / attributed / abandoned)
- By-day table or bar chart (from `by_day`)
- By-label table (from `by_label`) — see which feature is driving spend
  (`onboarding`, `event-chat`, `direction-chat`, `event-playlist`)
- By-business table (from `by_business`) — spend attributed to each
  owner, with links to their business detail page. Includes any pre-
  signup onboarding calls that got backfilled at signup time.
- Bottom: last-50 recent calls with per-call cost + a link to the
  business detail page when `business_id` is set

Roni has a reference implementation using exactly this layout — ask
for a screenshot if useful.

---

## 5. Example client code

Vanilla JavaScript (works in a static HTML page or a Node script):

```js
const KEY = 'paste-token-here-or-read-from-env';
const BASE = 'https://robin-music.com';

async function api(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// List every business
const { count, businesses } = await api('/api/internal/users');
console.log(`${count} businesses`);

// Fetch full detail for the first one
if (businesses[0]) {
  const detail = await api(`/api/internal/business?id=${businesses[0].business_id}`);
  console.log(detail);
}
```

curl (shell):

```bash
curl -s -H "Authorization: Bearer $INTERNAL_ADMIN_API_KEY" \
     https://robin-music.com/api/internal/users | jq
```

---

## 6. Common pitfalls

- **Pre-migration data:** businesses that signed up before 2026-08-23
  have `business_description` and `musical_emphases` both `null` and
  `has_prompt: false` in the list. Their `atmospheres` array is still
  populated (that predates the migration). Playlists from before
  2026-08-20 have `track_ids: null` — that composition data was
  never captured historically and is unrecoverable.
- **Atmospheres come from user_metadata, not a table.** Because it's
  only written on FIRST signup for a given email, a user who
  re-onboarded under the same email still shows the atmospheres from
  their original flow.
- **Playlists include expired ones.** Filter by `new Date(expires_at) > new Date()`
  if you only want "live today" playlists.
- **`chat_transcript` assistant content is JSON, not plain text.**
  Parse it before displaying, or the admin sees `{"reply_he":"…"}`.
- **No pagination.** Response could grow if the pilot expands
  dramatically. At current scale (tens of businesses) it's fine; if
  you see the list endpoint take >1s, ask Roni to add pagination.
- **`gemini_spend` is only meaningful for businesses that signed up
  on or after 2026-08-25.** Older signups will have
  `gemini_spend.total_usd = 0` and `gemini_calls = []` even though
  they were doing real work — per-call logging didn't exist yet.
  Their historical spend rolls into `baseline_usd` on the site-wide
  `/gemini-spend` endpoint as one lump sum that can't be broken down
  per business.

---

## 7. Getting help

Anything unclear or missing? Ask Roni. The API surface is defined in
three small files on Robin's side (`api/internal/users.js`,
`api/internal/business.js`, and `api/internal/gemini-spend.js`);
adding a new field or endpoint is a small change.

Reminder from section 0: **don't edit those files yourself**, even
though you have repo access. Request the change from Roni and he'll
update the API and re-share this document. And **always deploy the
dashboard to the `sonic-brand-preview` Vercel project, never to
`sonic-brand`.**
