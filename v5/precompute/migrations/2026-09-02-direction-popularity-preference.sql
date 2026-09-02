-- Migration: per-direction popularity preference.
--
-- Why: users on the onboarding "musical emphases" page (Round 1 AND the
-- Round-2 refinement step) can express preferences about hit vs deep-cut
-- music — "only hits" (hard filter), "mostly hits" (soft bias), silent
-- (unchanged, use atmosphere-derived popularity window). Mirrors the
-- instrumentalness_preference migration from 2026-08-21.
--
-- Behavior at the RPC layer:
--   'hard' → WHERE popularity BETWEEN 60 AND 100 (overrides atmosphere window)
--   'soft' → WHERE keeps atmosphere window; ORDER BY bumps popularity < 60
--            to the back so hits surface first, deep cuts fill in when the
--            hit pool is thin
--   'none' → unchanged (atmosphere-derived popularity window applies)
--
-- Gemini also biases GENRE picks when set to hard/soft (skew away from
-- esoteric-only genres, lean toward hit-friendly catalogs) — see the
-- "Popularity preference" sub-rule in the R1 prompt.
--
-- Value is stored per-direction on business_directions. Set at signup from
-- the R1/R2 Gemini output, updated on chat edits (direction-edit chat
-- preview + apply-direction-change support it), read back by
-- _daily-builder + expand-playlist so it persists for the life of the
-- business until the owner overrides via chat.
--
-- Backward-compat: default 'none' matches today's behavior exactly. All
-- existing rows and existing RPC callers that don't pass the value keep
-- working unchanged.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

ALTER TABLE business_directions
  ADD COLUMN IF NOT EXISTS popularity_preference text NOT NULL DEFAULT 'none';

-- Same drop-and-recreate pattern as the instrumentalness migration so the
-- constraint step is safely re-runnable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_directions_popularity_preference_check'
  ) THEN
    ALTER TABLE business_directions
      DROP CONSTRAINT business_directions_popularity_preference_check;
  END IF;
  ALTER TABLE business_directions
    ADD CONSTRAINT business_directions_popularity_preference_check
    CHECK (popularity_preference IN ('none','soft','hard'));
END $$;

COMMIT;
