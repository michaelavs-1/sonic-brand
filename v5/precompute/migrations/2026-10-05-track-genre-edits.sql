-- Track genre edits (2026-10-05): the log behind the Ami dashboard's Track
-- cleanup genre editor (api/v4/ami-track-genres.js). One row per change to the
-- genres a catalog track is in, written BEFORE the change is applied:
--   before_rows / after_rows = the track's playlist_tracks rows before / after
--   (undo puts before_rows back). before_genres / after_genres = the genres,
--   lowercase, for reading at a glance.
-- Genres added there live in "manual" playlists (playlist_id 'manual:<genre>',
-- tagged in playlist_genres) — see api/v4/_track-genres.js.
-- RLS on, no policies: service_role only, like deleted_tracks. Idempotent.

CREATE TABLE IF NOT EXISTS track_genre_edits (
    id             bigserial   PRIMARY KEY,
    spotify_id     text        NOT NULL,
    title          text,
    artist         text,
    before_genres  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    after_genres   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    before_rows    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    after_rows     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    edited_at      timestamptz NOT NULL DEFAULT now(),
    undone_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_track_genre_edits_spotify_id ON track_genre_edits (spotify_id);

ALTER TABLE track_genre_edits ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
