-- 2026-08-23 — persist the free-text onboarding inputs on businesses.
--
-- Why: today's signup writes atmospheres to auth.users.raw_user_meta_data
-- (via user_metadata.sonic.onboarding.atmospheres) and drops bizDesc +
-- musicalEmphases on the floor entirely. Michael's forthcoming internal
-- dashboard needs to see the exact prompt each owner used to produce
-- their musical directions, so we capture the two missing free-text
-- fields on businesses itself — 1:1 with the concept, one row per
-- business, one query for the internal API.
--
-- Atmospheres are intentionally NOT mirrored here; they remain in
-- user_metadata (small identity flag, doesn't inflate the JWT), and the
-- internal endpoint reads them via the auth admin API.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS business_description text,
  ADD COLUMN IF NOT EXISTS musical_emphases     text;

COMMIT;
