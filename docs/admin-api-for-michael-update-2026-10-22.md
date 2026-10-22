# Rubin — Admin Dashboard: Update of 2026-10-22

> Give this to your Claude / AI coding assistant together with the
> document it already has ("Rubin — Admin Dashboard: Build Brief + API
> Reference (v2, 2026-10-13)"). It lists what changed in the API since that
> document and what to change in the dashboard. Everything here adds to the
> API: no endpoint, field or action was removed or renamed. One default
> value changed (section 3).
>
> The full document with these changes merged in is
> `docs/admin-api-for-michael.md` in Rubin's repo, if you'd rather replace
> your copy.

The ground rules of the original document still apply (deploy only to
`sonic-brand-preview`, don't modify Rubin's API code, keep the key
server-side).

---

## Checklist

- [ ] Tab 3 (טעם מוזיקלי): the owner's musical portrait (section 1).
- [ ] The daily playlists (calendar and lists): a tag on an Option 1 playlist
      the owner made more or less energetic for the day (section 2).
- [ ] The history (`settings_changes`): show the new `daily_energy_nudge`
      change (section 2).
- [ ] Remove any hard-coded "20–50" for the calm playlists; read
      `delivery.energy_windows` (section 3).
- [ ] Direction edits: show the reason when an edit is refused because of a
      pairing rule (section 4).
- [ ] Show playlist names without the date, as the owner sees them (section 5).
- [ ] If your copy doesn't mention `popularity_tiers` / `played.popularity`,
      add them too (section 8).

---

## 1. The owner's musical portrait (since 2026-10-21)

The taste chat keeps a short Hebrew text about each owner: what the business
is like, what they love and avoid, what their own words mean (e.g. "פאנקי" =
groove and drums), energy by time of day, and their recent agreed changes. The
chat reads it on every reply.

**API:** two new fields in `GET /api/internal/business` → `taste_profile`:

```json
"portrait": { "text": "העסק:\n…\n\nאוהבים:\n…", "source": "chat", "updated_at": "…", "versions": 3 },
"portrait_history": [{ "text": "…", "source": "chat", "message_id": "…", "created_at": "…" }]
```

- `source`: `onboarding` = the first version, written from the onboarding
  answers; `chat` = rewritten after the owner and the chat agreed on a change;
  `backfill` = written for an account from before portraits existed.
- `portrait` is `null` until the first version exists.
- `portrait_history` holds every version, newest first.

**Dashboard:** in Tab 3, a card **"הפורטרט המוזיקלי"**, open by default:
- the text as written: Hebrew, right-to-left, keeping its line breaks;
- when it was last updated and from what (`source`);
- earlier versions collapsed underneath.

---

## 2. "Today only" energy for one playlist (Option 1, since 2026-10-21)

Owners on 4 playlists a day now have three circles under each playlist:
calmer / as usual / more energetic.
- Once a day, for ONE playlist, they can move it one step. When its usual
  range is at the edge of the scale, it can move two steps.
- The songs inside the same Spotify playlist are swapped: songs that fit the
  new range stay, the rest are replaced. The Spotify link doesn't change.
- Tomorrow everything is back to usual, and the taste profile doesn't change.

**API — `daily[].playlists[].played`** (Option 1 only) has a new field,
`energy`:

```json
"played": { "kind": "option1", "direction": { "…": "…" }, "genres": ["Funk", "Afro Funk"],
            "energy": { "range": [60, 90], "today_only": { "usual": [50, 80], "direction": "more", "at": "…" } } }
```

- `range` — the range of song energy (0–100) the playlist was made from.
- `today_only` — `null` unless the owner moved this playlist with the circles
  that day. Then:
  - `usual` = the range it normally uses;
  - `direction` = `"more"` (more energetic) or `"calmer"`;
  - `at` = when they did it;
  - `range` is the new range.
- `energy` is `null` on playlists built before 2026-10-13. Option 2 mixes
  have no `energy` field.

**API — `settings_changes`** has a new field value, `daily_energy_nudge`:
- `before` = `{ playlist, window: [min, max] }`;
- `after` = `{ playlist, window: [min, max], kept, added }`, where `kept` and
  `added` are how many songs stayed and how many were swapped in;
- there's at most one per business per day.

**Dashboard:**
- **Daily calendar and day lists:** on a playlist with `today_only`, a small
  tag: "יותר אנרגטי היום" or "פחות אנרגטי היום".
- **History:** show a `daily_energy_nudge` row as, e.g., "שינה אנרגיה להיום:
  אנרגיה גבוהה #1 · יותר אנרגטי (נשארו 59 שירים, הוחלפו 27)".
  - The direction comes from comparing `after.window[0]` with
    `before.window[0]`: higher = more energetic.
  - `before.playlist` / `after.playlist` is the playlist name, without a date.
- Don't show the numeric ranges as the main text. Owners never see numbers;
  for the admin they can be secondary detail (e.g. a tooltip).

---

## 3. Calm playlists default to 30–60 (was 20–50), since 2026-10-21

The calm Option 1 playlists ("אנרגיה רגועה #1/#2") now take songs with energy
30–60 by default; the energetic ones stay at 50–80.

- `delivery.energy_windows` already reports the right values. Example for an
  owner who never changed them: `{ "high": [50, 80], "low": [30, 60], "custom": false }`.
- `custom: true` still means the owner moved them through the taste chat;
  those owners keep their own values.
- If the dashboard has "20–50" written anywhere, remove it and read
  `delivery.energy_windows`.

---

## 4. Pairing rules for direction edits (since 2026-10-21)

Some genres may only share a direction with certain others:
- `Electronic R&B`: only with house genres, `Nu Disco` or `Indie Dance`;
- `DownTempo`, `French DownTempo`, `Latin DownTempo`: only with each other;
- `LoFi Beats`, `Desi LoFi`, `LoFi Bossa`: only with each other.

**API — `POST /api/internal/directions`:**
- An `add_genre`, `replace_genre` or `new_direction` that would break one of
  these rules is refused with `400`, the rule in `dropped[].reason`, e.g.
  `"would break a pairing rule (LoFi only with LoFi)"`.
- Requested genres (Option 1) don't count, because every direction of their
  tier holds them anyway.
- `replace_genre` now checks the direction without the genre being replaced.
  So replacing e.g. `LoFi Beats` with `LoFi Bossa` inside a LoFi direction
  works.

**Dashboard:** when an edit comes back `400` with a `dropped[].reason`, show
that reason next to the direction instead of a generic error. A Hebrew
wording is fine, e.g. "לא ניתן: LoFi מתאים רק ל-LoFi".

---

## 5. Playlist names: the owner sees them without the date (since 2026-10-22)

- On Spotify, daily playlists are named "<business> · אנרגיה גבוהה #1 ·
  21.10.2026" (unchanged).
- On the owner's dashboard, the name now shows alone: "אנרגיה גבוהה #1",
  "Daily Mix #1".
- In the API nothing changed. `daily[].playlists[].name` is the name without
  the date, and `label` keeps it.

**Dashboard:** show `name` wherever a playlist appears inside a day (the day
is already shown). Use `label` only where a playlist appears out of the
context of its day, e.g. the full `playlists` list.

---

## 6. "Replace now": replaced playlists leave Spotify within the hour (since 2026-10-21)

When an owner (or your `rebuild_today`) replaces today's playlists:
- each old playlist is renamed "… (הוחלף)" on Spotify straight away;
- it's removed at the next half-hour cleanup. Before, it stayed until 2
  hours after closing.

In the API nothing changed (`replaced: true`, as before). The only visible
difference: the Spotify link of a replaced playlist stops working within the
hour. In the dashboard, show it as inactive, or hide the link on rows with
`replaced: true`.

---

## 7. Ami's test bench writes as an admin (since 2026-10-21)

Ami has a test bench for the taste chat in his prompt dashboard. It uses
`/api/internal/taste-bench`, which **your dashboard doesn't need**.

When he saves changes from it to a real business, they appear in the data
your dashboard already shows:
- `taste_chat` changes with `source: "admin"`;
- `admin_actions` with `action: "taste:bench_save"`;
- sometimes a `settings_changes` row `delivery_mode`, when he moved the
  business to the other playlist type.

Label `taste:bench_save` as "שינוי דרך ספסל הבדיקה של עמי" in the actions
list.

---

## 8. Only if your copy predates 2026-10-14: well-known songs per tier

If your document doesn't mention `popularity_tiers`, add these too.

- **`taste_profile.popularity_tiers`** — Option 1 only:
  `{ "high": "hard", "low": "none" }` when the owner set "well-known songs"
  differently for the energetic and the calm playlists (through the taste
  chat); `null` = both follow `popularity_preference`.
- **`daily[].playlists[].played.popularity`** — `null` unless the playlist
  was set to "only well-known songs":
  - Option 1: `{ preference, applied }`. `applied: "soft"` on an "only"
    (`hard`) playlist means its styles had too few well-known songs not
    played in the last week, so it played those first and then others.
  - Option 2: `{ preference: "hard", hits_first: [genre] }` — the styles that
    did that in that mix.
