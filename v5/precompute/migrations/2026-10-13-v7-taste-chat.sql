-- ============================================================================
-- 2026-10-13 — v7 taste chat ("הטעם המוזיקלי שלכם", Home tab).
--
-- The chat lets an owner change their taste profile and their energy ranges
-- (design agreed with Roni, 2026-10-13; code: api/v7/account/taste-chat.js +
-- taste-apply.js, v7/generation/taste-ops.js). This adds what it stores and
-- what the daily builders read from it.
--
-- 1. business_taste_profiles
--    - genre_weights   {"Rnb": 0.5, ...} — how much a genre plays, per genre,
--                      for the whole profile. Missing = 1 (= today's mix:
--                      a genre plays in proportion to its catalog). Steps
--                      0.25 / 0.5 / 1.5 / 2.
--    - rejected_genres ["Reggaeton", ...] — genres the owner turned down
--                      (the chat's genre deck never offers them again).
-- 2. business_v7_settings.energy_windows — Option 1's two windows,
--    {"high": [50, 80], "low": [20, 50]}. NULL = those defaults.
-- 3. business_v7_level_directions.energy_range — one Option 2 recipe's range
--    [min, max]. NULL = its level's default (v7/generation/energy-windows.js).
-- 4. business_allowed_tracks — songs an owner sent the chat (as a Spotify
--    link) that play in THEIR playlists only, under one of their genres. A
--    song we haven't analysed plays as though it were inside the energy range.
-- 5. business_taste_changes — every change the chat applied, with the before
--    and after state (what "undo" restores).
-- 6. v6_direction_tracks_recent (Option 1) — p_genre_weights + the business's
--    allowed songs.
-- 7. v7_timeline_pool (Option 2) — a spec `key` (one pool per genre AND
--    range, since recipes at a level may now have different ranges) + the
--    business's allowed songs.
--
-- Until this runs, the builders and the chat fall back to working without
-- these (and say so in the logs).
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Check after: node scripts/test-energy-windows-live.mjs
-- ============================================================================

-- ---- 1–3. columns ------------------------------------------------------------
ALTER TABLE business_taste_profiles      ADD COLUMN IF NOT EXISTS genre_weights   jsonb;
ALTER TABLE business_taste_profiles      ADD COLUMN IF NOT EXISTS rejected_genres jsonb;
ALTER TABLE business_v7_settings         ADD COLUMN IF NOT EXISTS energy_windows  jsonb;
ALTER TABLE business_v7_level_directions ADD COLUMN IF NOT EXISTS energy_range    jsonb;

-- ---- 4. the owner's own songs --------------------------------------------------
CREATE TABLE IF NOT EXISTS business_allowed_tracks (
  id           bigserial   PRIMARY KEY,
  business_id  uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  spotify_id   text        NOT NULL,
  genre        text        NOT NULL,          -- canonical, shared/genre-universe.js
  title        text,
  artist       text,
  duration_sec int,
  added_at     timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  UNIQUE (business_id, spotify_id)
);
CREATE INDEX IF NOT EXISTS business_allowed_tracks_live_idx
  ON business_allowed_tracks (business_id) WHERE removed_at IS NULL;
ALTER TABLE business_allowed_tracks ENABLE ROW LEVEL SECURITY;   -- server-only (service role)

-- ---- 5. change log ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_taste_changes (
  id            bigserial   PRIMARY KEY,
  business_id   uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  delivery_mode text,
  ops           jsonb       NOT NULL,
  summary_he    text,
  before        jsonb       NOT NULL,
  after         jsonb       NOT NULL,
  message_id    uuid        REFERENCES business_direction_chats(id) ON DELETE SET NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz
);
CREATE INDEX IF NOT EXISTS business_taste_changes_biz_idx
  ON business_taste_changes (business_id, applied_at DESC);
ALTER TABLE business_taste_changes ENABLE ROW LEVEL SECURITY;    -- server-only (service role)

-- ---- 6. v6_direction_tracks_recent (Option 1 daily playlists) ---------------
-- Previous signature (2026-10-13 energy windows): no p_genre_weights.
DROP FUNCTION IF EXISTS v6_direction_tracks_recent(text[], int, int, int, int, int, uuid, text, int, text, text, int, int);

-- Weights: a track's chance is scaled by its genre's weight (the highest, when
-- it's in two of the requested genres). Done with weighted random keys —
-- -ln(1 - random()) / weight, smallest first — so with every weight 1 the
-- order is exactly a uniform random one (today's mix).
-- Allowed songs (business_allowed_tracks, under one of p_genres): skip the
-- tempo / popularity / instrumental filters (the owner asked for that song),
-- still respect the 7-day history, and count as inside the energy range until
-- they're analysed.
CREATE OR REPLACE FUNCTION v6_direction_tracks_recent(
    p_genres        text[],
    p_bpm_lo        int,
    p_bpm_hi        int,
    p_pop_lo        int,
    p_pop_hi        int,
    p_limit         int,
    p_biz_id        uuid,
    p_direction_key text,
    p_exclude_days  int   DEFAULT 7,
    p_inst_pref     text  DEFAULT 'none',
    p_pop_pref      text  DEFAULT 'none',
    p_energy_lo     int   DEFAULT NULL,
    p_energy_hi     int   DEFAULT NULL,
    p_genre_weights jsonb DEFAULT NULL
) RETURNS TABLE (
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH recent AS (
        SELECT h.spotify_id
        FROM v6_daily_track_history h
        WHERE p_exclude_days > 0
          AND h.business_id   = p_biz_id
          AND h.direction_key = p_direction_key
          AND h.served_at > now() - (p_exclude_days || ' days')::interval
    ),
    catalog AS (
        SELECT
            ta.spotify_id,
            ta.instrumentalness,
            ta.energy,
            bool_or(coalesce(ta.popularity, 0) >= hit_popularity_floor(pg.genre)) AS is_hit,
            max(coalesce((p_genre_weights->>pg.genre)::numeric, 1))               AS weight,
            false                                                                 AS allowed
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
          AND ta.spotify_id NOT IN (SELECT r.spotify_id FROM recent r)
        GROUP BY ta.spotify_id, ta.instrumentalness, ta.energy
    ),
    own_songs AS (
        SELECT DISTINCT ON (a.spotify_id)
            a.spotify_id,
            ta.instrumentalness,
            ta.energy,
            true                                                       AS is_hit,
            coalesce((p_genre_weights->>lower(a.genre))::numeric, 1)   AS weight,
            true                                                       AS allowed
        FROM business_allowed_tracks a
        LEFT JOIN track_analyses ta ON ta.spotify_id = a.spotify_id AND ta.status = 'ok'
        WHERE a.business_id = p_biz_id
          AND a.removed_at IS NULL
          AND lower(a.genre) = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          AND a.spotify_id NOT IN (SELECT r.spotify_id FROM recent r)
        ORDER BY a.spotify_id
    ),
    candidates AS (
        SELECT * FROM catalog c WHERE c.spotify_id NOT IN (SELECT o.spotify_id FROM own_songs o)
        UNION ALL
        SELECT * FROM own_songs
    )
    SELECT spotify_id
    FROM candidates
    ORDER BY
      -- Energy ring: 5-point steps outside [p_energy_lo, p_energy_hi].
      (CASE
         WHEN p_energy_lo IS NULL OR p_energy_hi IS NULL THEN 0
         WHEN energy IS NULL THEN (CASE WHEN allowed THEN 0 ELSE 999 END)
         ELSE ceil(greatest(p_energy_lo - energy, energy - p_energy_hi, 0) / 5.0)::int
       END),
      (p_inst_pref = 'soft' AND NOT allowed AND coalesce(instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND NOT is_hit)::int,
      -ln(1 - random()) / greatest(weight, 0.01)
    LIMIT p_limit;
$$;

-- ---- 7. v7_timeline_pool (Option 2 daily mixes) ----------------------------
-- Was (2026-10-13 energy windows): no spec key, no allowed songs.
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
RETURNS TABLE (key text, genre text, spotify_id text, duration_sec int, energy int, ring int, allowed boolean)
LANGUAGE sql VOLATILE   -- random()
AS $$
    WITH specs AS (
        SELECT
            coalesce(e->>'key', lower(e->>'genre'))                             AS key,
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
    SELECT s.key, s.genre, c.spotify_id, c.duration_sec, c.energy, c.ring, c.allowed
    FROM specs s
    CROSS JOIN LATERAL (
        SELECT
            t.spotify_id, t.duration_sec, t.energy, t.allowed,
            -- Energy ring: 5-point steps outside [lo, hi]; an allowed song we
            -- haven't analysed counts as inside.
            (CASE
               WHEN s.lo IS NULL OR s.hi IS NULL THEN 0
               WHEN t.energy IS NULL THEN (CASE WHEN t.allowed THEN 0 ELSE 999 END)
               ELSE ceil(greatest(s.lo - t.energy, t.energy - s.hi, 0) / 5.0)::int
             END) AS ring,
            t.instrumentalness, t.popularity
        FROM (
            SELECT DISTINCT ta.spotify_id, ta.duration_sec, ta.energy, ta.instrumentalness, ta.popularity, false AS allowed
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
            UNION ALL
            -- The owner's own songs under this genre (no preference filters).
            SELECT a.spotify_id, coalesce(ta.duration_sec, a.duration_sec), ta.energy, ta.instrumentalness, ta.popularity, true
            FROM business_allowed_tracks a
            LEFT JOIN track_analyses ta ON ta.spotify_id = a.spotify_id AND ta.status = 'ok'
            WHERE a.business_id = p_biz_id
              AND a.removed_at IS NULL
              AND lower(a.genre) = s.genre
              AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.spotify_id = a.spotify_id)
        ) t
        ORDER BY
            ring,
            (p_inst_pref = 'soft' AND NOT t.allowed AND coalesce(t.instrumentalness, 0) < 85)::int,
            (p_pop_pref  = 'soft' AND NOT t.allowed AND coalesce(t.popularity, 0) < hit_popularity_floor(s.genre))::int,
            random()
        LIMIT s.n
    ) AS c;
$$;

GRANT EXECUTE ON FUNCTION v7_timeline_pool(uuid, jsonb, text, text, int, int, int) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---- checks (run after) ----------------------------------------------------
-- The new columns and tables exist:
--   SELECT genre_weights, rejected_genres FROM business_taste_profiles LIMIT 1;
--   SELECT energy_windows FROM business_v7_settings LIMIT 1;
--   SELECT energy_range FROM business_v7_level_directions LIMIT 1;
--   SELECT count(*) FROM business_allowed_tracks;
--   SELECT count(*) FROM business_taste_changes;
-- A weight of 0.01 on Funk next to Disco at 1 → almost only Disco:
--   SELECT pg.genre, count(*) FROM v6_direction_tracks_recent(ARRAY['Funk','Disco'], 0, 300, 0, 100, 200,
--        '00000000-0000-0000-0000-000000000000', 'check', 0, 'none', 'none', NULL, NULL, '{"funk": 0.01}') r
--   JOIN playlist_tracks pt USING (spotify_id) JOIN playlist_genres pg USING (playlist_id)
--   WHERE pg.genre IN ('funk','disco') GROUP BY pg.genre;
