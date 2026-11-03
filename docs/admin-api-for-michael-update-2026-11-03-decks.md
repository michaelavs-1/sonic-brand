# Rubin — Admin Dashboard: Update of 2026-11-03 (the two decks)

> Give this to your Claude / AI coding assistant together with the
> document it already has ("Rubin — Admin Dashboard: Build Brief + API
> Reference") and the updates of 2026-10-22, 2026-10-26, 2026-11-02 and
> 2026-11-03 (the like / dislike one).
>
> Two corrections to section 1 of the 2026-11-02 update (the swipe cards).
> **No API change:** same endpoints, same fields, same shapes, same ranks.
> Only the order the owner sees the decks in, and when a deck gets Round 2,
> changed.

---

## Checklist

- [ ] In the swipe cards, show the calm group first, then the energetic one
      (section 1).
- [ ] Wherever the dashboard explains Round 2, say "fewer than 3 likes"
      (section 2).
- [ ] Nothing to change in any API call.

---

## 1. The calm deck comes first

**Until now** (the 2026-11-02 update): the owner swiped the energetic deck
first, then the calm deck.

**From 2026-11-03:** the calm deck first, then the energetic deck. Round 2
cards are also shown calm first.

- **Ranks don't change:** energetic deck 1–6, calm deck 7–12, Round 2
  energetic 13–16, calm 17–20. A rank says which deck a card belongs to,
  not the order it was shown in.
- `onboarding.swipe.cards` stays sorted by rank, so the energetic cards
  still come first in the list. Use each card's `deck` to group them.

**What to change in the dashboard (Tab 2, "דק ההחלקות"):** show the groups
in the order the owner saw them, "מוזיקה רגועה" (calm) then "מוזיקה
אנרגטית" (energetic). The 2026-11-02 update said energetic then calm.
Older accounts (cards without `deck`) are unchanged.

## 2. Round 2 opens below 3 likes

**Until now:** a deck the owner liked fewer than 2 cards of got 4 more cards
of the same energy (Round 2).

**From 2026-11-03:** fewer than 3. A deck needs at least 3 likes out of 6,
or it gets Round 2.

- More owners will have Round 2 cards (`round: 2`) from now on.
- `onboarding.round2_emphases` keeps its meaning: the text the owner typed
  before the extra cards. It's asked when a deck got fewer than 3 likes.
- Accounts that signed up before 2026-11-03 went through the old rule;
  their cards are unchanged.

**What to change in the dashboard:** only text. If a label or tooltip says
when Round 2 happens, make it "fewer than 3 likes on a deck". Nothing to
recalculate: whether an account got Round 2 is in its cards (`round: 2`).
