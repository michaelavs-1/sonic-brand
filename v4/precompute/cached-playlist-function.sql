-- v4 cached_playlist RPC
-- Returns up to p_per_genre random tracks per genre from the cache, for two
-- lists of genres:
--   p_strict_genres  — filtered by energy/danceability/popularity windows
--   p_relaxed_genres — NOT filtered (any cached `ok` track is fair game)
--
-- Why two lists: when the user picks a preview card whose matched_screen=false
-- (no track from that genre actually passed the screen, but they liked the
-- unscreened sample), they're telling us "yes, I want this genre even though
-- nothing in it fits the atmosphere". That genre gets placed in the relaxed
-- list so the final playlist still includes tracks from it.
--
-- The caller (api/v4/cached-playlist.js) does the balancing across genres
-- in JS. SQL just returns a generous random sample per genre so JS has
-- enough candidates to redistribute leftover quota.
--
-- Paste into Supabase SQL Editor and run once. Idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION cached_playlist(
    p_strict_genres   text[],
    p_relaxed_genres  text[],
    p_energy_lo int, p_energy_hi int,
    p_dance_lo  int, p_dance_hi  int,
    p_pop_lo    int, p_pop_hi    int,
    p_per_genre int DEFAULT 200
) RETURNS TABLE (
    genre      text,
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        -- DISTINCT collapses the same (genre, spotify_id) pair that can
        -- appear via multiple playlists in playlist_tracks.
        SELECT DISTINCT
            pg.genre,
            ta.spotify_id
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND (
            -- Relaxed bucket: any `ok` track from the genre, regardless of
            -- atmosphere features. Even tracks where energy/dance/pop are
            -- NULL in the cache are eligible here.
            pg.genre = ANY(COALESCE(p_relaxed_genres, ARRAY[]::text[]))
            OR
            -- Strict bucket: must fall inside all three windows. Strict
            -- BETWEEN over a NULL field returns NULL → filtered out.
            (
              pg.genre = ANY(COALESCE(p_strict_genres, ARRAY[]::text[]))
              AND ta.energy       BETWEEN p_energy_lo AND p_energy_hi
              AND ta.danceability BETWEEN p_dance_lo  AND p_dance_hi
              AND ta.popularity   BETWEEN p_pop_lo    AND p_pop_hi
            )
          )
    ),
    ranked AS (
        SELECT
            genre,
            spotify_id,
            row_number() OVER (PARTITION BY genre ORDER BY random()) AS rn
        FROM candidates
    )
    SELECT genre, spotify_id
    FROM ranked
    WHERE rn <= p_per_genre;
$$;
