-- ============================================================================
-- 2026-10-14 — Israeli genres: a hit is popularity 40+ (Roni).
--
-- Earlier the same day 2026-10-14-v7-popularity.sql set it to 30 (Ami's
-- request); 30 let 84% of the Israeli catalog count as hits, so "only hits"
-- barely narrowed it. 40 sits between that and the previous 45.
-- Measured 2026-10-14 over the six Israeli genres (3,399 analysed tracks):
--   30+ 2,845 (84%) · 40+ 2,293 (67%) · 45+ 1,768 (52%) · 60+ 257 (8%)
--     בלדות ישראליות 384/545, פופ מזרחית 501/550, מזרחית ישנה 211/324,
--     רוק ישראלי 218/326, שירי ארץ ישראל 677/1068,
--     שירי יום הזיכרון והשואה 302/586   (40+)
-- Every other genre keeps 60. Only hit_popularity_floor changes: every track
-- function reads the floor from it (see 2026-10-11-israeli-hit-floor.sql).
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
            'שירי יום הזיכרון והשואה'
        ) THEN 40
        ELSE 60
    END
$$;

GRANT EXECUTE ON FUNCTION hit_popularity_floor(text) TO anon, authenticated, service_role;

-- ---- check (run after) -------------------------------------------------------
--   SELECT hit_popularity_floor('רוק ישראלי'), hit_popularity_floor('Rock');   -- 40, 60
