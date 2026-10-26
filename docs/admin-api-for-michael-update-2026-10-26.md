# Rubin — Admin Dashboard: Update of 2026-10-26

> Give this to your Claude / AI coding assistant together with the
> document it already has ("Rubin — Admin Dashboard: Build Brief + API
> Reference") and the update of 2026-10-22. No endpoint, field or action was
> added, removed or renamed this time: what changed is the MEANING of the
> requested genres, which shows up in the libraries and in one refusal.
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
