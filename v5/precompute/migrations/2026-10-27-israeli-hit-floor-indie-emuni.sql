-- ============================================================================
-- 2026-10-27 — Two more Israeli genres get the Israeli hit floor (40+).
--
-- אינדי ישראלי and פופ אמוני ישראלי joined shared/genre-universe.js today. Like
-- the other Israeli genres, a "hit" in them is popularity 40+, not 60+.
-- Measured 2026-10-27 (analysed tracks):
--   אינדי ישראלי      673 analysed · 40+ 203 (30%) · 60+ 109 (16%)
--   פופ אמוני ישראלי  330 analysed · 40+ 210 (64%) · 60+  75 (23%)
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
            'היפ הופ ישראלי',
            'אינדי ישראלי',
            'פופ אמוני ישראלי'
        ) THEN 40
        ELSE 60
    END
$$;

GRANT EXECUTE ON FUNCTION hit_popularity_floor(text) TO anon, authenticated, service_role;

-- ---- check (run after) -------------------------------------------------------
--   SELECT hit_popularity_floor('אינדי ישראלי'), hit_popularity_floor('פופ אמוני ישראלי'),
--          hit_popularity_floor('Rock');   -- 40, 40, 60
