# Admin API update, 2026-11-05: the direction editor no longer refuses genres

> For Michael's Claude. Nothing breaks if you change nothing: the fields and
> actions are the same. Only some wording in the console goes out of date.

## What to do

- [ ] Genre picker (`add_genre` / `replace_genre`): remove the notes saying Rubin
  may refuse a genre, and the "העבר" flow. A genre in the other tier or at
  another level no longer comes back as a 400. It moves, and the response says so
  in `warnings`.
- [ ] New direction: you may let the admin pick any catalog genre, not only
  approved ones. The server approves them on the way in.
- [ ] The ★ explanation: replace "נמצא בכל המתכונים שמתאימים לו" with "לפחות אחד
  מהפלייליסטים של היום מנגן מתכון שמכיל אותו". A ★ genre was never required in
  every recipe that suits it.

`warnings` and `notes` are already shown by your console, so the new messages
appear without any change.

## What changed in `POST /directions`

Adding or removing a genre is never refused or undone by the server any more.

| Action | Until now | From now on |
|---|---|---|
| Adding a genre that breaks a pairing rule (LoFi only with LoFi, and so on) | `400` | Accepted |
| Adding a calm-only genre to an energetic direction, or the reverse (two-sided profile) | `400` | Accepted. The genre sits on both sides |
| Adding a genre approved in the other tier or at another level | `400` unless `move: true` | Moved there, with a warning that it left the old directions. On a two-sided profile it's added on the new side and stays on the old one, unless you pass `move: true` |
| `new_direction` with a genre the profile doesn't approve | `400` | The genre is approved, as with `add_genre` |
| Removing a ★ genre from its last direction, or deleting that direction | The server gave the genre a new direction of its own | The genre stays out and **stops being ★**, with a note: "X is no longer a requested genre (no direction plays it now)" |
| Removing a genre whose other side has no direction, or adding it on one side | The server could create a direction for the other side | Nothing is created |
| Removing or deleting the last direction of a tier or level | The server built a new one from all its genres | Nothing is created. A warning says what it means (below) |

**A tier or level with no direction:**
- Option 1: no playlists of that tier are built until a direction is added.
- Option 2: that level plays all its genres together.

**Still refused** (bad input, not rules): a genre that isn't in the catalog, a
direction key that doesn't exist, a genre already in that direction, and an
invalid tier or energy level. The size limits also stay: 30 directions per
business in Option 1, 10 per level in Option 2.

The owner's chat still follows the rules for its own changes. It no longer undoes
a pairing made here. If the owner later removes every genre from a tier through
the chat, or undoes a change, the chat's usual repairs can apply there.
