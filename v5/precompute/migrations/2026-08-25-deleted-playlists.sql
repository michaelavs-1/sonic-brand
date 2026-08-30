-- Migration: deleted_playlists — archive for playlists Ami has cleaned up
-- via the v4/ami dashboard's "Playlist cleanup" feature (mirrors the
-- existing deleted_tracks table used by "Track cleanup").
--
-- Delete flow (see /api/v4/ami-playlist-delete):
--   1. Snapshot every playlist_genres row + every playlist_tracks row for
--      the target playlist_id.
--   2. Upsert into deleted_playlists (single row keyed by playlist_id).
--   3. DELETE from playlist_genres + playlist_tracks for that playlist_id.
--
-- Restore flow (/api/v4/ami-playlist-restore):
--   1. Read the archive row.
--   2. Re-insert every original playlist_genres + playlist_tracks row.
--   3. Delete the archive row (one-shot restore).
--
-- Note: this table does NOT archive track_analyses. Deleting a playlist
-- only removes its mapping rows; the audio-features cache for the tracks
-- inside it stays intact (those tracks may live in other playlists, and
-- the cache is expensive to rebuild via RapidAPI). If Ami wants to also
-- wipe the tracks themselves, the existing Track cleanup handles that
-- one-at-a-time.
--
-- No anon-read policy — dashboard hits this table only via service_role
-- endpoints.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

CREATE TABLE IF NOT EXISTS deleted_playlists (
    playlist_id           text        PRIMARY KEY,
    name                  text,
    owner                 text,
    playlist_genres_rows  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    playlist_tracks_rows  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    deleted_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deleted_playlists ENABLE ROW LEVEL SECURITY;

COMMIT;
