# Robin — Admin API delta: playlist opens

> Focused delta doc. Paste this into your Claude alongside (or in
> addition to) the master `admin-api-for-michael.md`. It describes a
> small addition to the existing `GET /api/internal/business` endpoint
> — no new endpoint, no auth change.

---

## What's new

Every time a business owner clicks the **▶ פתח** button on a playlist
row in their account dashboard, Robin now logs one row to a
`business_playlist_opens` table. The `GET /api/internal/business?id=<uuid>`
response was extended with two new top-level fields exposing this data:

- `playlist_opens` — raw click log for this business
- `playlist_opens_summary` — pre-computed rollups so the UI doesn't
  have to sum on the client

Both are always present in the response. For businesses whose owner has
never clicked ▶ פתח (or for businesses that predate the feature, added
2026-08-26), the array is empty and the summary counts are zero.

Nothing else in the response schema changed. Everything else you built
against the endpoint continues to work unchanged.

---

## Response shape (new fields only)

```jsonc
{
  // ... all existing fields (business, onboarding, place, hours,
  //     directions, playlists, direction_changes, chat_transcript,
  //     gemini_spend, gemini_calls, cleanup_backlog) unchanged ...

  "playlist_opens": [
    // Newest first. Capped at 1000 rows per response (pilot scale is
    // orders of magnitude below this cap).
    {
      "id":         12345,                       // bigserial primary key
      "spotify_id": "37i9dQZF1DX...",            // JOIN back to
                                                 //   playlists[i].spotify_id
                                                 //   for label / direction /
                                                 //   genres / track_ids
      "source":     "home-daily",                // "home-daily" | "home-event"
                                                 //   | possibly future values
      "opened_at":  "2026-08-27T13:22:44Z"
    }
  ],

  "playlist_opens_summary": {
    "total": 7,                                   // total clicks logged

    "by_playlist": [                              // desc by count
      { "spotify_id": "…", "count": 5, "last_opened_at": "2026-08-27T…" },
      { "spotify_id": "…", "count": 2, "last_opened_at": "2026-08-26T…" }
    ],

    "by_source": [                                // desc by count
      { "source": "home-daily", "count": 5 },
      { "source": "home-event", "count": 2 }
    ]
  }
}
```

---

## Field-by-field notes

**`playlist_opens[].spotify_id`** — Not FK'd to `business_playlists` in
the database (the log is a loose engagement signal, and playlists are
kept forever regardless of expiry — so a click yesterday still resolves
to a valid playlist today). Join client-side by building a
`Map(spotify_id → playlist)` from the existing `playlists[]` array in
the same response.

**`playlist_opens[].source`** — Distinguishes which UI surface fired the
click:
- `"home-daily"` — a regular daily playlist card in the Home tab
- `"home-event"` — a special-event playlist card
- Anything else = a source we haven't documented yet; treat as an
  opaque string. Just display as-is.

**`playlist_opens_summary.total`** — Same as `playlist_opens.length`
under normal conditions. If we ever cap the raw array below the true
count (currently 1000, unlikely to hit at pilot scale), `total` will
still be the true count.

**`playlist_opens_summary.by_playlist`** — Best single view for a
dashboard: shows which playlists this owner actually engages with. Sort
is descending by count. Each row includes `last_opened_at` for a
recency signal (a playlist opened 20 times a month ago is different
signal than a playlist opened 5 times yesterday).

**`playlist_opens_summary.by_source`** — Small (usually 1–2 rows). Good
for a quick "50 daily-playlist opens vs. 12 event-playlist opens" pill
in the summary.

---

## Suggested UI

Two options depending on how much space you want to give it:

**Compact (recommended):** add a "Playlist opens" section at the bottom
of the per-business detail page, below Gemini spend. Layout:
- Card header: `"Playlist opens · {total} clicks"`
- Small table: by-source counts (usually two rows)
- Expandable `<details>` "By playlist" — the ranked list from
  `by_playlist`, with each row linking to the playlist's `url` (found
  by joining `spotify_id` back to `playlists[]`) and its `label` /
  direction name for context
- Expandable `<details>` "Individual clicks" — raw `playlist_opens`
  rows for anyone who wants the audit trail

**Inline enhancement (optional, more work):** for each card in the
existing Playlists section, show a small "opened N times" badge next to
the live/expired pill. Use `playlist_opens_summary.by_playlist` for the
count. Nice-to-have; not required.

Empty state is important — a lot of businesses will have `total: 0`
either because they signed up before 2026-08-26 or because they just
haven't opened anything yet. Show something like "No playlist opens
logged yet" rather than a blank card.

---

## Ground rules (unchanged, reminder)

Same rules from section 0 of the master doc:

1. **Deploy dashboard changes to the `sonic-brand-preview` Vercel
   project only, NEVER to `sonic-brand`.**
2. **Don't edit files under `api/internal/*` in Robin's repo.** If you
   need this data reshaped, filtered server-side, or want a new
   endpoint that surfaces click data site-wide (e.g., "top clicked
   playlists across all businesses this week"), ask Roni.

---

## Getting help

Anything unclear? Ask Roni. This addition lives in one file on Robin's
side (`api/internal/business.js` — extended, not replaced).
