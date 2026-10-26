# Rubin — Admin Dashboard: Build Brief + API Reference (v2, 2026-10-13; updated 2026-10-22)

> Give this document (or paste its contents) to your Claude / AI coding
> assistant. It holds everything needed to build the admin dashboard: what
> to build (section 1) and the API it's built on (sections 2–5). It is
> self-contained — no other files from Rubin's repo are needed.

Rubin (the AI playlist builder for physical businesses, formerly "Robin")
exposes an admin API on its production deployment. **Version 2** (this
document) moves it to the current product (v7) and adds the actions on
Michael's list. It replaces v1: the endpoint paths are the same, but the
`/business` response was reorganised, so a dashboard built on v1 needs
updating. Section 9 maps every v1 field to its new place.

Michael's list, and where each item lives:

| # | Item | Where |
|---|---|---|
| 1 | Business name | `/users`, `/business` → `business` |
| 2 | Everything entered in onboarding (free text, atmospheres, musical emphases) | `/business` → `onboarding` |
| 3 | The genres shown in the swipe deck and which the owner chose | `/business` → `onboarding.swipe` |
| 4 | The owner's approved genres | `/business` → `taste_profile` |
| 5 | The directions built for them | `/business` → `directions`, `daily[].playlists[].played` |
| 6 | Daily clicks (which playlists were opened each day) | `/business` → `clicks.by_day`, `daily[].playlists[].opens` |
| 7 | What the owner wrote in the taste chat | `/business` → `taste_chat` |
| 8 | Special-playlist requests | `/business` → `special_requests` |
| 9 | Whether they paid, and when | `/users`, `/business` → `payment` |
| 10 | Edit the genres in a direction (add / remove / replace) | `POST /directions` |
| 11 | Choose which direction is offered on each day | `GET/POST /daily-picks` |
| 12 | Create coupon codes | `GET/POST/PATCH /coupons` |

---

## 0. Ground rules — read this first

Three hard rules. They apply to Michael, to any AI assistant helping build
the dashboard, and to anyone else with access to the codebase.
**Breaking them can break Rubin's live production site or change real
customers' music.**

### 0.1. Deploy the dashboard to the Vercel project `sonic-brand-preview` — NEVER to `sonic-brand`

- `sonic-brand` is Rubin's **production** Vercel project. It serves
  https://robin-music.com and https://sonic-brand.vercel.app to real
  customers. Deploying the dashboard to that project would replace the
  live site with your dashboard build — an outage.
- `sonic-brand-preview` is a **separate** Vercel project for admin /
  tooling work like this dashboard. Deploy there. Only there. Every time.
- Before any `vercel` / `vercel --prod` command, check
  `.vercel/project.json` in your working directory: `projectName` (or
  `projectId`) MUST be `sonic-brand-preview`. If it says `sonic-brand`,
  **stop**, run `vercel unlink`, then `vercel link` → `sonic-brand-preview`.
- Nothing on Rubin's side enforces this. Double-check every time.

### 0.2. Don't modify Rubin's API code, even if you have repo access

- The endpoints live in Rubin's repo under `api/internal/` (`users.js`,
  `business.js`, `directions.js`, `daily-picks.js`, `coupons.js`,
  `gemini-spend.js`, and the `_*.js` helpers next to them). **Don't edit
  them.**
- Need a new field, an endpoint, a fix or a shape change? **Ask Roni.**
  He'll change it in Rubin's repo and send an updated version of this
  document. The API shares code with the customer-facing product (the
  daily playlist builder, the payment flow), so a well-meant change can
  break it.
- Your own client-side code — helpers, caching, UI, deploys — is entirely
  your call.

### 0.3. The key can now change customers' music — keep it server-side

Since v2 the API **writes**: it edits a business's directions, chooses
which directions play on a given day, rebuilds today's playlists, and
creates coupons. Anyone holding the key can do all of that.

- Keep the key in a server-side environment variable (e.g. a Vercel
  serverless function or API route in your dashboard that calls Rubin's
  API). **Never put it in browser JavaScript of a page anyone can open.**
- Put your dashboard behind its own login.
- Every write is logged on Rubin's side (`admin_actions`, shown in
  `/business` → `admin_actions`), but the log can't tell who used the key.

---

## 1. What to build — the brief

An internal console for the Rubin team, Michael first. It shows everything
about each customer business and lets the team act on its music. The
12 items in the table above are the requirements. This section says how each
should look. Build the pages in this order, then check every box in 1.6.
Sections 2–5 are the API reference the pages are built on.

### 1.1. Basics

- **Users:** the Rubin team only. Put the whole app behind a login: Vercel's
  password protection on `sonic-brand-preview`, or one shared password kept
  in an environment variable.
- **Language:** a Hebrew interface, right to left (`<html lang="he"
  dir="rtl">`). Michael's list is in Hebrew, and so is most customer content
  (business names, descriptions, chat messages).
  - Genre names, direction titles, keys (`H2`, `L3-1`) and codes stay in
    English, spelled exactly as the API sends them.
  - Wrap them in `dir="ltr"` spans so chips and lists don't scramble.
- **Architecture** (see 0.1, 0.3): a small web app on the
  `sonic-brand-preview` Vercel project.
  - The browser only talks to the app's own server routes. Those add the key
    and call `https://robin-music.com/api/internal/…`.
  - Example: Next.js with one route handler, `/api/rubin/[...path]`, that
    forwards GET / POST / PATCH, with the key read from an environment
    variable.
- **Dates and money:**
  - Show times in Israel time (`Asia/Jerusalem`), as `dd.mm.yyyy` and `HH:mm`.
  - `il_date` values are already Israel dates. Don't convert them.
  - Payments are in ₪, AI costs in $.
- **Writes:**
  - Disable the button while a request runs, and never retry a write by
    yourself.
  - After a success, redraw from the response: every write returns fresh
    data. Show the response's `warnings` and `notes`, and the `error` text on
    failure.
  - Ask for confirmation before: deleting a direction, moving a genre
    (`move: true`), rebuilding today, and switching a coupon off.
- **Loading:** `/business` is heavy (3–6 seconds, a few hundred KB).
  - Load it once per visit to a business, showing a skeleton.
  - After a write, refresh only the endpoint you wrote to (`/directions`,
    `/daily-picks` or `/coupons`).

### 1.2. Page A — עסקים (the home page)

**Summary cards** across the top. Compute them from `/users`, except the last:

- businesses;
- paying (`payment_status === "paid"`);
- active this week (`opens_7d > 0`);
- haven't picked a playlist type yet (`delivery_mode === null`);
- AI cost this month (`/gemini-spend` → `by_month_google[0]`).

**The business table** (5.1), one row per business:

| Column | Item | From |
|---|---|---|
| שם העסק | 1 | `name` |
| אימייל | | `owner_email` |
| נרשם | | `created_at` |
| סוג פלייליסטים | | `delivery_mode`: `option1` → "4 ביום לפי אנרגיה", `option2` → "2 ביום לפי ציר", `null` → "טרם נבחר" |
| ז'אנרים מאושרים | 4 | `approved_genre_count` |
| תשלום | 9 | `paid_at` date, or "ללא תשלום" |
| מנוי | 9 | `subscription_status` |
| פתיחות (7 ימים) | 6 | `opens_7d` |
| פתיחה אחרונה | 6 | `last_opened_at` |
| בקשות מיוחדות | 8 | `special_requests_total` |
| צ'אט טעם | 7 | `taste_chat_messages` |

