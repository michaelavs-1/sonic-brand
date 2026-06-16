-- v4 cached_preview RPC
-- Returns one track per (genre, column_letter) for the given business_type,
-- preferring tracks that fall inside all three atmosphere windows (energy,
-- danceability, popularity). Falls back to any track from the genre if none
-- match — the caller surfaces this via `matched_screen=false`.
--
-- Paste into Supabase SQL Editor and run once. Idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION cached_preview(
    p_business_type text,
    p_energy_lo int, p_energy_hi int,
    p_dance_lo  int, p_dance_hi  int,
    p_pop_lo    int, p_pop_hi    int
) RETURNS TABLE (
    genre              text,
    column_letter      char(1),
    position_in_column int,
    spotify_id         text,
    matched_screen     boolean
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT
            bg.genre,
            bg.column_letter,
            bg.position_in_column,
            ta.spotify_id,
            -- ~10% of ok rows have NULL energy/danceability/popularity (RapidAPI
            -- didn't return those fields). Without COALESCE, BETWEEN over a NULL
            -- column yields NULL, propagating through AND and producing
            -- matched_screen=NULL. PostgreSQL's default ORDER BY DESC ranks
            -- NULL above TRUE, so NULL-fielded tracks would be picked over
            -- actually-matched ones. COALESCE clamps NULL to FALSE: "can't
            -- verify this passes, treat as fallback material."
            COALESCE(
                (ta.energy       BETWEEN p_energy_lo AND p_energy_hi
                 AND ta.danceability BETWEEN p_dance_lo  AND p_dance_hi
                 AND ta.popularity   BETWEEN p_pop_lo    AND p_pop_hi),
                FALSE
            ) AS matched_screen
        FROM biztype_genres bg
        JOIN playlist_genres pg ON pg.genre       = bg.genre
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE bg.business_type = p_business_type
          AND ta.status        = 'ok'
    ),
    ranked AS (
        SELECT *, row_number() OVER (
            PARTITION BY genre, column_letter
            ORDER BY matched_screen DESC, random()
        ) AS rn
        FROM candidates
    )
    SELECT genre, column_letter, position_in_column, spotify_id, matched_screen
    FROM ranked
    WHERE rn = 1
    ORDER BY column_letter, position_in_column;
$$;
