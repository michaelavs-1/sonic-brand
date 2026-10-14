-- ============================================================================
-- 2026-10-14 — "well-known songs" changes (Ami).
--
-- 1. Israeli genres: a hit is popularity 30+ (was 45+ since 2026-10-11).
--    Measured 2026-10-14 over the six Israeli genres (3,399 analysed tracks):
--    30+ keeps 2,845 (84%), 45+ kept 1,768, 60+ keeps 257.
--      בלדות ישראליות 481/545, פופ מזרחית 527/550, מזרחית ישנה 287/324,
--      רוק ישראלי 289/326, שירי ארץ ישראל 858/1068,
--      שירי יום הזיכרון והשואה 403/586.
--    Every other genre keeps 60. Only hit_popularity_floor changes: every
--    track function reads the floor from it (see
--    2026-10-11-israeli-hit-floor.sql), so nothing else needs replacing.
--    v5/precompute/v5-rpc-functions.sql carries the same definition — keep
--    them identical. A new Israeli genre must be added here too.
--
-- 2. business_taste_profiles.popularity_tiers — Option 1's "well-known songs"
--    per energy tier, set by the taste chat:
--      {"high": "hard", "low": "none"}   values 'none' | 'soft' | 'hard'
--    NULL = both tiers follow popularity_preference (the whole account).
--    Written only when the two tiers differ. Option 2 and the special
--    playlists keep using popularity_preference.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Check after: node scripts/test-israeli-hit-floor.mjs
-- ============================================================================

-- ---- 1. the floor ------------------------------------------------------------
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
        ) THEN 30
        ELSE 60
    END
$$;

GRANT EXECUTE ON FUNCTION hit_popularity_floor(text) TO anon, authenticated, service_role;

-- ---- 2. per-tier popularity (Option 1) ---------------------------------------
ALTER TABLE business_taste_profiles ADD COLUMN IF NOT EXISTS popularity_tiers jsonb;

NOTIFY pgrst, 'reload schema';

-- ---- checks (run after) ------------------------------------------------------
--   SELECT hit_popularity_floor('רוק ישראלי'), hit_popularity_floor('Rock');   -- 30, 60
--   SELECT popularity_tiers FROM business_taste_profiles LIMIT 1;