- **Controls:** search by name or email; filter by type, paid and active;
  sort by any column. The default is newest first.
- A click on a row opens the business page.

### 1.3. Page B — the business page

**Header:** name, email, a type badge, a payment badge, signup date, last
login. Below it, the tabs:

**Tab 1 — סקירה** (items 1, 9):

- **Payment card**, from `payment`:
  - **If paid:**
    - status, first payment (date and time), first month ₪ + coupon,
      monthly ₪;
    - the subscription (active / cancelled / ended), with the next charge,
      or the end date and the cancel reason;
    - a "בדיקה" badge when `terminal` is `test`.
  - **If `no-payment`:** "נרשם כשהתשלומים היו כבויים".
- **Activity:**
  - opens in the last 7 and 30 days (`clicks`);
  - the last day playlists were built (`daily[0].il_date`);
  - counts of special requests and taste-chat messages.
- **The last 7 days:** a small table of day → playlists → opens (`daily`).

**Tab 2 — אונבורדינג** (items 2, 3), from `onboarding`:

- **"מה העסק הזין"** (item 2):
  - the description, atmospheres as chips, the musical emphases, and the
    Round 2 text if there is one;
  - the Google place: name, address, type, website link;
  - the opening hours as a week table, Sunday first, with "סגור" days and a
    mark on closes after midnight.
- **"דק ההחלקות"** (item 3):
  - **With `swipe.cards`:** the cards in order, round 1 then round 2 with a
    divider. Each card shows its title, its `description_he`, the genres as
    chips and a badge: אהב (green) / לא אהב (grey) / לא סומן. Mark
    super-liked genres with a star.
    - Above the cards: "אהב X מתוך Y".
  - **Without (`cards` is `null`):** the note "החשבון נפתח לפני ששמרנו את
    הכרטיסים", then `genre_tally` as one bar per genre (likes vs dislikes),
    most liked first.

**Tab 3 — טעם מוזיקלי** (item 4), from `taste_profile`:

