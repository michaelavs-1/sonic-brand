-- ============================================================================
-- 2026-10-15 — Two new Israeli genres get the Israeli hit floor (40+).
--
-- פופ ישראלי and היפ הופ ישראלי joined shared/genre-universe.js today. Like the
-- other six Israeli genres, a "hit" in them is popularity 40+, not 60+.
-- Measured 2026-10-15 (analysed tracks, the batch still retrying failures):
--   פופ ישראלי      535 analysed · 40+ 396 (74%) · 60+ 125 (23%)
--   היפ הופ ישראלי  858 analysed · 40+ 411 (48%) · 60+ 152 (18%)
-- Only hit_popularity_floor changes: every track function reads the floor
-- from it (see 2026-10-11-israeli-hit-floor.sql). The floor itself stays 40
-- (2026-10-14-israeli-hit-floor-40.sql).
-- v5/precompute/v5-rpc-functions.sql carries the same definition — keep them
-- identical. A new Israeli genre must be added here too.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Check after: node scripts/test-israeli-hit-floor.mjs
-- ============================================================================

-- playlist_genres.genre is stored lowercase; lower() makes the input side
-- match whatever case the caller passes. IMMUTABLE + a single expression, so
-- the planner inlines it into the track functions.
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
            'שירי יום הזיכרון והשואה',
            'פופ ישראלי',
            'היפ הופ ישראלי'
        ) THEN 40
        ELSE 60
    END
$$;

GRANT EXECUTE ON FUNCTION hit_popularity_floor(text) TO anon, authenticated, service_role;

-- ---- check (run after) -------------------------------------------------------
--   SELECT hit_popularity_floor('פופ ישראלי'), hit_popularity_floor('היפ הופ ישראלי'),
--          hit_popularity_floor('Rock');   -- 40, 40, 60
