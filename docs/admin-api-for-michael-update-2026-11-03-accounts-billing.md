# Robin — Admin Dashboard: Update of 2026-11-03 (Spotify accounts + billing)

> Give this to your Claude / AI coding assistant together with the
> document it already has ("Rubin — Admin Dashboard: Build Brief + API
> Reference") and the earlier updates.
>
> The two endpoints you asked for in "בקשה לרוני: שני endpoints לקריאה
> בלבד", built on your spec. Both are `GET`, read-only, same bearer key as
> the rest of the API. Where the answers differ from your spec, it's
> listed below: a few extra fields, two extra subscription statuses, and
> fields that are always `null`.

---

## Checklist

- [ ] Point the "חשבונות ספוטיפיי" tab at `GET /api/internal/spotify-accounts` (section 1).
- [ ] Point the "כסף" tab at `GET /api/internal/billing` (section 2).
- [ ] Add translations for the subscription statuses `no-account` and
      `account-deleted` (section 2).
- [ ] Hide or mark as "not available" the billing fields that are always
      `null` (section 2).
- [ ] Optional: show the extra fields (`first_payment`, `next_charge_date`,
      `terminal`, `kind`).

---

## 1. `GET /api/internal/spotify-accounts`

Your shape, unchanged. Today it returns **one account, `robin-1`, with every
business on it**. Roni decides which business goes on which account; when
more accounts are added, they appear here as more items in `accounts[]`. The
endpoint never calls Spotify.

```json
{
  "accounts": [
    {
      "id": "robin-1",
      "label": "Robin 1",
      "email": "sonic.brands1@gmail.com",
      "spotify_user_id": "316gotb2mutzdjmghprpgmxwq62i",
      "display_name": "Robin - Sonic Brands",
      "profile_url": "https://open.spotify.com/user/316gotb2mutzdjmghprpgmxwq62i",
      "status": "ok",
      "status_detail": null,
      "last_ok_at": "2026-11-03T06:00:12.511+00:00",
      "playlist_count": 20,
      "businesses": [
        { "business_id": "uuid", "name": "בר ורמוני", "owner_email": "owner@example.com", "playlist_count": 4 }
      ]
    }
  ],
  "unassigned_businesses": [],
  "notes": []
}
```

How each field is filled:

| Field | Value |
|---|---|
| `id`, `label`, `email`, `spotify_user_id`, `display_name` | From our accounts table. |
| `profile_url` | Built from `spotify_user_id`. |
| `status` | `ok`, `error` or `disabled`. There's no `token_expired`: we don't check the login with Spotify. `error` means one of two things, explained in `status_detail`: all Spotify writes are paused right now (Spotify asked us to slow down; this affects every account at once), or the server has no login for this account. |
| `last_ok_at` | When the newest playlist on this account was created. That's our last confirmed successful write to it. |
| `playlist_count` | Playlists on the account right now: created and not yet removed. Each daily playlist is removed about two hours after closing, so this is roughly today's playlists. It includes a few test playlists with no business, so it can be higher than the sum of `businesses[].playlist_count`. |
| `businesses[]` | Every business set to this account (`playlist_count` 0 if it has none right now), plus any business that moved to another account but still has live playlists here. So for a few hours after a move, a business can appear under both accounts, as your spec allows. |
| `unassigned_businesses[]` | Businesses not set to any account. Normally empty: new businesses get the default account automatically. |
| `notes` | Always `[]`. |

---

## 2. `GET /api/internal/billing`

Your shape, plus a few extra fields. Amounts are in agorot (whole numbers);
dates are ISO 8601.

```json
{
  "currency": "ILS",
  "list_price_agorot": 20000,
  "subscriptions": [
    {
      "business_id": "uuid",
      "name": "בר ורמוני",
      "owner_email": "owner@example.com",
      "status": "active",
      "terminal": "production",
      "started_at": "2026-10-28T09:42:18.148+00:00",
      "anchor_day": 28,
      "current_period_end": "2026-11-27T22:00:00.000Z",
      "cancel_at_period_end": false,
      "next_charge_at": "2026-11-27T22:00:00.000Z",
      "next_charge_date": "2026-11-28",
      "next_charge_amount_agorot": 20000,
      "coupon_code": null,
      "coupon_percent_off": null,
      "first_payment": { "at": "2026-10-28T09:42:18.148+00:00", "amount_agorot": 200, "coupon_code": "VERMINI1", "coupon_percent_off": 99 },
      "card_brand": null,
      "card_last4": null,
      "last_charge": { "at": "2026-10-28T09:42:18.148+00:00", "amount_agorot": 200, "status": "succeeded", "failure_reason": null },
      "failed_attempts": null,
      "grace_ends_at": null
    }
  ],
  "recent_charges": [
    { "at": "2026-10-28T09:42:18.148+00:00", "business_id": "uuid", "name": "בר ורמוני", "amount_agorot": 200,
      "status": "succeeded", "failure_reason": null, "kind": "signup", "terminal": "production" }
  ],
  "notes": []
}
```

### `subscriptions[]`

One per payment that started a subscription (newest first), including
cancelled and ended ones. A business that renewed after its subscription
ended appears once, with its current subscription.

| Field | Value |
|---|---|
| `status` | `active`, `cancelled` (runs until `current_period_end`, no more charges) or `ended`. **Two extra values** for a payment with no business behind it (`business_id` is then `null`, and `name` / `owner_email` are what was typed on the payment page): `no-account` = paid but never finished signing up; `account-deleted` = the business's account was deleted. Today there are three `account-deleted` rows, all old test payments. |
| `terminal` | Extra field. `production` = real money; `test` = Hyp's test terminal (not real money). Worth filtering out `test`. |
| `started_at` / `anchor_day` | The payment that started the current subscription, and its day of the month (Israel time). |
| `current_period_end` | When the paid month ends. |
| `next_charge_at` | The start of the next charge day, Israel time (midnight). The charge happens some time that day; only the date is known. `null` when no more charges are expected (`cancelled`, `ended`, `account-deleted`). Your rule holds: a paying customer = `next_charge_at` not `null` (`active`, and `no-account` if one ever appears). |
| `next_charge_date` | Extra field: the same day as `YYYY-MM-DD`, easier to display. |
| `next_charge_amount_agorot` | The full monthly price. A coupon only discounts the first payment, so it never applies to the next charge. |
| `coupon_code` / `coupon_percent_off` | Always `null`, for the same reason. The coupon a customer signed up with is in `first_payment`. |
| `first_payment` | Extra field: the first payment, its amount and the coupon used (if any). |
| `last_charge` | The payment that started the subscription, as long as no monthly charge has been due since. After the first monthly charge date it's `null`. |
| `card_brand`, `card_last4`, `failed_attempts`, `grace_ends_at` | Always `null`. |

### `recent_charges[]`

The 50 newest payments made through our payment page, newest first: the
first payment at signup, and any renewal after a subscription ended. A
declined payment at that stage shows as `status: "failed"`, with
`failure_reason` like `"Hyp CCode 6"`. Monthly charges are not in this list.
Extra fields: `kind` (`signup` | `renewal`) and `terminal` (as above).

---

## Quick check

```
curl -H "Authorization: Bearer $RUBIN_ADMIN_KEY" https://robin-music.com/api/internal/spotify-accounts
curl -H "Authorization: Bearer $RUBIN_ADMIN_KEY" https://robin-music.com/api/internal/billing
```