- **The approved genres, one row per energy level**, calm (level 1) to
  energetic (level N), as chips:
  - for Option 1, label each row with its tier: רגוע / אנרגטי;
  - a star on requested genres (they sit in the directions that suit them, and
    one of each day's playlists plays a direction that holds them);
  - a small ↓ / ↑ on genres whose weight is below / above 1.
- **The two preferences:** אינסטרומנטלי and להיטים. Values: `none` → רגיל,
  `soft` → עדיפות, `hard` → רק.
- **Collapsed:**
  - "אולי" (conditional, with its note);
  - "נדחו בצ'אט" (rejected);
  - "לא נבחרו" (excluded: the count, then the list);
  - "הסבר המודל" (`reasoning_en`).
- **"הפורטרט המוזיקלי"** (`portrait.text`, Hebrew), open by default: what the
  taste chat "remembers" about the owner. Show when it was last updated and
  from what (`source`), with earlier versions collapsed (`portrait_history`).

**Tab 4 — כיוונים** (items 5, 10), from `/directions` (5.3):

- **The library in use, grouped:**
  - Option 1 in two columns, "אנרגיה גבוהה" (`H…`) and "אנרגיה רגועה" (`C…`);
  - Option 2 in one section per level, calm to energetic.
- **One card per direction:**
  - key, `title_en`, the genres as chips (requested ones marked), and for
    Option 2 the energy range;
  - **"הושמע לאחרונה":** the last day this direction played and how often in
    the last 30 days.
    - Get them from `/business` → `daily[].playlists[].played`, matching on
      `title_en`: ids change with every edit.
- **Editing** (the actions in 5.3):
  - × on a chip → `remove_genre`.
  - "+ ז'אנר" → a searchable list of `genre_catalog` → `add_genre`.
    - Next to each genre in the list, show whether the owner has it approved,
      and at which level / tier (`approved_by_level`).
    - If the API refuses because the genre is in the other tier / at another
      level: show its message, and offer "העבר". It resends with
      `move: true`, after a confirmation.
  - A swap icon on a chip → the same list → `replace_genre`.
  - "כיוון חדש" → choose approved genres of one tier / level →
    `new_direction`.
  - A trash icon → `delete_direction`, after a confirmation.
  - **"בטל שינוי אחרון":** shown while `last_change.source === "admin"`,
    labelled with the change's summary → `undo`.
- **A fixed note:** "השינויים חלים מהבנייה הבאה. כדי לשנות את הפלייליסטים של
  היום — 'בנה מחדש את היום' בלוח היומי".
- **When `editable` is false:** "בעל העסק עוד לא בחר סוג פלייליסטים".

**Tab 5 — לוח יומי** (items 5, 6, 11), from `/daily-picks` (5.4):

- **A grid:**
  - rows = days. The default is 7 days back to 14 ahead, with back / forward
    buttons that change `from`;
  - columns = the slots. Option 1: the 4 playlist names. Option 2: Daily Mix
    #1 and #2, each cell listing its levels;
  - today highlighted; days the venue is closed (`open === false`) greyed out.
- **Past days, and today once built** (`built`):
  - each cell shows what played (the direction title + its genres; Option 2
    per level), how many opens, a "הוחלף" tag on replaced playlists, and a
    link to Spotify;
  - Option 1: a small tag when the owner changed that playlist's energy for
    the day ("יותר אנרגטי היום" / "פחות אנרגטי היום", from
    `played.energy.today_only`, see 5.2 `daily`);
  - this is the day-by-day view of items 5 and 6.
- **Future days** (`planned`):
  - Option 1 cells nobody picked: "אקראי";
  - Option 2: the rotation;
  - picked cells highlighted with "נבחר ידנית" and an × that clears them.
- **Picking:** a click on a future cell (or today's, before it's built) opens
  a list of the matching directions from `library`, then sends `set`:
  - Option 1: the directions of the same tier;
  - Option 2: one picker per level, listing that level's directions.
- **Today's row: "בנה מחדש את היום"**:
  1. A confirmation that explains: the owner's playlists for today are
     replaced now; it takes 30–90 seconds; it doesn't count toward the
     owner's 2 replacements a day.
  2. A spinner while it runs.
  3. The result: how many were built or failed, with links to the new
     playlists.
  - Disabled when `phase` is `closed` or `after-close`.

**Tab 6 — קליקים** (item 6), from `clicks`:

- One block per day, newest first: the date, the total opens, and each
  opened playlist (name, time, count).
- **Optional:** a heat map of days × playlist names (from
  `daily[].playlists[].opens`).
- **On top:** the total, and the counts per source.

**Tab 7 — צ'אט הטעם** (item 7), from `taste_chat`:

- **The conversation**, as chat bubbles: the owner on the right, Rubin on the
  left, with times.
  - Assistant messages with a `proposal` show its `summary_he`, plus a "הוחל"
    badge when it has `applied_at`.
- **Next to it, the changes timeline** (`changes`):
  - each change's date and `summary_he`;
  - a "בעל העסק" / "אדמין" badge by `source`;
  - "בוטל" when `undone_at` is set;
  - optionally, an expandable before / after.

**Tab 8 — בקשות מיוחדות** (item 8), from `special_requests`:

- **One row per request:** date, name, description, and what it was built
  from (`genre_source`: `daily` → "הסגנונות היומיים", `event` → "ז'אנרים
  לאירוע"). Then the playlist link, its track count and opens.
- **Collapsed below:** the deleted requests, and the chat transcript.

**Tab 9 — טכני** (collapsed by default):

- the build log (`outcome` as a badge);
- the settings changes;
- the admin actions log;
- this business's AI cost (per label, plus the calls);
- the cleanup backlog, with a warning if it isn't empty;
- every playlist, each with an expandable track list: `track_ids` as Spotify
  links, and each song's genre from `track_genres`.

### 1.4. Page C — קופונים (item 12), from `/coupons` (5.5)

- **When `coupons_enabled` is false,** a banner: "קופונים כבויים באתר —
  אפשר ליצור קודים מראש, הלקוחות לא יראו את שדה הקופון עד שיופעלו".
- **The table:**
  - code, percent, first month ₪ (`first_month_ils`), note, created;
  - an on / off switch (`PATCH`; confirm before switching off);
  - uses paid / pending, and the last use.
- **The create form:**
  - code (shown in uppercase as typed; letters, digits, `_` or `-`),
    percent (1–99) and note → `POST`;
  - a live line: "₪X בחודש הראשון, ואז ₪200 לחודש", where
    X = 200 × (100 − percent) / 100.

### 1.5. Page D — עלויות AI, from `/gemini-spend` (5.6)

- **Totals:** all-time (including the baseline) and this month.
- **Charts:**
  - monthly bars (`by_month_google`);
  - daily bars for the last 30 days (`by_day_google`).
- **Tables:**
  - by feature (`by_label`), with friendly names: onboarding, taste profile,
    building playlists, taste chat, special playlists, internal tools;
  - by business (`by_business`), with links to the business pages;
  - the recent calls.
- **"השוואה לחשבון של גוגל":** two dates → `range`, to match against Google
  Cloud's billing report. That report counts days in Pacific time, as
  `range` does.
- `notes` as a footnote.

### 1.6. Done when

- [ ] The app is deployed only to `sonic-brand-preview`, behind a login, and
      the key never reaches the browser (check the network tab).
- [ ] 1 — the name is on the list and in the business page header.
- [ ] 2 — the description, atmospheres, emphases, Round 2 text, place and
      hours are on the onboarding tab.
- [ ] 3 — the swipe cards with liked / disliked, or the genre tally for older
      accounts.
- [ ] 4 — the approved genres by energy level, with requested genres and
      weights marked.
- [ ] 5 — the direction library, plus what each day's playlists played (the
      daily grid).
- [ ] 6 — opens per day and per playlist.
- [ ] 7 — the taste-chat conversation and its changes.
- [ ] 8 — the special requests with their playlists and opens.
- [ ] 9 — paid or not, when, how much, the coupon, the subscription state.
- [ ] 10 — add / remove / replace a genre in a direction, new / delete
      direction, undo. Every response's warnings are shown.
- [ ] 11 — pick a direction for a future day, see it in the grid, clear it;
      "rebuild today" with a confirmation and a spinner.
- [ ] 12 — create a coupon, see its uses, switch it off.

---

## 2. Base URL

```
https://robin-music.com
```

`https://sonic-brand.vercel.app` is the same deploy under another name.
Use `robin-music.com`.

---

## 3. Authentication and conventions

Every request carries the shared key, as either header:

```
Authorization: Bearer <INTERNAL_ADMIN_API_KEY>
x-internal-admin-key: <INTERNAL_ADMIN_API_KEY>
```

Roni sends the key separately. **Never commit it.** Missing key → `401`,
wrong key → `403`, server not configured → `500`.

- **CORS:** `Access-Control-Allow-Origin: *`, methods
  `GET, POST, PATCH, DELETE, OPTIONS`, headers
  `Authorization, x-internal-admin-key, Content-Type`.
- **Bodies:** `POST` / `PATCH` take JSON (`Content-Type: application/json`).
- **Errors:** every error is JSON `{ "error": "…" }`, sometimes with a
  machine-readable `code`. Show `error` to the admin; it's written to be
  read (English).
- **No caching:** every response is `Cache-Control: no-store`.
- **No rate limit**, but don't poll faster than every few seconds.
- **Times** (`*_at`) are UTC ISO strings. **`il_date`** is a calendar date
  `YYYY-MM-DD` in Israel time. For daily playlists it's the **business
  day**: a venue open 20:00–02:00 has one business day that runs past
  midnight.
- Hebrew text (names, descriptions, chat messages) comes as-is (RTL).

---

## 4. Concepts you need

**Playlist type (`delivery_mode`).** Each owner picks one after signing up:

- **Option 1** (`option1`) — 4 playlists a day, with fixed names:
  "אנרגיה גבוהה #1", "אנרגיה גבוהה #2" (high energy) and "אנרגיה רגועה #1",
  "אנרגיה רגועה #2" (calm).
- **Option 2** (`option2`) — 2 playlists a day, "Daily Mix #1" and
  "Daily Mix #2". Their energy follows a curve the owner drew over the day
  (`delivery.timeline`).
- `null` = the owner hasn't picked yet, so nothing is built.

**Taste profile.** Built at signup from the owner's swipes: the genres
they're likely to enjoy (**approved**), each at an **energy level** from 1
(calmest) to N. N (`energy_levels_total`, 2–6) is set per owner, and
levels are relative to that owner's taste. In Option 1, the upper half of
the levels is the **high tier** and the rest the **calm tier**.
**Requested** genres are ones the owner explicitly asked for (super-liked or
named in their text). They sit in the directions that suit them, and the
day's playlists are picked so that at least one of them plays a direction
holding each requested genre (both options, since 2026-10-26).

**Directions** (called "recipes" in some places). A direction is a blend of
genres that sound good together. Each business has a library of them:

- **Option 1** — up to 30, each `high` or `low`. Keys `H1`, `H2`… (high)
  and `C1`, `C2`… (calm).
- **Option 2** — per energy level. Key `L2-1` = level 2, first direction.
- Only the library of the CURRENT type builds playlists (`directions.in_use`).
  The other one is rebuilt automatically when the owner switches type, so
  it can't be edited.
- ⚠️ **Keys are positions, not ids.** Deleting `H2` renumbers `H3` → `H2`,
  and every change rewrites the library (new `id`s). Always use the keys
  from the latest response. Every write returns a fresh list.

**How each day's directions are chosen** (unless you pick them, see 5.4):

- **Option 1:** each tier's #1 is a random direction of that tier; #2 is the
  one least like it.
- **Option 2:** each level's directions take turns by date. Mix #1 and
  Mix #2 play different ones.
- The songs themselves are drawn fresh every day, avoiding the last 7 days.

**Slots** — the playlist positions you can pick a direction for:

- **Option 1:** `high-1`, `high-2`, `low-1`, `low-2`.
- **Option 2:** `mix-1:L3` = energy level 3 of Daily Mix #1.

**When playlists are built.** A scheduled job runs every hour. It builds a
business's day at the first run that's at most 2 hours before opening. The
owner can also build or replace them from their dashboard (at most 2
replacements a day). Playlists disappear from the owner's dashboard 2
hours after closing.

**"Today only" energy (Option 1, since 2026-10-21).** Under each of the 4
playlists the owner has three circles: calmer / as usual / more energetic.
Once a day, for one playlist, they can move it one step (two at the edge of
the scale). The songs inside the SAME Spotify playlist are swapped: songs
that fit the new range stay, the rest are replaced. Tomorrow it's back to
usual; nothing in the taste profile changes.

**Names.** Spotify playlist names carry the date ("<business> · אנרגיה
גבוהה #1 · 21.10.2026"). Since 2026-10-22 the owner's dashboard shows the
name only ("אנרגיה גבוהה #1"). In the API, `name` is the name and `label`
keeps the date.

---

## 5. Endpoints

Typical flow: list businesses (`/users`) → open one (`/business?id=`) →
act through `/directions`, `/daily-picks`, `/coupons`. Site-wide Gemini
costs are in `/gemini-spend`.

### 5.1. `GET /api/internal/users`

One row per business, newest first. No parameters.

```json
{
  "count": 13,
  "businesses": [{
    "business_id": "68859010-…",
    "name": "הרצל 16",
    "version": "v7",
    "owner_id": "5ee91ee4-…",
    "owner_email": "owner@example.com",
    "email_verified": true,
    "last_sign_in_at": "2026-10-05T10:39:00Z",
    "created_at": "2026-10-05T10:37:39Z",
    "has_prompt": true,
    "delivery_mode": "option1",
    "approved_genre_count": 44,
    "payment_status": "no-payment",
    "paid_at": null,
    "subscription_status": null,
    "last_daily_built_at": "2026-10-13T05:03:07Z",
    "opens_7d": 4,
    "opens_total": 6,
    "last_opened_at": "2026-10-08T11:29:49Z",
    "special_requests_total": 0,
    "taste_chat_messages": 0
  }]
}
```

- `payment_status` — `paid`: a real payment exists. `no-payment`: the owner
  signed up while payments were switched off (true of every account until
  payments go live in production).
- `paid_at` — the first real payment, or `null`.
- `subscription_status` — `active`, `cancelled` (still running until the
  paid month ends), `ended`, or `null` (no payment).
- `opens_*` — clicks on "▶ פתח" in the owner's dashboard (daily and special
  playlists together).
- `taste_chat_messages` — messages the owner wrote in the taste chat.

### 5.2. `GET /api/internal/business?id=<business_uuid>`

Everything about one business. `404` if not found. It returns every
playlist ever built with its full track list, so expect a few hundred KB
and 3–6 seconds.

Top-level keys, in order: `business`, `onboarding`, `taste_profile`,
`delivery`, `directions`, `daily`, `daily_picks`, `clicks`, `taste_chat`,
`special_requests`, `payment`, `settings_changes`, `build_log`,
`admin_actions`, `gemini_spend`, `gemini_calls`, `cleanup_backlog`,
`playlists`, `legacy_v6`.

#### `business` — item 1

```json
{ "id": "…", "name": "הרצל 16", "version": "v7", "owner_id": "…",
  "owner_email": "owner@example.com", "email_verified": true,
  "last_sign_in_at": "…", "created_at": "…", "paid_at": "…" }
```

`paid_at` here is a raw database field: for accounts that signed up while
payments were off, it's just the signup time. Use `payment` (below) to see
whether they really paid.

#### `onboarding` — items 2 and 3

```json
{
  "business_description": "בר יין שכונתי…",
  "musical_emphases": "הרבה פאנק, בלי מזרחית",
  "atmospheres": ["צעיר", "תוסס", "קליל"],
  "round2_emphases": null,
  "place": { "name": "…", "address": "…", "primary_type": "bar", "types": [], "editorial_summary": "…", "price_level": "…", "website_uri": "…", "vibe": {} },
  "hours": { "hours": { "0": { "open": "09:00", "close": "23:00" }, "6": { "closed": true } }, "longest_minutes": 840, "updated_at": "…" },
  "swipe": {
    "cards": [
      { "round": 1, "rank": 1, "title_en": "Groove Funk", "description_he": "…", "genres": ["Funk", "Afro Funk"], "verdict": "liked" },
      { "round": 1, "rank": 2, "title_en": "…", "description_he": "…", "genres": ["…"], "verdict": "disliked" }
    ],
    "genre_tally": [{ "genre": "Funk", "like": 1, "dislike": 0 }],
    "super_liked_genres": ["Funk"],
    "super_liked_tracks": [{ "spotify_id": "…", "created_at": "…", "deleted_at": null }]
  }
}
```

- `round2_emphases` — the extra text the owner may type when they liked
  fewer than 3 cards and got a second round.
- `hours.hours` — keys `0`–`6` are Sunday–Saturday. Each day is
  `{open, close}` or `{closed: true}`. A close earlier than the open means
  the venue closes after midnight.
- `swipe.cards` — the swipe deck: each card the owner saw (8 in round 1, up
  to 4 more in round 2) with its genres and what the owner did:
  - `verdict` is `liked`, `disliked` or `not-swiped`;
  - **`null` for accounts that signed up before 2026-10-13** — that was not
    saved before.
- `swipe.genre_tally` — exists for every account. Per genre: how many liked
  and disliked cards it was in. For older accounts, this is the only record
  of the swipes.
- `swipe.super_liked_*` — songs the owner super-liked on the cards, and their
  genres. `super_liked_genres` is `null` for accounts from before 2026-10-05.

#### `taste_profile` — item 4

```json
{
  "energy_levels_total": 4,
  "approved_by_level": [
    { "level": 1, "tier": "low", "genres": [{ "genre": "Bossa Nova", "weight": 1, "requested": false }] },
    { "level": 3, "tier": "high", "genres": [{ "genre": "Funk", "weight": 0.5, "requested": true }] }
  ],
  "approved_genres": [{ "genre": "Bossa Nova", "energy_level": 1 }],
  "conditional_genres": [{ "genre": "Trap", "energy_level": 4, "note_en": "…" }],
  "excluded_genres": ["…"],
  "requested_genres": ["Funk"],
  "rejected_genres": [],
  "genre_weights": { "Funk": 0.5 },
  "instrumentalness_preference": "none",
  "popularity_preference": "soft",
  "popularity_tiers": null,
  "reasoning_en": "…",
  "updated_at": "…",
  "portrait": { "text": "העסק:
…

אוהבים:
…", "source": "chat", "updated_at": "…", "versions": 3 },
  "portrait_history": [{ "text": "…", "source": "chat", "message_id": "…", "created_at": "…" }]
}
```

- `approved_by_level` — the approved genres grouped for display, with each
  level's Option 1 tier.
- `weight` — set by the owner through the taste chat: 0.25, 0.5, 1
  (normal), 1.5 or 2 = how often the genre plays.
- `conditional_genres` — "maybe" genres. **Not used** to build playlists.
- `excluded_genres` — every other genre in the catalog (132 in all).
- `rejected_genres` — genres the owner turned down in the taste chat.
- `portrait` (since 2026-10-21) — a short Hebrew portrait of the owner's
  musical taste: what they love, what they avoid, what their own words mean.
  The taste chat reads it on every reply.
  - `source`: `onboarding` = the first version, from the onboarding answers;
    `chat` = rewritten after the chat and the owner agreed on a change;
    `backfill` = written for an account from before portraits existed.
  - `null` until the first version is written.
  - `portrait_history` holds every version, newest first.
- Preferences (`none` / `soft` / `hard`):
  - `instrumentalness_preference` — prefer, or only allow, songs without vocals;
  - `popularity_preference` — prefer, or only allow, well-known songs;
  - `popularity_tiers` — Option 1 only: `{ "high": "hard", "low": "none" }`
    when the owner set well-known songs differently for the energetic and the
    calm playlists (through the taste chat); `null` = both follow
    `popularity_preference`.
  - With "only" (`hard`), a style that has too few well-known songs not played
    in the last 7 days plays its well-known songs first, then its other songs,
    so playlists stay full. Each daily playlist's `played.popularity` shows
    where that happened (see `daily` below).
- The whole object is `null` if the business has no profile.

#### `delivery`

```json
{ "mode": "option1", "mode_set_at": "…", "timeline": null,
  "energy_windows": { "high": [50, 80], "low": [30, 60], "custom": false } }
```

- `timeline` — Option 2's energy curve:
  `{version: 2, groups: [{days: [0–6], open, close, points: [{m, e}]}]}`.
  `m` = minutes from midnight; `e` = energy, 0–1.
- `energy_windows` — Option 1 only: the range of song energy (0–100) each
  tier draws from. `custom: true` = the owner moved it through the taste chat.
  The defaults are 50–80 (energetic) and 30–60 (calm; it was 20–50 until
  2026-10-21).

#### `directions` — item 5

```json
{
  "in_use": "option1",
  "option1": [{ "key": "H1", "id": "…", "energy_tier": "high", "rank": 1, "title_en": "Global R&B and Neo Soul Grooves", "genres": ["Neo Soul", "Rnb"], "created_at": "…" }],
  "option2": [{ "key": "L1-1", "id": "…", "energy_level": 1, "rank": 1, "title_en": "Late-Night Intimate Jazz", "genres": ["Late Night jazz"], "energy_range": [20, 50], "custom_range": false, "profile_key": "…", "created_at": "…" }],
  "option2_matches_profile": null
}
```

- `in_use` — the library that builds playlists (= `delivery.mode`).
- `title_en` — internal; owners never see it.
- `energy_range` — Option 2 only: the song-energy range that direction draws
  from (`custom_range: true` = changed through the taste chat).
- `option2_matches_profile` — whether the stored Option 2 library still fits
  the profile. If not, it's rebuilt when the owner switches to Option 2.
  `null` = there's no Option 2 library.

#### `daily` — items 5 and 6: the daily playlists, by business day (newest first)

```json
[{
  "il_date": "2026-10-13",
  "opens_total": 2,
  "playlists": [{
    "spotify_id": "4EoQ…", "url": "https://open.spotify.com/playlist/4EoQ…",
    "name": "אנרגיה גבוהה #1", "label": "אנרגיה גבוהה #1 · 13.10.2026", "slot": "high-1",
    "track_count": 146, "created_at": "…", "expires_at": "…",
    "live": true, "replaced": false, "opens": 1,
    "played": { "kind": "option1", "direction": { "direction_id": "…", "title_en": "Global Funk", "admin_pick": false }, "genres": ["Funk", "Afro Funk"],
                "energy": { "range": [60, 90], "today_only": { "usual": [50, 80], "direction": "more", "at": "…" } } }
  }]
}]
```

- `played` — what the playlist was made of:
  - **Option 1:** `{kind: "option1", direction, genres}`. `direction` is
    `null` for playlists built before 2026-10-13; their `genres` still show
    what they were made of.
  - **Option 2:** `{kind: "option2", source, by_level: [{level, id, title_en,
    genres, admin_pick}]}` — the direction each energy level played.
    `source: "level-genres"` = there was no library, so each level played all
    its genres.
  - `admin_pick: true` = chosen through `/daily-picks`.
  - `popularity` (since 2026-10-14; `null` unless the playlist was set to
    only well-known songs): Option 1 `{preference, applied}` — `applied: "soft"`
    on an "only" (`hard`) playlist = its styles had too few well-known songs
    not played in the last week, so it played those first and then others;
    Option 2 `{preference: "hard", hits_first: [genre]}` — the styles that did
    that in this mix.
  - `energy` (Option 1, since 2026-10-21; `null` for older playlists): the
    range of song energy (0–100) the playlist was made from, `range`.
    `today_only` is `null` unless the owner moved this playlist with the
    energy circles today: then `usual` is the range it normally uses,
    `direction` is `"more"` (more energetic) or `"calmer"`, and `at` is when.
    `range` is then the new one. Option 2 mixes have no `energy` field.
- `replaced` — taken off the owner's dashboard early, by the owner's
  "replace now" or a `rebuild_today`. The replacement is in the same day's
  list.
- `live` — still on the owner's dashboard.
- `opens` — "▶ פתח" clicks on this playlist.

#### `daily_picks` — item 11

The picks from today on, as stored (5.4 shows them as a calendar):

```json
[{ "il_date": "2026-10-14", "mode": "option1", "slot": "high-1", "title_en": "Global Funk", "genres": ["Funk", "Afro Funk"], "energy_range": null, "source_direction_id": "…", "created_at": "…" }]
```

#### `clicks` — item 6

```json
{
  "total": 6,
  "by_day": [{ "il_date": "2026-10-08", "total": 4,
               "playlists": [{ "spotify_id": "…", "label": "אנרגיה רגועה #1 · 08.10.2026", "kind": "daily", "count": 1, "times": ["…"] }] }],
  "by_playlist": [{ "spotify_id": "…", "label": "…", "count": 3, "last_opened_at": "…" }],
  "by_source": [{ "source": "home", "count": 6 }],
  "raw": [{ "id": 123, "spotify_id": "…", "source": "home", "opened_at": "…" }]
}
```

- `kind` — `daily`, `special` (a special-playlist request), or `unknown`
  (the playlist isn't in this business's records).
- `il_date` — the Israel date of the click.

#### `taste_chat` — item 7

"הטעם המוזיקלי שלכם" is the chat on the owner's dashboard where they say
what they think of the daily music.

```json
{
  "messages": [
    { "id": "…", "role": "user", "text": "יש יותר מדי פאנק", "created_at": "…", "proposal": null },
    { "id": "…", "role": "assistant", "text": "…", "created_at": "…",
      "proposal": { "kind": "taste", "state": "confirming", "summary_he": "…", "ops": [{ "op": "set_weight", "genre": "Funk", "weight": 0.5 }], "applied_at": "…" } }
  ],
  "changes": [
    { "id": 12, "source": "chat", "summary_he": "פחות פאנק", "ops": [], "delivery_mode": "option1", "before": {}, "after": {}, "applied_at": "…", "undone_at": null }
  ]
}
```

- `messages` — oldest first.
- `text` — what was said. For the assistant it's the reply; the raw model
  output stays on Rubin's side.
- `proposal` — the change the chat offered. `applied_at` is set once the
  owner confirmed it.
- `changes` — newest first: every change made to the profile or directions.
  - `source: "chat"` = the owner, through the chat;
  - `source: "admin"` = this API (`POST /directions`);
  - `before` / `after` = full snapshots;
  - `undone_at` set = undone.

#### `special_requests` — item 8

"צריכים משהו אחר היום?" is where the owner asks for a one-off playlist for
something happening today (2 a day at most).

```json
{
  "requests": [{
    "id": "…", "name": "ערב ג'אז", "description": "…", "genre_source": "event",
    "created_at": "…", "il_date": "2026-10-10",
    "playlists": [{ "spotify_id": "…", "url": "…", "label": "…", "track_count": 210, "genres": ["…"], "bpm_range": { "min": 80, "max": 120 }, "created_at": "…", "expires_at": "…", "opens": 2 }]
  }],
  "deleted": [{ "id": "…", "name": "…", "description": "…", "original_created_at": "…", "deleted_at": "…" }],
  "chat": [{ "id": "…", "role": "user", "text": "…", "proposal": null, "event_id": null, "created_at": "…" }]
}
```

- `genre_source` — `daily`: built from the owner's daily genres. `event`:
  built from genres chosen for the request.
- `playlists` — usually one; empty if the build failed.
- `deleted` — requests the owner deleted.
- `chat` — the whole chat, oldest first. `event_id` links a message to the
  request it produced.

#### `payment` — item 9

```json
{
  "status": "paid",
  "first_paid_at": "…", "last_paid_at": "…",
  "terminal": "production",
  "first_month_ils": 170, "monthly_ils": 200,
  "coupon": { "code": "WELCOME15", "percent_off": 15 },
  "subscription": { "status": "active", "next_charge_date": "2026-11-05", "cancelled_at": null, "ends_at": null, "cancel_reason": null },
  "checkouts": [{ "id": "…", "order_no": 12, "hyp_env": "production", "status": "paid", "email": "…", "coupon_code": "WELCOME15", "percent_off": 15, "amount_first": 170, "amount_monthly": 200, "paid_at": "…", "created_at": "…", "billing": { "name": "…", "address": "…", "invoiceBusinessName": "…", "taxId": "…", "invoiceEmail": "…" }, "hyp_trans_id": "…", "hyp_hk_id": "…" }]
}
```

- `status` — `paid` or `no-payment` (signed up while payments were off; then
  `subscription` is `null`).
- `terminal` — `production` = real money. `test` = Hyp's test terminal, used
  in development.
- `last_paid_at` — later than `first_paid_at` only after a renewal.
- `first_month_ils` / `monthly_ils` — in shekels.
- `subscription.status` — `active`, `cancelled` (runs until `ends_at`) or
  `ended`.
- `next_charge_date` — calculated (monthly, on the day of the first payment).
  Hyp doesn't report the monthly charges, so a failed card won't show here.
- `checkouts` — every payment attempt, including unfinished (`pending`) and
  `failed` ones.

#### The rest

- `settings_changes` — owner changes to the name, opening hours, playlist
  type and energy curve, plus each "replace today's playlists". Fields:
  `{field, before, after, changed_at}`. Field
  `daily_playlists_replaced_by_admin` = a `rebuild_today`. Field
  `daily_energy_nudge` (since 2026-10-21) = the owner moved one playlist's
  energy for the day: `before` / `after` = `{playlist, window: [min, max]}`
  (`after` also has `kept` and `added`, the songs kept and swapped in).
- `build_log` — last 60 days: what happened each time the daily playlists
  were built, or why they weren't.
  - Fields: `{il_date, source, outcome, built, failed, detail}`.
  - `source`: `cron` (the hourly job), `dashboard` (the owner) or `admin`
    (this API).
  - `outcome`: `built`, `partial`, `zero-built`, `nothing-to-build:<reason>`, …
- `admin_actions` — the last 200 writes made through this API for this
  business.
- `gemini_spend` / `gemini_calls` — the AI cost of this business and every
  AI call (see 5.6 for what the numbers mean).
- `cleanup_backlog` — expired playlists whose removal from Spotify keeps
  failing. Normally empty.
- `playlists` — every playlist row, newest first, daily and special:
  - fields: `spotify_id, url, label, ico, track_count, genres, bpm_range,
    event_id, direction_id, track_ids, track_genres, expanded_at,
    expires_at, created_at, kind, played`;
  - `track_ids` — the songs in order. This is the only record of an expired
    playlist's songs (Spotify's copy is emptied);
  - `track_genres` — `{spotify_id: [genre]}`, which genre each song came in
    through;
  - `kind` — `daily` or `special`.
