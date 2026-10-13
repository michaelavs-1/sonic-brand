-- ============================================================================
-- 2026-10-13 — v7 energy windows: the daily playlists take their songs from
-- inside an energy range (track_analyses.energy, 0-100), and widen it by 5 on
-- each side only when the range is short of songs.
--
-- The rules (Roni, 2026-10-13; the numbers live in
-- v7/generation/energy-windows.js, the callers pass them in):
--   Option 1 — high-energy playlists 50-80, calm playlists 20-50.
--   Option 2 — each level of the owner's scale gets a range: 20-80 split into
--              N ranges whose neighbours overlap by 20 (4 levels: 20-50,
--              30-60, 40-70, 50-80).
--
-- How the widening works: every candidate track gets a "ring" = how many
-- 5-point steps outside the range its energy is (0 = inside, 1 = at most 5
-- outside, ...; a track with no energy value comes last). Tracks are taken
-- ring by ring, so a short range widens exactly as far as it needs to. With
-- no range (NULL) every track is ring 0, i.e. exactly the old behaviour.
-- Songs the business heard in the last 7 days stay out of the pool either
-- way; the callers refill with them only when even the widened pool is short.
--
-- What changes:
--   1. v6_direction_tracks_recent (Option 1) — two new optional parameters,
--      p_energy_lo / p_energy_hi (DEFAULT NULL = no range). The ring sorts
--      first, ahead of the soft instrumental / popularity preferences. A new
--      parameter list makes a new function, so the old one is dropped first
--      (two versions would make PostgREST's choice ambiguous). Callers that
--      pass neither parameter (v6, Ami's test playlists, scripts) get exactly
--      what they got before.
--   2. v7_timeline_pool (Option 2) — each spec may carry "lo" / "hi"; the
--      result gains `energy` and `ring` columns, so the builder can use every
--      in-range song of a level (across all its genres) before widening. A
--      new result type means drop + create + grant again.
--
-- v5/precompute/v5-rpc-functions.sql carries the same
-- v6_direction_tracks_recent — keep them identical.
--
-- Until this runs, the builders fall back to building without the ranges.
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Check after: node scripts/test-energy-windows-live.mjs
-- ============================================================================

-- ---- 1. v6_direction_tracks_recent (Option 1 daily playlists) --------------
-- Previous signature (2026-09-02 → 2026-10-11): no energy parameters.
DROP FUNCTION IF EXISTS v6_direction_tracks_recent(text[], int, int, int, int, int, uuid, text, int, text, text);

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
    p_pop_pref      text DEFAULT 'none',
    p_energy_lo     int  DEFAULT NULL,
    p_energy_hi     int  DEFAULT NULL
) RETURNS TABLE (
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT
            ta.spotify_id,
            ta.instrumentalness,
            ta.energy,
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
        GROUP BY ta.spotify_id, ta.instrumentalness, ta.energy
    )
    SELECT spotify_id
    FROM candidates
    ORDER BY
      -- Energy ring: 5-point steps outside [p_energy_lo, p_energy_hi].
      (CASE
         WHEN p_energy_lo IS NULL OR p_energy_hi IS NULL THEN 0
         WHEN energy IS NULL THEN 999
         ELSE ceil(greatest(p_energy_lo - energy, energy - p_energy_hi, 0) / 5.0)::int
       END),
      (p_inst_pref = 'soft' AND coalesce(instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND NOT is_hit)::int,
      random()
    LIMIT p_limit;
$$;

-- ---- 2. v7_timeline_pool (Option 2 daily mixes) ----------------------------
-- Was (2026-10-11): RETURNS (genre, spotify_id, duration_sec), no ranges.
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
RETURNS TABLE (genre text, spotify_id text, duration_sec int, energy int, ring int)
LANGUAGE sql VOLATILE   -- random()
AS $$
    WITH specs AS (
        SELECT
            lower(e->>'genre')                                                  AS genre,
            least(600, greatest(1, coalesce((e->>'n')::int, 10)))               AS n,
            least(200, greatest(1, coalesce((e->>'playlists')::int, 8)))        AS pl,
            (e->>'lo')::int                                                     AS lo,   -- NULL = no range
            (e->>'hi')::int                                                     AS hi
        FROM jsonb_array_elements(p_specs) AS e
    ),
    recent AS MATERIALIZED (
        SELECT DISTINCT h.spotify_id
        FROM v6_daily_track_history h
        WHERE p_exclude_days > 0
          AND h.business_id = p_biz_id
          AND h.served_at > now() - make_interval(days => p_exclude_days)
    )
    SELECT s.genre, c.spotify_id, c.duration_sec, c.energy, c.ring
    FROM specs s
    CROSS JOIN LATERAL (
        SELECT
            t.spotify_id, t.duration_sec, t.energy,
            -- Energy ring: 5-point steps outside [lo, hi].
            (CASE
               WHEN s.lo IS NULL OR s.hi IS NULL THEN 0
               WHEN t.energy IS NULL THEN 999
               ELSE ceil(greatest(s.lo - t.energy, t.energy - s.hi, 0) / 5.0)::int
             END) AS ring,
            t.instrumentalness, t.popularity
        FROM (
            SELECT DISTINCT ta.spotify_id, ta.duration_sec, ta.energy, ta.instrumentalness, ta.popularity
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
            ring,
            (p_inst_pref = 'soft' AND coalesce(t.instrumentalness, 0) < 85)::int,
            (p_pop_pref  = 'soft' AND coalesce(t.popularity, 0) < hit_popularity_floor(s.genre))::int,
            random()
        LIMIT s.n
    ) AS c;
$$;

GRANT EXECUTE ON FUNCTION v7_timeline_pool(uuid, jsonb, text, text, int, int, int) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---- checks (run after) ----------------------------------------------------
-- Option 1, a calm range: the first rows are inside 20-50, then it widens.
--   SELECT ta.energy
--   FROM v6_direction_tracks_recent(ARRAY['Bossa Nova'], 0, 300, 0, 100, 20,
--        '00000000-0000-0000-0000-000000000000', 'check', 0, 'none', 'none', 20, 50) r
--   JOIN track_analyses ta USING (spotify_id);
-- Option 2, how many of each genre's rows are inside the range (ring 0):
--   SELECT genre, ring, count(*) FROM v7_timeline_pool(
--     '00000000-0000-0000-0000-000000000000',
--     '[{"genre":"Bossa Nova","n":60,"playlists":20,"lo":20,"hi":50},
--       {"genre":"Disco","n":60,"playlists":20,"lo":50,"hi":80}]')
--   GROUP BY genre, ring ORDER BY genre, ring;
