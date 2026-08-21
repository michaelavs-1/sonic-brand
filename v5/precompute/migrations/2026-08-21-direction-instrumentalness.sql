-- Migration: per-direction instrumentalness preference.
--
-- Why: users on the onboarding "musical emphases" page can now express
-- preferences about instrumental music with meaningfully different
-- strengths — "only instrumentals" (hard filter) vs "prefer instrumentals"
-- (soft bias). Gemini parses the emphases text and sets a 3-state enum
-- (none|soft|hard) on every direction it returns. Downstream track
-- selection (v5_anchor_tracks, v5_direction_tracks, v6_direction_tracks_recent)
-- reads this and applies either a WHERE filter (hard) or an ORDER BY bias
-- (soft) so the preference is honored not just during onboarding but for
-- the life of the business — expand-playlist and the daily-gen cron both
-- read from business_directions and forward the value into the RPCs.
--
-- Backward-compat: default 'none' matches today's behavior exactly. All
-- existing rows and existing RPC callers that don't pass the value keep
-- working unchanged.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

ALTER TABLE business_directions
  ADD COLUMN IF NOT EXISTS instrumentalness_preference text NOT NULL DEFAULT 'none';

-- Constraint check needs to be added separately from the column ADD so
-- the migration is safe to re-run (ADD COLUMN IF NOT EXISTS doesn't
-- re-apply constraints, but ALTER TABLE ADD CONSTRAINT will error on
-- duplicate). Wrap in a DO block that drops-and-recreates so both first
-- run and re-run land in the same state.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_directions_instrumentalness_preference_check'
  ) THEN
    ALTER TABLE business_directions
      DROP CONSTRAINT business_directions_instrumentalness_preference_check;
  END IF;
  ALTER TABLE business_directions
    ADD CONSTRAINT business_directions_instrumentalness_preference_check
    CHECK (instrumentalness_preference IN ('none','soft','hard'));
END $$;

COMMIT;