- `legacy_v6` — the pre-v7 product's fields: `onboarding_expanded`,
  `monthly_credits`, `credits_remaining`, `directions`, `direction_changes`.
  Empty for every current business. Kept so nothing from v1 is lost.

### 5.3. Directions — item 10

#### `GET /api/internal/directions?id=<business_uuid>`

What a direction editor needs:

```json
{
  "business_id": "…", "mode": "option1", "N": 4, "editable": true,
  "directions": [ /* the library in use, as in /business → directions */ ],
  "approved_by_level": [ /* as in /business → taste_profile */ ],
  "option1": [], "option2": [], "option2_matches_profile": null,
  "energy_windows": { "high": [50, 80], "low": [20, 50], "custom": false },
  "genre_catalog": ["Acid Jazz", "…"],
  "last_change": { "id": 12, "source": "admin", "summary_he": "…", "applied_at": "…" }
}
```

- `editable` — `false` until the owner has picked a playlist type.
- `genre_catalog` — all 132 genre names, spelled exactly as the API expects
  them. Offer only these.
- `last_change` — the newest change (`null` if none). Undo is possible only
  when it's an admin change (see `undo` below).

#### `POST /api/internal/directions`

Body: `{ "business_id": "…", "action": "…", …fields }`. It edits the
library **in use**. Every success returns `{ok, applied, notes, warnings}`
plus the fresh GET fields (minus `genre_catalog` / `last_change`). Show
`warnings` and `notes` to the admin.

