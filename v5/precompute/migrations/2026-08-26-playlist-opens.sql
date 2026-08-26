-- Migration: business_playlist_opens — append-only log of every time an
-- owner clicks "▶ פתח" on a playlist row in their dashboard (Home tab).
--
-- Why: engagement signal. Which daily playlists actually get opened,
-- how often, and against which direction. Referenced by joining
-- spotify_id back to business_playlists (which is never deleted, only
-- expiry-gated), so a click yesterday can still be traced to its
-- direction / genres / track_ids today.
--
-- Not FK'd to business_playlists on purpose — matches the pattern
-- super_liked_tracks uses, keeps the DDL loose in case we ever purge
-- test rows. Join manually on spotify_id.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

CREATE TABLE IF NOT EXISTS business_playlist_opens (
  id          bigserial   PRIMARY KEY,
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  spotify_id  text        NOT NULL,
  source      text        NOT NULL DEFAULT 'home',
  opened_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_playlist_opens_business_time_idx
  ON business_playlist_opens (business_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS business_playlist_opens_spotify_idx
  ON business_playlist_opens (spotify_id);

-- RLS — same shape as super_liked_tracks / business_direction_chats:
-- client-direct reads gated by owner check, writes via server endpoint
-- with service_role.
ALTER TABLE business_playlist_opens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own business_playlist_opens read" ON business_playlist_opens;
CREATE POLICY "own business_playlist_opens read" ON business_playlist_opens FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
