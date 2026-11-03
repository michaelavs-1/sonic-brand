# Rubin — Admin Dashboard: Update of 2026-11-03

> Give this to your Claude / AI coding assistant together with the
> document it already has ("Rubin — Admin Dashboard: Build Brief + API
> Reference") and the updates of 2026-10-22, 2026-10-26 and 2026-11-02.
>
> One small change to the playlist like / dislike from the update of
> 2026-10-26 (its section 3). **No API change:** same endpoints, same fields,
> same shapes. Only what the `reason` text can contain changed, and that
> may affect how the dashboard labels it.

---

## Checklist

- [ ] Wherever the dashboard shows a verdict's `reason`, label it as the
      reason for a DISLIKE (section 1).
- [ ] Nothing to change in any API call.

---

## 1. A like no longer asks why

**Until now:** tapping either thumb opened a modal: "מה אהבתם בפלייליסט?"
after a like, "מה לא אהבתם בפלייליסט?" after a dislike, each with one
optional text field.

**From 2026-11-03:** only a dislike opens the modal. A like is saved and
that's it: no modal, no text.

What this means for the data you already read (`feedback` on each playlist
in `daily[].playlists[]`, and `playlist_feedback.items[]` on `/business`):

- **A like's `reason` is always `null` from now on.** The server stores no
  text with a like, even if one is sent.
- **Text now comes only with dislikes.** `reason` is what the owner typed
  in the "מה לא אהבתם בפלייליסט?" modal, or `null` when they skipped it.
- **A changed verdict drops the old text.** If the owner switches a dislike
  with text to a like, the like has `reason: null`; switching back to a
  dislike starts without text until they write a new one.
- **Old data:** one like from before 2026-11-03 still carries text (11
  verdicts stored in all on 2026-11-03). It stays until the owner changes or
  clears that verdict. Show it as it is; there's no need to hide it.
- `playlist_feedback.with_reason` keeps its meaning (verdicts with text). In
  practice it now counts dislikes with an explanation, which is the list
  worth showing first.

**What to change in the dashboard:** if the UI labels the text in a neutral
way ("מה כתבו") or offers a "why they liked it" column, change it to the
reason for the dislike, e.g. "למה לא אהבו". If it shows a like's text,
leave that as it is: it just won't appear on new likes.