| action | fields | does |
|---|---|---|
| `add_genre` | `direction`, `genre`, `energy_level?`, `move?` | adds a genre to a direction |
| `remove_genre` | `direction`, `genre` | removes a genre (a direction left empty is deleted) |
| `replace_genre` | `direction`, `genre`, `with`, `energy_level?`, `move?` | swaps `genre` for `with` |
| `new_direction` | `genres[]`, `title_en?`, and `tier` (`high`/`low`, Option 1) or `energy_level` (Option 2) | adds a direction made of approved genres |
| `delete_direction` | `direction` | deletes a direction |
| `undo` | — | reverts the newest admin change (see below) |

`direction` is a key from the latest response (`"H2"`, `"C1"`, `"L3-2"`).

**Adding a genre the owner doesn't have.** A direction can only play the
owner's approved genres, so adding a genre the profile lacks approves it:

- **Option 1:** at `energy_level` if you send one (it must be a level of the
  direction's tier), else the middle level of the direction's own genres.
- **Option 2:** at the direction's level.

**A genre the owner has, but in the other tier / at another level.** It's
refused (`400`, the message says where the genre is) unless you send
`"move": true`. Moving it also takes it out of the directions of its old
tier / level, which changes other playlists — confirm with the admin first.

**Requested genres.** A requested genre (the owner super-liked it or named it
in their emphases) sits only in the directions it suits, like any other genre,
and at least one of the day's playlists plays a direction that holds it. So
removing it from a direction DOES change what plays, and if it leaves the
genre with no direction at all, the server gives it one of its own. The
response warns about this. (Until 2026-10-26, Option 1 added every requested
genre to every playlist of its tier and Option 2 ignored them.)

**Pairing rules (since 2026-10-21).** Some genres may only share a
direction with certain others:

- `Electronic R&B`: only with house genres, `Nu Disco` or `Indie Dance`;
- `DownTempo`, `French DownTempo`, `Latin DownTempo`: only with each other;
- `LoFi Beats`, `Desi LoFi`, `LoFi Bossa`: only with each other.

Requested genres are NOT exempt (they were in Option 1 until 2026-10-26,
while they went into every playlist of their tier).

An `add_genre`, `replace_genre` or `new_direction` that would break one of
these is refused: `400`, with the rule in `dropped[].reason`, e.g.
`"would break a pairing rule (LoFi only with LoFi)"`. Show that reason to the
admin. Requested genres (Option 1) don't count, since every direction of
their tier holds them anyway.

**Undo.** Reverts the newest admin change, but only while it's also the
newest change overall. If the owner changed something through the taste
chat after it, you get `409` `nothing-to-undo`: undoing would also wipe out
the owner's change. The owner's own "undo" in the chat never reverts admin
changes.

**When changes apply.** From the next build (normally tomorrow). To change
today's playlists, call `rebuild_today` (5.4).

**Errors:**

- `400` — bad input, with the reason. `{error: "nothing changed", dropped}`
  = the change didn't fit; `dropped` lists why.
- `409` — `code` is one of:
  - `not-ready` — no profile, or no playlist type picked;
  - `nothing-to-change`;
  - `nothing-to-undo`.

Example:

```json
POST /api/internal/directions
{ "business_id": "…", "action": "replace_genre", "direction": "H2", "genre": "Disco", "with": "Latin Funk" }
```

### 5.4. Daily picks — item 11

Normally the builder chooses each day's directions (section 4). A **pick**
overrides that for one slot on one business day.

- **Option 1:** pick #1 only, and #2 is chosen as the direction least like
  your pick. Pick both to control both.
- **Option 2:** you pick a direction per energy level of each mix. Levels you
  don't pick follow the rotation.
- **The pick stores a copy of the direction's genres**, so later edits to the
  direction don't change it. Genres the owner no longer has approved are
  dropped when the playlist is built. A pick left with no genres is ignored.

#### `GET /api/internal/daily-picks?id=<business_uuid>[&from=YYYY-MM-DD][&days=N]`

A calendar. The default runs from 7 days back to 14 days ahead (`days`
max 60).

```json
{
  "business_id": "…", "mode": "option2", "today": "2026-10-13", "phase": "open",
  "slots": [{ "slot": "mix-1:L1", "name": "Daily Mix #1 · level 1", "mix": 1, "level": 1 }],
  "library": [ /* the directions in use, with keys */ ],
  "days": [{
    "il_date": "2026-10-14", "is_today": false, "is_past": false, "open": true,
    "built": [ /* that day's playlists, as in /business → daily[].playlists */ ],
    "picks": [ /* that day's pick rows */ ],
    "planned": {
      "mix-1": [{ "level": 1, "source": "rotation", "key": "L1-2", "title_en": "…", "genres": ["…"] },
                { "level": 3, "source": "pick", "key": "L3-1", "title_en": "…", "genres": ["…"] }],
      "mix-2": [ … ]
    }
  }]
}
```

- `phase` — today's state at the venue: `before-open`, `open`,
  `after-close` or `closed`.
- `open` — whether the venue opens that day (`null` = no opening hours).
- `built` — past days, and today once built.
- `planned` — today until it's built, and future days:
  - **Option 1:** `{"high-1": {name, source: "pick", title_en, genres}, …}`,
    or `{name, source: "random", note: "drawn at build time"}` for an
    unpicked slot (random, so it can't be shown in advance);
  - **Option 2:** the exact plan per mix and level, `source: "pick"` or
    `"rotation"`. Exact as long as the library doesn't change before then.

#### `POST /api/internal/daily-picks`

| action | fields | does |
|---|---|---|
| `set` (Option 1) | `date`, `slot` (`high-1`…`low-2`), `direction` (`H…` for high slots, `C…` for calm) | picks a direction for that playlist that day |
| `set` (Option 2) | `date`, `mix` (1 or 2), `direction` (`L3-2`) | picks it for its level of that mix that day |
| `clear` | `date`, `slot?` | removes one pick, or the whole day's |
| `rebuild_today` | — | rebuilds today's playlists now, with today's picks |

- **`date`** — the Israel business day: today, or up to 60 days ahead.
- **`set` / `clear`** return `{ok, slot?, warnings}` plus that day's calendar
  entry (`days[0]`).
- **A pick for today when today's playlists are already built** changes
  nothing until you call `rebuild_today`. The response warns about it.
- **`rebuild_today`:**
  - Replaces today's live playlists, or builds them if there are none.
  - Takes **30–90 seconds**; show a spinner and don't retry while it runs.
  - Returns `{ok, replaced, built, failed, playlists: [{spotify_id, label,
    url, track_count}], failures}`.
  - The owner sees the new playlists the next time their dashboard loads.
    Old ones disappear from the dashboard, but a phone already playing one
    isn't cut off.
  - Doesn't count toward the owner's 2 replacements a day.
  - Refused with `409`: `closed-today` or `past-close` (the venue isn't open
    today, or has closed), `build-in-progress`, or `nothing-to-replace`.
    `402` `subscription_ended` if the subscription has ended.
  - Spotify calls are real: don't call it in a loop.
- **Errors:**
  - `400` — bad input: a slot from the other playlist type, a direction from
    the wrong tier, or a past date;
  - `409` `not-ready` — the owner hasn't picked a playlist type;
  - `501` — the database update for this feature hasn't been applied yet
    (ask Roni).

### 5.5. Coupons — item 12

A coupon takes a percentage off the **first month only**. Every later month
is full price (₪200). The owner types the code on the payment screen.

⚠️ Coupons only work where Rubin's `V7_COUPONS_ENABLED` switch is on.
`coupons_enabled` in the response tells you whether it's on for the site
you're calling. If it's off, the payment screen doesn't show the coupon
field at all, and you can create codes ahead of time.

#### `GET /api/internal/coupons`

```json
{
  "coupons_enabled": false,
  "monthly_price_ils": 200,
  "coupons": [{ "code": "WELCOME15", "percent_off": 15, "active": true, "note": "launch", "created_at": "…",
                "first_month_ils": 170, "uses_paid": 3, "uses_pending": 1, "uses_failed": 0, "last_used_at": "…" }]
}
```

- `coupons` — newest first.
- `uses_paid` — payments made with the code.
- `uses_pending` — payment screens opened with it but not paid (yet).

#### `POST /api/internal/coupons` — create

```json
{ "code": "WELCOME15", "percent_off": 15, "note": "launch campaign" }
```

- `code`: 3–32 characters, letters, digits, `_` or `-`; stored uppercase.
  Owners can type it in any case.
- `percent_off`: a whole number from 1 to 99. 100% (a free first month) is
  refused until it has been tested with the payment provider.
- Returns `201 {ok, coupon, warning?}`, or `409` if the code exists.

#### `PATCH /api/internal/coupons` — switch off / on, change the note

```json
{ "code": "WELCOME15", "active": false }
```

- The percentage can't change, and coupons can't be deleted (payments point
  at them). To change a discount, switch the code off and create a new one.

### 5.6. `GET /api/internal/gemini-spend[?from=YYYY-MM-DD&to=YYYY-MM-DD]`

The AI (Google Gemini) cost of the whole site.

```json
{
  "totals": {
    "all_time_usd": 20.45, "baseline_usd": 9.19, "since_logging_usd": 11.26, "all_time_calls": 609,
    "attributed_usd": 2.29, "attributed_calls": 139,
    "abandoned_usd": 3.71, "abandoned_calls": 188,
    "unattributed_usd": 5.25, "unattributed_calls": 282,
    "tokens": { "input": 2817795, "cached": 0, "output": 416803, "thinking": 2022400 }
  },
  "range": { "from": "2026-10-01", "to": "2026-10-12", "usd": 1.43, "calls": 97 },
  "by_month_google": [{ "month": "2026-10", "usd": 1.78, "calls": 134 }],
  "by_day_google": [{ "day": "2026-10-13", "usd": 0.36, "calls": 37 }],
  "by_day": [{ "day": "2026-10-13", "usd": 0.36, "calls": 37 }],
  "by_label": [{ "label": "v7-taste-profile", "usd": 0.88, "calls": 23 }],
  "by_business": [{ "business_id": "…", "business_name": "…", "owner_email": "…", "usd": 0.15, "calls": 6 }],
  "recent": [ /* the last 50 calls */ ],
  "notes": ["…"]
}
```

- **The totals:**
  - `baseline_usd` — Google's bill from before per-call logging started
    (2026-08-25), as one lump sum;
  - `attributed` — calls of an existing business;
  - `abandoned` — onboardings that never signed up;
  - `unattributed` — Rubin's internal prompt-tuning tools, tests, and
    deleted test accounts.
- **Days and months:**
  - `*_google` and `range` use **Pacific time**, the way Google's billing
    report counts days, so they can be compared line by line;
  - `by_day` uses Israel time;
  - both `by_day` lists cover the last 120 days.
- **`?from` / `?to`** (Pacific dates) add `range`: the total for that period,
  to match against Google's bill.
- **`by_label`** — which feature spent it:
  - onboarding: `v7-onboarding`, `v7-onboarding-refined`, `v7-taste-profile`;
  - building direction libraries: `v7-energy-directions`, `v7-level-directions`;
  - chats: `v7-taste-chat`, `v7-event-chat`, `v7-event-playlist`;
  - Rubin's internal prompt-tuning tools: `ami-*`.
- **How a cost is worked out:** Google's published per-token price × the
  token counts Google returned for that call. Since 2026-10-13, prompt text
  Google re-serves from its cache is billed at a tenth of the price.
  Before that it was counted at full price, so costs from before then run
  slightly high (at most ~17%).
- **Not included:** taxes, and any use of the same Google account outside
  Rubin.
- The response's `notes` say all this in short.

---

### 5.7. `/api/internal/taste-bench` — not for the console

Used by Ami's prompt dashboard (its taste chat test bench, 2026-10-21). Your
dashboard doesn't need it. It loads the taste chat's context for one business
(GET `?id=`) and saves what Ami tried there (POST): taste changes, and sometimes a
switch of the playlist type. A switch is audited like the owner's own (`settings_changes`
`delivery_mode`). They're logged
like your direction edits (`business_taste_changes` with `source: "admin"`,
`admin_actions` `taste:bench_save`), so they appear in a business's
`taste_chat` changes and `admin_actions`.

## 6. Example client code

Server-side only (see 0.3). Node / a serverless function:

```js
const KEY = process.env.RUBIN_ADMIN_KEY;
const BASE = 'https://robin-music.com';

async function api(method, path, body) {
  const r = await fetch(`${BASE}/api/internal/${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error || r.status), { status: r.status, data });
  return data;
}

