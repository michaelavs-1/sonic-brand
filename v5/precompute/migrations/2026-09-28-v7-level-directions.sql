-- ============================================================================
-- 2026-09-28 — v7 Option 2: a library of directions per energy level.
-- ADDITIVE ONLY: one new table. Nothing existing is altered.
--
-- Option 2 builds two daily mixes ("Daily Mix #1/#2") whose energy follows the
-- owner's timeline. Until now each energy level played from ALL of that
-- level's approved genres. From now on Gemini builds a library of directions
-- per level (v7/generation/level-directions.js, label 'v7-level-directions'),
-- and each day every level plays from ONE direction per mix, moving on to
-- the next direction of that level the following day (the rotation lives in
-- v7/generation/timeline-assembler.js pickLevelDirections).
--
-- A separate table from business_v7_directions (Option 1's high/low library)
-- so the two options never touch each other's rows: re-picking Option 1
-- replaces only its own library, and switching Option 2 → 1 → 2 finds this
-- library still here. profile_key = the taste profile's fingerprint when the
-- library was generated (levelProfileKey in timeline-assembler.js); the
-- dashboard reuses the library on a switch back to Option 2 only while the
-- key still matches (no genre added, removed or moved to another level).
--
-- Written by api/v7/account/save-level-directions.js (replace-all per
-- business) and scripts/_v7-regenerate-level-directions.mjs. Read by
-- api/v7/account/_option2-builder.js (service key) and the dashboard
-- (owner-scoped RLS SELECT).
--
-- Until this runs, the builder falls back to the old behaviour (every genre
-- of the level) and the save endpoint returns an error.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS business_v7_level_directions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  energy_level int         NOT NULL CHECK (energy_level BETWEEN 1 AND 6),
  rank         int,
  title_en     text,
  genres       jsonb       NOT NULL,
  profile_key  text,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_v7_level_directions_active_idx
  ON business_v7_level_directions (business_id) WHERE active = true;

-- Same RLS model as the other business_* tables: owner-scoped client-direct
-- SELECT; all writes go through server endpoints with service_role.
ALTER TABLE business_v7_level_directions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own v7 level directions read" ON business_v7_level_directions;
CREATE POLICY "own v7 level directions read" ON business_v7_level_directions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
