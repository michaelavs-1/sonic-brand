-- ============================================================================
-- 2026-11-02 — The onboarding cards take an energy range (two decks, Ami).
--
-- The swipe step is now two decks: energetic cards play songs at energy
-- 60–80, calm cards at 30–50, with per-genre exceptions for genres whose songs
-- sit almost entirely below 30 or above 80 (shared/genre-sides.js). Each spec
-- may now carry "lo" / "hi" (track_analyses.energy, 0–100):
--   - Tier 1 (8 random playlists of the genre) takes only songs inside the
--     range.
--   - Tier 2 (200 random playlists, only for specs tier 1 couldn't fill)
--     takes the song closest to the range: inside first, then 5 points
--     outside, then 10…, songs with no energy value last. So a card is never
--     dropped for lack of an in-range song.
-- A spec without lo / hi works exactly as before.
--
-- Same signature → CREATE OR REPLACE keeps the existing grants (the function
-- stays callable with the anon key, as the swipe deck needs; see
-- 2026-10-24-lock-down-businesses-and-functions.sql).
-- ============================================================================

CREATE OR REPLACE FUNCTION v7_anchor_tracks(p_specs jsonb)
RETURNS TABLE (rank int, spotify_id text)
LANGUAGE sql STABLE
AS $$
    WITH specs AS (
        SELECT
            (elem->>'rank')::int                         AS rank,
            -- playlist_genres.genre is stored lowercase; lowercasing the spec
            -- side keeps idx_playlist_genres_genre usable (same as v5).
            lower(elem->>'genre')                        AS genre,
            coalesce(lower(elem->>'inst_pref'), 'none')  AS inst_pref,
            coalesce(lower(elem->>'pop_pref'),  'none')  AS pop_pref,
            (elem->>'lo')::numeric                       AS lo,
            (elem->>'hi')::numeric                       AS hi
        FROM jsonb_array_elements(p_specs) AS elem
    ),
    -- Tier 1: 8 random playlists per genre, songs inside the range only.
    -- MATERIALIZED so it runs once; the NOT IN below would otherwise
    -- re-evaluate it.
    tier1 AS MATERIALIZED (
        SELECT s.rank, pick.spotify_id
        FROM specs s
        CROSS JOIN LATERAL (
            SELECT ta.spotify_id
            FROM (
                SELECT pg.playlist_id
                FROM playlist_genres pg
                WHERE pg.genre = s.genre
                ORDER BY random()
                LIMIT 8
            ) pl
            JOIN playlist_tracks pt ON pt.playlist_id = pl.playlist_id
            JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
            WHERE ta.status = 'ok'
              AND (s.inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
              AND (s.pop_pref  <> 'hard' OR ta.popularity BETWEEN hit_popularity_floor(s.genre) AND 100)
              AND (s.lo IS NULL OR ta.energy BETWEEN s.lo AND s.hi)
            ORDER BY
              (s.inst_pref = 'soft' AND coalesce(ta.instrumentalness, 0) < 85)::int,
              (s.pop_pref  = 'soft' AND coalesce(ta.popularity, 0) < hit_popularity_floor(s.genre))::int,
              random()
            LIMIT 1
        ) AS pick
    ),
    -- Tier 2: only for specs tier 1 couldn't satisfy — a wider sample of 200
    -- playlists, the song nearest the range first (5-point rings).
    tier2 AS (
        SELECT s.rank, pick.spotify_id
        FROM specs s
        CROSS JOIN LATERAL (
            SELECT ta.spotify_id
            FROM (
                SELECT pg.playlist_id
                FROM playlist_genres pg
                WHERE pg.genre = s.genre
                ORDER BY random()
                LIMIT 200
            ) pl
            JOIN playlist_tracks pt ON pt.playlist_id = pl.playlist_id
            JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
            WHERE ta.status = 'ok'
              AND (s.inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
              AND (s.pop_pref  <> 'hard' OR ta.popularity BETWEEN hit_popularity_floor(s.genre) AND 100)
            ORDER BY
              CASE
                WHEN s.lo IS NULL      THEN 0
                WHEN ta.energy IS NULL THEN 1000
                ELSE ceil(greatest(s.lo - ta.energy, ta.energy - s.hi, 0) / 5.0)
              END,
              (s.inst_pref = 'soft' AND coalesce(ta.instrumentalness, 0) < 85)::int,
              (s.pop_pref  = 'soft' AND coalesce(ta.popularity, 0) < hit_popularity_floor(s.genre))::int,
              random()
            LIMIT 1
        ) AS pick
        WHERE s.rank NOT IN (SELECT t.rank FROM tier1 t)
    )
    SELECT t.rank, t.spotify_id FROM tier1 t
    UNION ALL
    SELECT t.rank, t.spotify_id FROM tier2 t;
$$;
