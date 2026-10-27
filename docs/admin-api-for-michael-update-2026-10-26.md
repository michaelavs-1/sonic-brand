# Rubin — Admin Dashboard: Update of 2026-10-26

> Give this to your Claude / AI coding assistant together with the
> document it already has ("Rubin — Admin Dashboard: Build Brief + API
> Reference") and the update of 2026-10-22. Two things changed: the MEANING
> of the requested genres, which shows up in the libraries and in one refusal
> (sections 1 and 2, no API change), and a NEW piece of data — the owner can
> now like or dislike each daily playlist, which adds fields to `/users` and
> `/business` (section 3).
>
> The full document with these changes merged in is
> `docs/admin-api-for-michael.md` in Rubin's repo, if you'd rather replace
> your copy.

---

## Checklist

- [ ] Wherever the dashboard explains the ★ requested genres, change the
      wording (section 1).
- [ ] Direction edits: adding a requested genre to a recipe can now be
      refused by a pairing rule, like any other genre (section 2).
- [ ] Show the owner's like / dislike per daily playlist, and what they
      wrote about it (section 3). Three new fields on the business list,
      a `feedback` key on every daily playlist, and a new
      `playlist_feedback` section on the business page.

---

## 1. A requested genre is no longer in every recipe

A requested genre is one the owner super-liked during onboarding or named in
their musical emphases (`taste_profile.approved_by_level[].genres[].requested`
is `true`, and the genre is in `taste_profile.requested_genres`).

**Until now:** Option 1 put every requested genre into EVERY recipe of its
energy tier, overriding the pairing rules, and Option 2 ignored requested
genres completely. That bolted a genre onto recipes it didn't belong in — one
venue's three requested genres sat in 8 of its 10 energetic recipes, next to
whatever else the recipe was about.

**From 2026-10-26:** a requested genre sits only in the recipes it genuinely
suits, like any other genre, and it must be in at least one recipe of its tier
(Option 1) or its level (Option 2). What makes it special is the DAILY PICK:

- **Option 1** — the day's two recipes per tier are chosen among the pairs
  that play the most of that tier's requested genres. So at least one of the
  day's playlists plays each of them.
- **Option 2** — after the usual daily rotation, one of the two mixes is moved
  onto a recipe that holds each requested genre of its level. (A requested
  genre is only heard if the day's energy curve reaches its level.)
- When a tier or level holds more requested genres than two recipes can carry,
  the day covers as many as it can and the rest come first on the days after.
  Nothing is forced into a recipe it doesn't fit.

**What to change in the dashboard:** nothing in the API calls. If your UI
explains the ★ / requested marker as "in every playlist of its tier", change
it to something like "נמצא בכל המתכונים שמתאימים לו, ולפחות אחד מהפלייליסטים
של היום מנגן מתכון שמכיל אותו".

Two things worth knowing when you read the data:

- Libraries built before 2026-10-26 still have the requested genres in every
  recipe. They look that way until the business's library is regenerated.
- `GET /daily-picks` already predicts Option 2's rotation through the same
  coverage move, so its `planned` rows stay accurate. Option 1's unpicked
  slots still read `source: "random"` — the draw is random among the pairs
  that cover the requested genres.

## 2. Direction edits: requested genres follow the pairing rules now

`POST /directions` with `add_genre` (and `replace_genre` / `new_direction`)
already answers `400` with a reason when the result would break one of the
clear-cut pairing rules — Electronic R&B only with house / Nu Disco / Indie
Dance, DownTempo only with DownTempo, LoFi only with LoFi (the update of
2026-10-22, section 4).

Requested genres used to be exempt from that check in Option 1, because they
went into every recipe anyway. They are not exempt any more, so the same
refusal can now come back for them:

```json
{ "error": "op_rejected", "reason": "would break a pairing rule (LoFi only with LoFi)" }
```

Nothing to change beyond showing the reason, which you already do.

One related behaviour: if an edit leaves a requested genre with no recipe at
all, the server gives it a recipe of its own (named after the genre) rather
than letting it go unplayed. You'll see that extra recipe in the response.

---

## 3. New: the owner can like or dislike each daily playlist

Since 2026-10-26 every daily playlist on the owner's dashboard carries two
small thumb icons next to its "▶ פתח" button — green for like, red for
dislike. A tap records the verdict straight away and opens a short modal
asking "מה אהבתם בפלייליסט?" / "מה לא אהבתם בפלייליסט?" with ONE optional
free-text field, plus "שלח" and "דלג". So:

- a verdict can exist with no text (they skipped the modal, which is the
  common case) — treat a missing reason as normal, not as missing data;
- a verdict can be changed (like → dislike) or taken back (tapping the lit
  icon clears it, and the row is deleted);
- the text can be edited later by tapping the same icon again.

Each day's playlists are NEW Spotify playlists, so a verdict belongs to one
specific playlist on one specific day. Yesterday's verdicts stay as history
and today's playlists start unrated.

### 3.1. `GET /users` — three new fields per business

```json
{
  "playlist_likes": 7,
  "playlist_dislikes": 2,
  "last_playlist_feedback_at": "2026-10-26T09:12:40Z"
}
```

Counts of the CURRENT verdicts (a verdict changed from like to dislike counts
once, as a dislike; one taken back counts not at all). `null` /  `0` where the
owner never used it.

**Worth putting on the business list**, next to the opens: a business with
dislikes and no likes is the one to look at first.

### 3.2. `GET /business` — on each daily playlist

Every playlist inside `daily[].playlists[]` gains a `feedback` key:

```json
{
  "spotify_id": "4EoQ…", "name": "אנרגיה גבוהה #1", "slot": "high-1",
  "opens": 1,
  "feedback": {
    "verdict": "dislike",
    "reason": "יותר מדי שירים שקטים בשעות העומס",
    "created_at": "2026-10-26T09:10:02Z",
    "updated_at": "2026-10-26T09:12:40Z"
  }
}
```

- `feedback` is `null` when the owner said nothing about that playlist, which
  is most of them.
- `reason` is `null` when they skipped the modal.
- `created_at` is when they first judged it, `updated_at` the last change —
  equal unless they changed their mind or added the text afterwards.

Each day in `daily[]` also carries `likes` and `dislikes`, the counts within
that day, so a day row can show them without walking its playlists.

### 3.3. `GET /business` — a new `playlist_feedback` section

The same verdicts as one list, newest change first, each naming the playlist
it was about. Use this for a "what did they say" panel on the business page,
without walking every day.

```json
"playlist_feedback": {
  "likes": 7,
  "dislikes": 2,
  "with_reason": 3,
  "items": [{
    "verdict": "dislike",
    "reason": "יותר מדי שירים שקטים בשעות העומס",
    "created_at": "2026-10-26T09:10:02Z",
    "updated_at": "2026-10-26T09:12:40Z",
    "spotify_id": "4EoQ…",
    "name": "אנרגיה גבוהה #1",
    "il_date": "2026-10-26",
    "url": "https://open.spotify.com/playlist/4EoQ…"
  }]
}
```

- `with_reason` — how many of them have text. The ones with text are the
  interesting ones; consider showing those first, or filtering to them.
- `name` / `il_date` / `url` are `null` only if the playlist row is somehow
  missing; normally they always resolve.

### 3.4. What this is NOT

- There is no write: the console cannot add, change or delete a verdict. It
  is the owner's own voice, read-only.
- It does not change the music by itself. Nothing in the builders reads it
  yet; it is there for you and Rubin to read.
- It is separate from the taste chat. An owner who wants a real change still
  says so in the chat, and that shows up in `taste_chat.changes` as before.

### 3.5. Before the migration

The table is `business_playlist_feedback`. Until Rubin runs its migration on
a given environment, every one of the fields above is simply empty (`0`,
`null`, `[]`) — no endpoint errors. So the dashboard can ship first.

