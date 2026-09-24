-- ============================================================================
-- 2026-09-24 — v7 per-track genre record on business_playlists.
-- ADDITIVE ONLY: one new nullable column + one new function. Nothing existing
-- is altered; v6 rows simply keep track_genres = NULL.
--
-- Background: every built playlist (v6 and v7) already gets a permanent
-- business_playlists row — never deleted, only expires_at-gated — holding the
-- ordered track_ids. After expiry the Spotify playlist is emptied, so this row
-- is THE record of what the owner was served.
--
-- v7 adds, next to track_ids, WHICH of the playlist's genres each track came
-- from:
--   track_genres = { "<spotify_id>": ["Bossa Nova"], "<spotify_id>": [...], ... }
-- Canonical genre names, limited to the playlist's own genre set (a track
-- tagged with two of the playlist's genres lists both; [] if the catalog no
-- longer ties it to any of them). Written at build time by
-- api/v7/account/_daily-builder.js (cron + on-demand builds).
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

ALTER TABLE business_playlists
  ADD COLUMN IF NOT EXISTS track_genres jsonb;

COMMENT ON COLUMN business_playlists.track_genres IS
  'v7 only: {spotify_id: [canonical genre, ...]} — which of this playlist''s genres each track in track_ids belongs to. NULL for v6 rows.';

-- Lookup used by the v7 builder: for a set of tracks and a playlist's genres,
-- every (track, genre) pair where the track sits in a catalog playlist tagged
-- with that genre. playlist_genres.genre is stored lowercase, so the genre side
-- is lowercased (same convention as v5_direction_tracks). Uses
-- idx_playlist_tracks_spotify_id + playlist_genres' (playlist_id, genre) PK.
DROP FUNCTION IF EXISTS v7_track_genres(text[], text[]);

CREATE FUNCTION v7_track_genres(p_spotify_ids text[], p_genres text[])
RETURNS TABLE (spotify_id text, genre text)
LANGUAGE sql STABLE
AS $$
    SELECT DISTINCT pt.spotify_id, pg.genre
    FROM playlist_tracks pt
    JOIN playlist_genres pg ON pg.playlist_id = pt.playlist_id
    WHERE pt.spotify_id = ANY (p_spotify_ids)
      AND pg.genre = ANY (ARRAY(SELECT lower(g) FROM unnest(p_genres) AS g));
$$;

-- Server-side only (called with the service key from the v7 builder).
GRANT EXECUTE ON FUNCTION v7_track_genres(text[], text[]) TO service_role;

-- Make PostgREST pick up the new column + function immediately.
NOTIFY pgrst, 'reload schema';