const { businesses } = await api('GET', 'users');
const biz = await api('GET', `business?id=${businesses[0].business_id}`);

// Swap a genre in direction H2
await api('POST', 'directions', { business_id: biz.business.id, action: 'replace_genre', direction: 'H2', genre: 'Disco', with: 'Latin Funk' });

// Play direction H3 in "אנרגיה גבוהה #1" tomorrow
await api('POST', 'daily-picks', { business_id: biz.business.id, action: 'set', date: '2026-10-14', slot: 'high-1', direction: 'H3' });

// New coupon
await api('POST', 'coupons', { code: 'WELCOME15', percent_off: 15, note: 'launch' });
```

curl:

```bash
curl -s -H "Authorization: Bearer $RUBIN_ADMIN_KEY" https://robin-music.com/api/internal/users | jq
```

---

## 7. Common pitfalls

- **Keys shift.** After any direction edit, use the `directions` from the
  response — never keys you cached before it.
- **One library at a time.** Edits and picks apply to the library in use. If
  the owner switches type, Option 1's library is rebuilt from scratch: admin
  edits to it are lost (the profile changes they made, such as an approved
  genre, stay).
- **Picks follow the type.** Picks are stored for one type. After a switch,
  they're ignored until the owner switches back.
- **Older accounts have less data.**
  - `swipe.cards` is `null` before 2026-10-13;
  - `played.direction` is `null` on Option 1 playlists before 2026-10-13;
  - `super_liked_genres` is `null` before 2026-10-05.
- **`business.paid_at` isn't proof of payment.** Use `payment.status`.
- **Expired playlists are included.** Use `live` / `expires_at` if you only
  want today's.
- **`rebuild_today` is slow and real.** 30–90 seconds, real Spotify
  playlists. One at a time per business; a second call gets `409`
  `build-in-progress`.
- **The business page is heavy** (every playlist's track list). Load it once
  per visit; after a write, refresh only the endpoint you wrote to.

---

## 8. Getting help

Anything unclear or missing? Ask Roni. Reminders from section 0: **don't
edit `api/internal/*` yourself**, **keep the key server-side**, and **deploy
the dashboard only to `sonic-brand-preview`.**

---

## 9. Changes from v1 (for a dashboard built on v1)

**`/users`:** the same fields, plus the new ones in 5.1.

**`/business` — where v1's fields went:**

| v1 field | v2 |
|---|---|
| `business.{id, name, owner_id, owner_email, created_at}` | the same |
| `business.{onboarding_expanded, monthly_credits, credits_remaining}` | `legacy_v6.*` (old product only) |
| `onboarding.{business_description, musical_emphases, atmospheres}` | the same, plus new fields |
| `place`, `hours` | `onboarding.place`, `onboarding.hours` |
| `directions` (old product) | `legacy_v6.directions`; today's directions are `directions.option1` / `option2` |
| `direction_changes` (old product) | `legacy_v6.direction_changes`; today's are in `taste_chat.changes` |
| `chat_transcript` | `taste_chat.messages`, with a readable `text` (no more JSON parsing) |
| `playlists` | the same, plus `kind` and `played` |
| `playlist_opens` | `clicks.raw` |
| `playlist_opens_summary.{total, by_playlist, by_source}` | `clicks.{total, by_playlist, by_source}` |
| `gemini_spend`, `gemini_calls`, `cleanup_backlog` | the same |

**`/gemini-spend`:**

- `by_day` is now in Israel time (was UTC) and covers 120 days (was 90).
- `totals` gains `unattributed_*` and `tokens`.
- New: `by_day_google`, `by_month_google`, `range` (with `?from` / `?to`)
  and `notes`.
- The totals now include every call. v1 would have stopped counting at
  1,000 calls (the log is at ~600).

**New endpoints:** `/directions`, `/daily-picks`, `/coupons`.
