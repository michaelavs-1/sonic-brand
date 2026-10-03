-- v7 special playlists (2026-10-03): where the playlist's genres come from.
--   'daily' = the owner agreed in the chat to use the same styles as their daily
--             playlists → the builder picks only from the taste profile's
--             approved genres;
--   'event' = the owner named the styles → the builder may use any genre.
-- Written by api/v7/account/save-event.js, read by api/v7/account/event-playlist.js.
-- NULL (v6 rows, or rows saved before this migration) is read as 'event'.
-- Idempotent.

ALTER TABLE business_events
  ADD COLUMN IF NOT EXISTS genre_source text
  CHECK (genre_source IN ('daily', 'event'));

NOTIFY pgrst, 'reload schema';
