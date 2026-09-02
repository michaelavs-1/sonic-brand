-- Migration: widen business_direction_changes.playlist_action to include 'renamed'.
--
-- Why: the direction-edit chat now takes a fast path for cosmetic-only edits
-- (owner asked to rename or reword description with no musical changes).
-- On that path the live Spotify playlist is neither rebuilt nor expired —
-- it's renamed in place via Spotify's PUT /playlists/{id} (name + description).
-- We want the audit row to reflect that ('kept' would be misleading — we
-- did touch the playlist; 'rebuilt' would falsely imply new tracks).
--
-- Adds 'renamed' as a fourth allowed value; existing 'rebuilt' / 'expired' /
-- 'kept' rows are unaffected.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_direction_changes_playlist_action_check'
  ) THEN
    ALTER TABLE business_direction_changes
      DROP CONSTRAINT business_direction_changes_playlist_action_check;
  END IF;
  ALTER TABLE business_direction_changes
    ADD CONSTRAINT business_direction_changes_playlist_action_check
    CHECK (playlist_action IN ('rebuilt', 'expired', 'kept', 'renamed'));
END $$;

COMMIT;
