-- v7 requested genres (2026-10-05): genres the owner explicitly asked for.
--   requested_genres   = super-liked genres + genres named in the musical
--                        emphases / Round 2 refinement text (canonical names).
--                        Always approved. Option 1 puts every requested genre
--                        in every playlist of its energy tier.
--   super_liked_genres = the genres the owner super-liked a track from in the
--                        swipe deck (onboarding input, kept as-is).
--   round2_emphases    = the Round 2 refinement text (onboarding input).
-- Written by api/v7/account/signup.js (_taste-profile.js tasteProfileRow) and
-- scripts/_v7-backfill-requested-genres.mjs. Read by
-- api/v7/account/_daily-builder.js planOption1 and the Option-1 directions
-- generator. NULL = not recorded (signed up before this migration).
-- Idempotent.

ALTER TABLE business_taste_profiles
  ADD COLUMN IF NOT EXISTS requested_genres   jsonb,
  ADD COLUMN IF NOT EXISTS super_liked_genres jsonb,
  ADD COLUMN IF NOT EXISTS round2_emphases    text;

NOTIFY pgrst, 'reload schema';
