-- v7 subscription cancellation (2026-10-06): the Profile tab's "מנוי" section.
--   subscription_cancelled_at  = when the owner cancelled (NULL = active).
--   subscription_ends_at       = when service stops: midnight (Israel) at the
--                                start of the next monthly charge date, i.e.
--                                the end of the month they paid for. From then
--                                on the v7 daily cron and the build endpoints
--                                skip the business.
--   subscription_cancel_reason = the optional "why are you leaving?" text.
-- Written by api/v7/account/subscription.js (cancel sets all three; resume,
-- allowed until subscription_ends_at, clears them). Every change is also
-- audited in business_settings_changes (field 'subscription').
-- Idempotent.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS subscription_cancelled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_ends_at       timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_cancel_reason text;

NOTIFY pgrst, 'reload schema';
