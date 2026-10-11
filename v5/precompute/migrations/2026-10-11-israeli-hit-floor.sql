-- ============================================================================
-- 2026-10-11 — Israeli genres get their own "hit" floor: popularity 45+,
-- not 60+.
--
-- Why: Spotify's popularity score is global, and Israel is a small market, so
-- Israeli tracks score low. Measured 2026-10-11 over the 2,749 analysed
-- tracks in the six Israeli genres: the middle track scores 45, and only 232
-- (8%) reach 60. With 60 as the floor, an owner who asked for hits got almost
-- no Israeli music (רוק ישראלי: 7 of 326 tracks). 45 = the median of the six
-- genres combined, i.e. the more-played half of the Israeli catalog:
--   בלדות ישראליות 265/523, פופ מזרחית 465/550, מזרחית ישנה 179/324,
--   רוק ישראלי 162/326, שירי ארץ ישראל 470/1068,
--   שירי יום הזיכרון והשואה 210/586.
-- Every other genre keeps 60 (the top ~13% of the non-Israeli catalog).
--
-- What changes:
--   1. hit_popularity_floor(genre) — 45 for the six Israeli genres, 60 for
--      every other genre. The ONE place the numbers live. A new Israeli genre
--      added to shared/genre-universe.js must be added here too.
--   2. Every track function v7 uses applies the floor of the genre a track
--      was found through, for both preferences:
--        pop_pref 'hard' → popularity between the floor and 100;
--        pop_pref 'soft' → tracks at or above the floor sort first.
--      A track found through several requested genres counts as a hit if it
--      clears the floor of any of them.
--        v7_anchor_tracks          — swipe deck
--        v6_direction_tracks_recent — Option 1 daily playlists
--        v7_timeline_pool          — Option 2 daily mixes
--        v5_direction_tracks       — special playlists
--        v7_energy_tracks          — Ami's energy test playlists
--      Same signatures and return types, so CREATE OR REPLACE keeps the
--      existing grants and every caller works unchanged.
--
-- Not changed: v5_anchor_tracks (the v6 swipe deck only; v6 has no accounts).
--
-- v5/precompute/v5-rpc-functions.sql carries the same definitions of
-- hit_popularity_floor, v5_direction_tracks and v6_direction_tracks_recent —
-- keep them identical.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Check after: node scripts/test-israeli-hit-floor.mjs
-- ============================================================================

-- ---- 1. the floor ----------------------------------------------------------
-- playlist_genres.genre is stored lowercase; lower() makes the input side
-- match whatever case the caller passes. IMMUTABLE + a single expression, so
-- the planner inlines it.
CREATE OR REPLACE FUNCTION hit_popularity_floor(p_genre text)
RETURNS int
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN lower(p_genre) IN (
            'בלדות ישראליות',
            'פופ מזרחית',
            'מזרחית ישנה',
            'רוק ישראלי',
            'שירי ארץ ישראל',
            'שירי יום הזיכרון והשואה'
        ) THEN 45
        ELSE 60
    END
$$;

-- v7_anchor_tracks runs on the anon key, so anon needs it too.
GRANT EXECUTE ON FUNCTION hit_popularity_floor(text) TO anon, authenticated, service_role;

-- ---- 2a. v7_anchor_tracks (swipe deck) -------------------------------------
-- Was: popularity BETWEEN 60 AND 100 / popularity < 60.
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
            coalesce(lower(elem->>'pop_pref'),  'none')  AS pop_pref
        FROM jsonb_array_elements(p_specs) AS elem
    ),
    -- Tier 1: 8 random playlists per genre. MATERIALIZED so it runs once;
    -- the NOT IN below would otherwise re-evaluate it.
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
            ORDER BY
              (s.inst_pref = 'soft' AND coalesce(ta.instrumentalness, 0) < 85)::int,
              (s.pop_pref  = 'soft' AND coalesce(ta.popularity, 0) < hit_popularity_floor(s.genre))::int,
              random()
            LIMIT 1
        ) AS pick
    ),
    -- Tier 2: only for specs tier 1 couldn't satisfy — a wider sample of 200
    -- playlists. Bounded, and runs for few (usually zero) specs.
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

