-- Migration: promote musical directions to a first-class Postgres entity,
-- and extend business_playlists with a permanent per-playlist track list.
--
-- Why: today "directions" live only INSIDE `business_playlists.expansion.
-- direction`, duplicated across every playlist built from that direction.
-- `latestDirections()` in _daily-builder.js reconstructs the current
-- direction set by scanning recent playlist rows — which caused a real
-- cascade failure on Roni's account (partial daily-gen failures shrunk
-- the extractable direction set day-over-day toward zero). Also: users
-- may edit / activate / deactivate directions in a future dashboard, so
-- directions need their own permanent, addressable rows.
--
-- Also adds business_playlists.track_ids so each historical playlist row
-- is a complete snapshot: date (created_at) + direction (direction_id) +
-- track composition (track_ids). Playlists themselves are already
-- permanent (nothing deletes business_playlists rows; expires_at only
-- gates dashboard visibility).
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.
--
-- After running: run scripts/migrate-directions-to-table.mjs to backfill
-- business_directions from existing business_playlists.expansion + set
-- direction_id on historical playlist rows. See CLAUDE.md for the full
-- deploy sequence.

BEGIN;

-- 1) business_directions — permanent per-business direction storage.
--    active=false is the "soft-disable" state the future dashboard uses
--    to hide a direction from daily-gen without deleting its history.
CREATE TABLE IF NOT EXISTS business_directions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rank              int,                              -- 1..8 from Gemini, informational
  title_en          text,
  description_he   text,
  genres            jsonb       NOT NULL,             -- array of strings
  bpm_range         jsonb       NOT NULL,             -- {min, max}
  popularity_window jsonb,                            -- [lo, hi] snapshot at creation
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_directions_active_idx
  ON business_directions (business_id) WHERE active = true;

-- 2) business_playlists.direction_id — FK back to the source direction.
--    ON DELETE SET NULL so historical playlists survive as orphans even
--    if the direction is hard-deleted (user explicitly asked "never
--    remove"; SET NULL preserves the row + its track_ids snapshot).
ALTER TABLE business_playlists
  ADD COLUMN IF NOT EXISTS direction_id uuid REFERENCES business_directions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS business_playlists_direction_idx
  ON business_playlists (direction_id) WHERE direction_id IS NOT NULL;

-- 3) business_playlists.track_ids — ordered array of Spotify track IDs
--    that made up this playlist at build time. Populated forward-only
--    (pre-migration rows stay NULL; historical composition is
--    unrecoverable from other sources).
ALTER TABLE business_playlists
  ADD COLUMN IF NOT EXISTS track_ids jsonb;

-- 4) RLS on business_directions — same model as the other business_*
--    tables (2026-08-05 migration): client-direct reads gated by owner
--    check, writes via server endpoints with service_role.
ALTER TABLE business_directions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own business_directions read" ON business_directions;
CREATE POLICY "own business_directions read" ON business_directions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
