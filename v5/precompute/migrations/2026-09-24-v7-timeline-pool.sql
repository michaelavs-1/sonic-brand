-- ============================================================================
-- 2026-09-24 — v7 Option 2 (energy timeline): track durations + the track-pool
-- RPC the Option-2 builder uses. ADDITIVE ONLY — nothing v6 uses changes.
--
-- 1. track_analyses.duration_sec (int, nullable)
--    Track length in seconds. The analysis API's raw_analysis->>'duration' is
--    "m:ss" / "mm:ss" text (4,000/4,000 rows sampled 2026-09-24), mean ≈ 4.16
--    min. Option 2 lays tracks end to end by duration so the playlist's energy
--    follows the owner's timeline through the day — it needs this per track.
--
--    Plain column + trigger, NOT a GENERATED ... STORED column: adding a
--    generated column rewrites the whole table under an exclusive lock, which
--    would stall the anon swipe-deck RPCs (3s timeout) and Ami's analysis
--    writes while ~125k jsonb rows are copied. ADD COLUMN (nullable, no
--    default) is metadata-only.
--
--    The trigger fills it on every INSERT and every UPDATE that sets
--    raw_analysis — which covers all four analysis writers (batch.mjs,
--    add-playlist.mjs, deepen-genres.mjs, api/v4/ami-cron-tick.js: PostgREST
--    upserts include raw_analysis in the SET list) with no JS changes. The
--    parser never throws — unknown shapes become NULL (the builder then
--    assumes ~250 s for that track).
--
-- 2. v7_timeline_pool(...) — random candidate tracks per genre, with duration.
--    Same cheap sampling pattern as v7_anchor_tracks (random playlists of the
--    genre → their tracks → PK lookups), so work is bounded by the sample, not
--    the catalog. Excludes tracks served to this business in the last
--    p_exclude_days days (any playlist/direction — so switching Option 1 → 2
--    also avoids today's Option-1 tracks). Server-only (service_role).
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

-- ---- 1a. parser -------------------------------------------------------------
CREATE OR REPLACE FUNCTION v7_parse_duration_sec(p text)
RETURNS int
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p ~ '^\s*\d{1,3}:\d{2}\s*$'
            THEN split_part(btrim(p), ':', 1)::int * 60
               + split_part(btrim(p), ':', 2)::int
        WHEN p ~ '^\s*\d{1,2}:\d{2}:\d{2}\s*$'
            THEN split_part(btrim(p), ':', 1)::int * 3600
               + split_part(btrim(p), ':', 2)::int * 60
               + split_part(btrim(p), ':', 3)::int
        ELSE NULL
    END
$$;

-- ---- 1b. column -------------------------------------------------------------
ALTER TABLE track_analyses ADD COLUMN IF NOT EXISTS duration_sec int;

-- ---- 1c. trigger ------------------------------------------------------------
CREATE OR REPLACE FUNCTION v7_track_analyses_duration()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    BEGIN
        NEW.duration_sec := v7_parse_duration_sec(NEW.raw_analysis->>'duration');
    EXCEPTION WHEN others THEN
        NEW.duration_sec := NULL;   -- never block an analysis write
    END;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_v7_track_duration ON track_analyses;
CREATE TRIGGER trg_v7_track_duration
    BEFORE INSERT OR UPDATE OF raw_analysis ON track_analyses
    FOR EACH ROW EXECUTE FUNCTION v7_track_analyses_duration();

-- ---- 1d. backfill existing rows ---------------------------------------------
-- Sets only duration_sec, so the trigger above doesn't fire. ~125k rows.
-- If the SQL editor ever times out on this, run the same statement with
-- "AND spotify_id IN (SELECT spotify_id FROM track_analyses WHERE
-- duration_sec IS NULL AND raw_analysis ? 'duration' LIMIT 30000)" appended,
-- repeatedly, until it reports UPDATE 0.
UPDATE track_analyses
SET duration_sec = v7_parse_duration_sec(raw_analysis->>'duration')
WHERE duration_sec IS NULL
  AND raw_analysis ? 'duration';

-- ---- 2. the pool RPC --------------------------------------------------------
-- Input:  p_specs jsonb — [{ "genre": text, "n": int, "playlists": int }, ...]
--           n          = how many tracks to return for that genre (≤ 600)
--           playlists  = how many random playlists of that genre to sample (≤ 200)
-- Output: (genre text [lowercase], spotify_id text, duration_sec int|null),
--         up to n rows per genre, random order (soft preferences first).
-- Preferences match v5_anchor_tracks / v7_anchor_tracks:
--   inst 'hard' → instrumentalness >= 85; 'soft' → instrumentals first.
--   pop  'hard' → popularity 60-100;      'soft' → hits (>= 60) first.
-- Tracks shorter than p_min_sec / longer than p_max_sec are skipped (intros,
-- interludes, 20-minute live jams); unknown durations pass.
DROP FUNCTION IF EXISTS v7_timeline_pool(uuid, jsonb, text, text, int, int, int);

CREATE FUNCTION v7_timeline_pool(
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
              AND (p_pop_pref  <> 'hard' OR ta.popularity BETWEEN 60 AND 100)
              AND (ta.duration_sec IS NULL OR ta.duration_sec BETWEEN p_min_sec AND p_max_sec)
              AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.spotify_id = ta.spotify_id)
        ) t
        ORDER BY
            (p_inst_pref = 'soft' AND coalesce(t.instrumentalness, 0) < 85)::int,
            (p_pop_pref  = 'soft' AND coalesce(t.popularity, 0) < 60)::int,
            random()
        LIMIT s.n
    ) AS c;
$$;

GRANT EXECUTE ON FUNCTION v7_timeline_pool(uuid, jsonb, text, text, int, int, int) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---- checks (run after) -----------------------------------------------------
-- Expect ~0 rows without a duration, and an average around 4.1–4.2 minutes:
--   SELECT count(*) FILTER (WHERE duration_sec IS NULL)            AS no_duration,
--          count(*)                                                AS total_ok,
--          round(avg(duration_sec) / 60.0, 2)                      AS avg_minutes,
--          percentile_cont(0.01) WITHIN GROUP (ORDER BY duration_sec) AS p1_sec,
--          percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_sec) AS p99_sec
--   FROM track_analyses WHERE status = 'ok';
-- Smoke-test the RPC (any business id works; history exclusion just finds nothing):
--   SELECT genre, count(*), round(avg(duration_sec)) FROM v7_timeline_pool(
--     '00000000-0000-0000-0000-000000000000',
--     '[{"genre":"Bossa Nova","n":40,"playlists":12},{"genre":"Neo Soul","n":40,"playlists":12}]')
--   GROUP BY genre;
