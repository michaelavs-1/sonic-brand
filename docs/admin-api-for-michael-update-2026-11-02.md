# Rubin — Admin Dashboard: Update of 2026-11-02

> Give this to your Claude / AI coding assistant together with the
> document it already has ("Rubin — Admin Dashboard: Build Brief + API
> Reference") and the updates of 2026-10-22 and 2026-10-26.
>
> The onboarding's swipe step changed: the owner now swipes an **energetic
> deck** and then a **calm deck**, and the taste profile built from it has a
> **calm side and an energetic side**. A genre the owner liked on both decks
> (for example calm R&B and upbeat R&B) can be approved twice, once per side.
>
> **Nothing changes for existing accounts.** Their data is untouched, every
> new field is additive, and they read exactly as before. The new fields only
> carry information for accounts that sign up through the new onboarding.
>
> The full document with these changes merged in is
> `docs/admin-api-for-michael.md` in Rubin's repo, if you'd rather replace
> your copy.

---

## Checklist

- [ ] Swipe cards: group them by deck (energetic, then calm) when they carry
      a `deck` (section 1).
- [ ] Taste profile: when `two_sided` is true, label the halves of the scale
      as the calm side and the energetic side, and mark chips with
      `both_sides: true` (section 2).
- [ ] Direction edits: show the new refusal reasons (section 3).
- [ ] No action needed for `approved_genre_count` (section 4) — just know it
      counts genres, not entries.
- [ ] Re-onboarded businesses: show the archived earlier profiles, and the
      re-onboarding entry in the change log; the undo button can now get a
      `reonboard` refusal (section 5).

---

## 1. Swipe cards: two decks (`/business` → `onboarding.swipe.cards`)

**Until now:** 8 cards in round 1, and up to 4 more in round 2 when the
owner liked fewer than 3.

**From the new onboarding:**

- Round 1 is two decks of 6: the **energetic deck** first (ranks 1–6), then
  the **calm deck** (ranks 7–12). Each card played a song from its deck's
  energy range.
- **Round 2 is per deck:** a deck the owner liked fewer than 2 cards of gets
  4 more cards of the same energy (ranks 13–16 energetic, 17–20 calm). Up to
  20 cards in all.
- Each card has a new field, `deck`: `"energetic"` or `"calm"`.

```json
"cards": [
  { "round": 1, "deck": "energetic", "rank": 1, "title_en": "Upbeat Modern R&B", "description_he": "…", "genres": ["Rnb", "Latin RnB"], "verdict": "liked" },
  { "round": 1, "deck": "calm", "rank": 7, "title_en": "Smooth R&B & Modern Soul", "description_he": "…", "genres": ["Rnb", "Neo Soul"], "verdict": "liked" },
  { "round": 2, "deck": "energetic", "rank": 13, "title_en": "…", "description_he": "…", "genres": ["…"], "verdict": "disliked" }
]
```

- **Older accounts:** `deck` is `null` (or missing) on every card. Show
  them exactly as today.
- `onboarding.round2_emphases` keeps its meaning: the text the owner typed
  before the extra Round 2 cards. It's now asked when a deck got fewer than
  2 likes.

**What to change in the dashboard (Tab 2, "דק ההחלקות"):** when the cards
carry a `deck`, show two groups, "מוזיקה אנרגטית" (energetic) then "מוזיקה
רגועה" (calm). Inside each, show round 1 then round 2 with a divider, and
"אהב X מתוך Y" per group. Without `deck`, nothing changes.

## 2. Two-sided taste profiles (`/business` → `taste_profile`)

A new field, `taste_profile.two_sided` (boolean).

- **`false`** — every existing account, and a new owner who liked nothing on
  one of the two decks. The profile works as before: one entry per genre,
  levels relative to the owner's taste.
- **`true`** — the profile has sides:
  - **calm side** = the lower half of the levels (levels ≤ N/2, `tier: "low"`);
  - **energetic side** = the upper half (`tier: "high"`).
  - Energetic-deck likes built the energetic side, calm-deck likes the calm
    side, so in Option 1 the calm playlists come from the calm side and the
    energetic ones from the energetic side.

**A genre can be approved on both sides.** In a two-sided profile:
- `approved_genres` can list the same genre twice, at two levels, e.g.
  `{"genre":"Rnb","energy_level":4}` and `{"genre":"Rnb","energy_level":1}`;
- `approved_by_level` shows it at both levels;
- each chip in `approved_by_level[].genres[]` has a new boolean,
  **`both_sides`**: `true` when the genre is approved in both tiers.

```json
"two_sided": true,
"approved_by_level": [
  { "level": 1, "tier": "low",  "genres": [{ "genre": "Rnb", "weight": 1, "requested": true, "both_sides": true }, { "genre": "Fado", "weight": 1, "requested": false, "both_sides": false }] },
  { "level": 4, "tier": "high", "genres": [{ "genre": "Rnb", "weight": 1, "requested": true, "both_sides": true }] }
]
```

- **`weight` is one per genre**, shared by both sides (the same number shows
  on both chips).
- `both_sides` is always `false` for older profiles.

**What to change in the dashboard (Tab 3, "טעם מוזיקלי"):**

- When `two_sided` is true, label the rows by side ("צד רגוע" for the lower
  half, "צד אנרגטי" for the upper half), instead of, or next to, the Option 1
  tier labels. They're the same split.
- Mark chips with `both_sides: true` (e.g. ↕ with the tooltip "מאושר גם ברגוע
  וגם באנרגטי").
- If you show a count of approved genres, count distinct genres, not entries.

**The genres' sides.** Rubin's music curator gave every genre a side:
- calm only (e.g. Bossa Nova, Chamber music);
- energetic only (e.g. Hip Hop, Tech House);
- both ways (e.g. R&B, Flamenco, Rock).

In a two-sided profile, a calm-only genre is only ever on the calm side and an
energetic-only one only on the energetic side. The list isn't in the API; it
lives in Rubin's code. The refusals below say which rule applied.

## 3. Direction edits (`POST /api/internal/directions`) on a two-sided profile

Nothing changes in the request format. Two behaviours differ, only when the
business's `two_sided` is true:

- **Adding a both-ways genre to a direction of the other side** — e.g.
  `add_genre` of `Rnb` to a calm direction when R&B is approved only on the
  energetic side — no longer needs `move: true`. It approves R&B on the calm
  side as well (it then sits on both sides). The energetic directions keep it.
- **A calm-only genre can't go into an energetic direction, nor an
  energetic-only genre into a calm one.** The request answers `400`
  `nothing changed`, with the reason in `dropped[].reason`, e.g.:
  - `"calm-only genre — only the calm side (levels 1–2)"`
  - `"energetic-only genre — only the energetic side (levels 3–4)"`
  - `"already approved on that side"` (a move that would put a genre's two
    sides on the same side)

  Show the reason to the admin, as with the pairing-rule refusals. In
  Hebrew: "הז'אנר הזה רגוע בלבד" / "הז'אנר הזה אנרגטי בלבד".

For profiles with `two_sided: false`, direction edits behave exactly as
before.

**The change log.** In `taste_chat` (the owner's chat changes and the admin
changes), the stored `ops` may now include a `"tier"` on `remove_genre` /
`move_genre`, e.g. `{"op":"remove_genre","genre":"Rnb","tier":"low"}` = the
owner took R&B off the calm side only. `"high"` = the energetic side,
`"low"` = the calm side.

## 4. `/users` → `approved_genre_count`

It now counts **distinct genres**, so a genre approved on both sides counts
once. For every existing account the number is the same as before.

## 5. Re-onboarding and the profile archive

Rubin's team can now re-run the onboarding (the two decks) for an existing
business from an internal tool, and replace its taste profile with the
result. Before a profile is replaced, the whole old profile and both of its
direction libraries are saved in an archive.

**`/business` → `taste_profile.archived`** — new, newest first; `[]` when the
profile was never replaced (every business today):

```json
"archived": [
  {
    "id": 3, "archived_at": "2026-11-03T09:12:00Z", "reason": "reonboard", "source": "ami-dashboard",
    "delivery_mode": "option1", "energy_levels_total": 5, "two_sided": false,
    "approved_genres": [{ "genre": "Funk", "energy_level": 3 }],
    "profile": { "…": "the whole old business_taste_profiles row" },
    "option1_directions": [ /* the old Option 1 library rows */ ],
    "level_directions": [ /* the old Option 2 library rows */ ]
  }
]
```

**What to change in the dashboard (Tab 3, "טעם מוזיקלי"):** when `archived`
isn't empty, add a collapsed "פרופילים קודמים" list: date, and the approved
genres by level (`energy_levels_total` + `approved_genres`).

**The change log** (`taste_chat.changes`): a re-onboarding shows as one entry
with `source: "admin"`, a summary starting
`[admin · Ami's bench] re-onboarding — the previous profile is archived (#3)`,
and `ops` starting with `{"op":"reonboard","archive_id":3}`. The swipe cards
(`onboarding.swipe.cards`) are the new run's.

**Undo:** `POST /directions` `undo` can't revert a re-onboarding. When the
newest change is one, it answers `409` with `code: "reonboard"`. Show
"אי אפשר לבטל אונבורדינג מחדש — הפרופיל הקודם שמור בארכיון", and hide or
disable the undo button while the newest change is a re-onboarding.