-- ---- 2b. v6_direction_tracks_recent (Option 1 daily playlists) -------------
-- Was: SELECT DISTINCT ... popularity BETWEEN 60 AND 100 (hard) /
-- popularity < 60 (soft). Now grouped per track so a track found through two
-- genres is one candidate, a hit if it clears either genre's floor.
CREATE OR REPLACE FUNCTION v6_direction_tracks_recent(
    p_genres        text[],
    p_bpm_lo        int,
    p_bpm_hi        int,
    p_pop_lo        int,
    p_pop_hi        int,
    p_limit         int,
    p_biz_id        uuid,
    p_direction_key text,
    p_exclude_days  int  DEFAULT 7,
    p_inst_pref     text DEFAULT 'none',
    p_pop_pref      text DEFAULT 'none'
) RETURNS TABLE (
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT
            ta.spotify_id,
            ta.instrumentalness,
            bool_or(coalesce(ta.popularity, 0) >= hit_popularity_floor(pg.genre)) AS is_hit
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          AND ta.tempo BETWEEN p_bpm_lo AND p_bpm_hi
          -- Effective popularity window: hard pop_pref overrides to
          -- [genre's hit floor, 100].
          AND ta.popularity BETWEEN
              (CASE WHEN p_pop_pref = 'hard' THEN hit_popularity_floor(pg.genre) ELSE p_pop_lo END)
              AND
              (CASE WHEN p_pop_pref = 'hard' THEN 100 ELSE p_pop_hi END)
          AND (p_inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
          AND (
              p_exclude_days <= 0
              OR ta.spotify_id NOT IN (
                  SELECT h.spotify_id
                  FROM v6_daily_track_history h
                  WHERE h.business_id   = p_biz_id
                    AND h.direction_key = p_direction_key
                    AND h.served_at > now() - (p_exclude_days || ' days')::interval
              )
          )
        GROUP BY ta.spotify_id, ta.instrumentalness
    )
    SELECT spotify_id
    FROM candidates
    ORDER BY
      (p_inst_pref = 'soft' AND coalesce(instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND NOT is_hit)::int,
      random()
    LIMIT p_limit;
$$;

-- ---- 2c. v7_timeline_pool (Option 2 daily mixes) ---------------------------
-- Was: popularity BETWEEN 60 AND 100 / popularity < 60.
CREATE OR REPLACE FUNCTION v7_timeline_pool(
    p_biz_id       uuid,
    p_specs        jsonb,
    p_inst_pref    text DEFAULT 'none',
    p_pop_pref     text DEFAULT 'none',
    p_exclude_days int  DEFAULT 7,
    p_min_sec      int  DEFAULT 45,
    p_max_sec      int  DEFAULT 900
)
RETURNS TABLE (genre text, spotify_id text, duration_sec int)
LANGUAGE sql VOLATILE   -- random()
AS $$
    WITH specs AS (
        SELECT
            lower(e->>'genre')                                                  AS genre,
            least(600, greatest(1, coalesce((e->>'n')::int, 10)))               AS n,
            least(200, greatest(1, coalesce((e->>'playlists')::int, 8)))        AS pl
        FROM jsonb_array_elements(p_specs) AS e
    ),
    recent AS MATERIALIZED (
        SELECT DISTINCT h.spotify_id
        FROM v6_daily_track_history h
        WHERE p_exclude_days > 0
          AND h.business_id = p_biz_id
          AND h.served_at > now() - make_interval(days => p_exclude_days)
    )
    SELECT s.genre, c.spotify_id, c.duration_sec
    FROM specs s
    CROSS JOIN LATERAL (
        SELECT t.spotify_id, t.duration_sec
        FROM (
            SELECT DISTINCT ta.spotify_id, ta.duration_sec, ta.instrumentalness, ta.popularity
            FROM (
                SELECT pg.playlist_id
                FROM playlist_genres pg
                WHERE pg.genre = s.genre
                ORDER BY random()
                LIMIT s.pl
            ) pl
            JOIN playlist_tracks pt ON pt.playlist_id = pl.playlist_id
            JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
            WHERE ta.status = 'ok'
              AND (p_inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
              AND (p_pop_pref  <> 'hard' OR ta.popularity BETWEEN hit_popularity_floor(s.genre) AND 100)
              AND (ta.duration_sec IS NULL OR ta.duration_sec BETWEEN p_min_sec AND p_max_sec)
              AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.spotify_id = ta.spotify_id)
        ) t
        ORDER BY
            (p_inst_pref = 'soft' AND coalesce(t.instrumentalness, 0) < 85)::int,
            (p_pop_pref  = 'soft' AND coalesce(t.popularity, 0) < hit_popularity_floor(s.genre))::int,
            random()
        LIMIT s.n
    ) AS c;
$$;

-- ---- 2d. v5_direction_tracks (special playlists) ---------------------------
-- Same change as v6_direction_tracks_recent.
CREATE OR REPLACE FUNCTION v5_direction_tracks(
    p_genres    text[],
    p_bpm_lo    int,
    p_bpm_hi    int,
    p_pop_lo    int,
    p_pop_hi    int,
    p_limit     int  DEFAULT 10,
    p_inst_pref text DEFAULT 'none',
    p_pop_pref  text DEFAULT 'none'
) RETURNS TABLE (
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT
            ta.spotify_id,
            ta.instrumentalness,
            bool_or(coalesce(ta.popularity, 0) >= hit_popularity_floor(pg.genre)) AS is_hit
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          AND ta.tempo BETWEEN p_bpm_lo AND p_bpm_hi
          -- Effective popularity window: hard pop_pref overrides to
          -- [genre's hit floor, 100].
          AND ta.popularity BETWEEN
              (CASE WHEN p_pop_pref = 'hard' THEN hit_popularity_floor(pg.genre) ELSE p_pop_lo END)
              AND
              (CASE WHEN p_pop_pref = 'hard' THEN 100 ELSE p_pop_hi END)
          AND (p_inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
        GROUP BY ta.spotify_id, ta.instrumentalness
    )
    SELECT spotify_id
    FROM candidates
    ORDER BY
      (p_inst_pref = 'soft' AND coalesce(instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND NOT is_hit)::int,
      random()
    LIMIT p_limit;
$$;

-- ---- 2e. v7_energy_tracks (Ami's energy test playlists) --------------------
-- Same change, keeping its own pool (bpm 0-300, popularity 0-100 unless hard).
CREATE OR REPLACE FUNCTION v7_energy_tracks(
    p_genres     text[],
    p_energy_lo  int,
    p_energy_hi  int,
    p_inst_pref  text DEFAULT 'none',
    p_pop_pref   text DEFAULT 'none',
    p_limit      int  DEFAULT 50
) RETURNS TABLE (
    spotify_id text,
    energy     int,
    matches    bigint
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT
            ta.spotify_id,
            ta.energy,
            ta.instrumentalness,
            bool_or(coalesce(ta.popularity, 0) >= hit_popularity_floor(pg.genre)) AS is_hit
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          -- Same pool as Option 1 (it passes bpm 0-300, popularity 0-100).
          AND ta.tempo BETWEEN 0 AND 300
          AND ta.popularity BETWEEN (CASE WHEN p_pop_pref = 'hard' THEN hit_popularity_floor(pg.genre) ELSE 0 END) AND 100
          AND (p_inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
          AND ta.energy BETWEEN p_energy_lo AND p_energy_hi
        GROUP BY ta.spotify_id, ta.energy, ta.instrumentalness
    )
    SELECT c.spotify_id, c.energy, count(*) OVER () AS matches
    FROM candidates c
    ORDER BY
      (p_inst_pref = 'soft' AND coalesce(c.instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND NOT c.is_hit)::int,
      random()
    LIMIT p_limit;
$$;

NOTIFY pgrst, 'reload schema';

-- ---- checks (run after) ----------------------------------------------------
--   SELECT hit_popularity_floor('רוק ישראלי'), hit_popularity_floor('Rock');   -- 45, 60
-- Hard + an Israeli genre: lowest score should be 45, not 60:
--   SELECT min(ta.popularity), count(*)
--   FROM v6_direction_tracks_recent(ARRAY['רוק ישראלי'], 0, 300, 0, 100, 1000,
--        '00000000-0000-0000-0000-000000000000', 'check', 0, 'none', 'hard') r
--   JOIN track_analyses ta USING (spotify_id);
