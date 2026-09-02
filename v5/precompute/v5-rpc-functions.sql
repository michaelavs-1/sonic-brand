-- v5 Supabase RPCs. Paste into Supabase SQL Editor and run once.
-- Idempotent (CREATE OR REPLACE).

-- ============================================================================
-- created_playlists: audit log of playlists we create on Rubin's account.
-- Every successful create+add lands here with an expires_at timestamp; the
-- /api/cron/expire-playlists worker sweeps expired rows and empties +
-- unfollows them on Spotify's side.
--
-- owner_id / business_id are nullable because onboarding writes rows
-- BEFORE the user account exists; /api/v6/account/signup back-fills them
-- once the account + business are created. See migration file
-- v5/precompute/migrations/2026-08-02-rename-and-owner-columns.sql for
-- the ALTER path against an existing (pre-rename) table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS created_playlists (
    spotify_id  text        PRIMARY KEY,
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    deleted_at  timestamptz,
    error       text,
    owner_id    uuid        REFERENCES auth.users(id)      ON DELETE SET NULL,
    business_id uuid        REFERENCES public.businesses(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_created_playlists_expiration
    ON created_playlists (expires_at)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS created_playlists_owner_id_idx    ON created_playlists(owner_id);
CREATE INDEX IF NOT EXISTS created_playlists_business_id_idx ON created_playlists(business_id);

ALTER TABLE created_playlists ENABLE ROW LEVEL SECURITY;
-- No anon-read policy: writes via service_role only, reads via service_role only.

-- Cleanup: drop the compound index that was added in perf-tuning iterations
-- (not part of the original v5 design). Safe if it doesn't exist.
DROP INDEX IF EXISTS idx_track_analyses_tempo_popularity;

-- ============================================================================
-- v5_anchor_tracks: returns one random ok-status track per direction spec.
--
-- p_specs is a JSON array of {"rank": N, "genre": "...", "bpm_lo": N,
-- "bpm_hi": N}, one entry per direction. BPM ranges are per-direction so
-- they must travel with the genre they screen. p_pop_lo/p_pop_hi are shared
-- across all directions (derived from the user's picked atmospheres).
--
-- Keyed by rank, not by genre — two directions can share the same anchor
-- genre, and they each need their own preview track.
--
-- Fallback: for each direction, first try genre + BPM + popularity. If no
-- track matches (rare genre, narrow BPM window, tight popularity), fall
-- back to any random ok track from the genre. Ranks are guaranteed to be
-- present in the result as long as the anchor genre has ANY cached tracks.
--
-- Note: playlist_genres.genre is stored lowercase, so we lowercase the
-- AI-produced spec side (`lower(elem->>'genre')`) and match with direct
-- equality against pg.genre. This lets idx_playlist_genres_genre kick in.
-- ============================================================================

DROP FUNCTION IF EXISTS v5_anchor_tracks(text[]);
DROP FUNCTION IF EXISTS v5_anchor_tracks(jsonb, int, int);

-- Per-spec `inst_pref` (added 2026-08-21): 'none' | 'soft' | 'hard'.
--   'hard' — AND ta.instrumentalness >= 85 in the WHERE (strict filter).
--   'soft' — no WHERE change, but a bias in ORDER BY so instrumentals
--            come out on top and non-instrumentals only fill in if the
--            instrumental pool is thin. Preserves the "not omit vocals
--            altogether" intent of a soft preference.
--   'none' — unchanged behavior (default).
--
-- Per-spec `pop_pref` (added 2026-09-02): 'none' | 'soft' | 'hard'.
-- Mirrors the shape of inst_pref but with a twist: 'hard' OVERRIDES the
-- effective popularity window to [60, 100] regardless of p_pop_lo /
-- p_pop_hi. 'soft' keeps the atmosphere-derived window in WHERE but adds
-- an ORDER BY bias so tracks with popularity >= 60 surface first, and
-- deep cuts (popularity < 60) only fill in when the hit pool is thin.
-- 'none' — unchanged (atmosphere window applies as before).
CREATE OR REPLACE FUNCTION v5_anchor_tracks(
    p_specs   jsonb,
    p_pop_lo  int,
    p_pop_hi  int
) RETURNS TABLE (
    rank       int,
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH specs AS (
        SELECT
            (elem->>'rank')::int                             AS rank,
            lower(elem->>'genre')                            AS genre,
            (elem->>'bpm_lo')::int                           AS bpm_lo,
            (elem->>'bpm_hi')::int                           AS bpm_hi,
            coalesce(lower(elem->>'inst_pref'), 'none')      AS inst_pref,
            coalesce(lower(elem->>'pop_pref'),  'none')      AS pop_pref,
            -- Effective popularity window per spec: hard overrides to [60,100];
            -- soft + none use the passed atmosphere window.
            CASE WHEN coalesce(lower(elem->>'pop_pref'), 'none') = 'hard' THEN 60
                 ELSE p_pop_lo END                           AS eff_pop_lo,
            CASE WHEN coalesce(lower(elem->>'pop_pref'), 'none') = 'hard' THEN 100
                 ELSE p_pop_hi END                           AS eff_pop_hi
        FROM jsonb_array_elements(p_specs) AS elem
    ),
    -- Tier 1: strict match (genre + BPM + popularity). Same cost as before.
    -- MATERIALIZED so it runs exactly once; the NOT IN filter below would
    -- otherwise cause it to be re-evaluated.
    strict_matches AS MATERIALIZED (
        SELECT s.rank, sub.spotify_id
        FROM specs s
        CROSS JOIN LATERAL (
            SELECT ta.spotify_id
            FROM playlist_genres pg
            JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
            JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
            WHERE pg.genre         = s.genre
              AND ta.status        = 'ok'
              AND ta.tempo      BETWEEN s.bpm_lo AND s.bpm_hi
              AND ta.popularity BETWEEN s.eff_pop_lo AND s.eff_pop_hi
              AND (s.inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
            -- inst_pref 'soft' bumps vocals to score 1 (instrumentals stay 0).
            -- pop_pref 'soft' bumps deep cuts (popularity < 60) to score 1.
            -- Both biases can apply simultaneously; ORDER BY sums by
            -- listing them as separate keys, so hits+instrumentals win
            -- when both preferences are soft. 'hard' + 'none' contribute 0.
            ORDER BY
              (s.inst_pref = 'soft' AND coalesce(ta.instrumentalness, 0) < 85)::int,
              (s.pop_pref  = 'soft' AND coalesce(ta.popularity, 0) < 60)::int,
              random()
            LIMIT 1
        ) AS sub
    ),
    -- Tier 2: fallback (genre only). Runs only for ranks that missed tier 1.
    -- Since fallback is much more expensive per genre (bigger candidate pool),
    -- gating it to just the missing ranks keeps the common case fast.
    missing_specs AS (
        SELECT rank, genre, inst_pref, pop_pref
        FROM specs
        WHERE rank NOT IN (SELECT rank FROM strict_matches)
    ),
    fallback_matches AS (
        SELECT m.rank, sub.spotify_id
        FROM missing_specs m
        CROSS JOIN LATERAL (
            SELECT ta.spotify_id
            FROM playlist_genres pg
            JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
            JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
            WHERE pg.genre  = m.genre
              AND ta.status = 'ok'
              AND (m.inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
              AND (m.pop_pref  <> 'hard' OR ta.popularity BETWEEN 60 AND 100)
            ORDER BY
              (m.inst_pref = 'soft' AND coalesce(ta.instrumentalness, 0) < 85)::int,
              (m.pop_pref  = 'soft' AND coalesce(ta.popularity, 0) < 60)::int,
              random()
            LIMIT 1
        ) AS sub
    )
    SELECT rank, spotify_id FROM strict_matches
    UNION ALL
    SELECT rank, spotify_id FROM fallback_matches;
$$;

-- ============================================================================
-- v5_direction_tracks: returns up to p_limit random tracks whose genre is
-- any of p_genres AND whose tempo falls inside [p_bpm_lo, p_bpm_hi] AND whose
-- popularity falls inside [p_pop_lo, p_pop_hi]. No other screening.
--
-- Used by the direction playlist builder — one call per selected direction.
-- Same lowercase-the-input pattern as v5_anchor_tracks for index usage.
-- ============================================================================

-- p_inst_pref (added 2026-08-21): 'none' | 'soft' | 'hard'.
--   'hard' — WHERE instrumentalness >= 85 (strict).
--   'soft' — no WHERE change; ORDER BY bumps vocals to score 1 so
--            instrumentals bubble to the top of the random draw and
--            non-instrumentals fill in only if the instrumental pool
--            is thin.
--   'none' — unchanged behavior.
--
-- p_pop_pref (added 2026-09-02): 'none' | 'soft' | 'hard'.
--   'hard' — WHERE popularity BETWEEN 60 AND 100 (OVERRIDES the atmosphere
--            window passed via p_pop_lo/p_pop_hi).
--   'soft' — keeps p_pop_lo/p_pop_hi in WHERE; ORDER BY bumps deep cuts
--            (popularity < 60) to score 1 so hits bubble up in the
--            random draw and deep cuts fill in only if the hit pool is
--            thin.
--   'none' — unchanged (atmosphere window applies).

-- Drop prior signatures so re-runs don't leave orphaned overloads. CREATE
-- OR REPLACE only replaces on EXACT signature match, so adding a new arg
-- (like p_pop_pref on 2026-09-02) would otherwise leave the previous
-- version sitting alongside the new one — PostgREST would then have two
-- candidates to disambiguate. Add a DROP line here whenever the arg list
-- changes.
DROP FUNCTION IF EXISTS v5_direction_tracks(text[], int, int, int, int, int, text);
-- 2026-09-02: previous signature — added p_pop_pref after p_inst_pref.

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
        SELECT DISTINCT
            ta.spotify_id,
            ta.instrumentalness,
            ta.popularity
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          AND ta.tempo BETWEEN p_bpm_lo AND p_bpm_hi
          -- Effective popularity window: hard pop_pref overrides to [60,100].
          AND ta.popularity BETWEEN
              (CASE WHEN p_pop_pref = 'hard' THEN 60  ELSE p_pop_lo END)
              AND
              (CASE WHEN p_pop_pref = 'hard' THEN 100 ELSE p_pop_hi END)
          AND (p_inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
    )
    SELECT spotify_id
    FROM candidates
    ORDER BY
      (p_inst_pref = 'soft' AND coalesce(instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND coalesce(popularity, 0) < 60)::int,
      random()
    LIMIT p_limit;
$$;

-- ============================================================================
-- v6_daily_track_history: per-business, per-direction record of every track
-- ever served in a daily playlist. Used by v6_direction_tracks_recent to
-- exclude recently-served tracks so consecutive days for the same
-- (business, direction) don't repeat.
--
-- direction_key is a stable string derived from the direction spec
-- (currently anchor_genre + BPM range) so the same direction across days
-- looks up the same history. See directionKey() in
-- v6/generation/playlist-length.js.
--
-- served_at is part of the PK so re-serving a track later (after the
-- exclusion window elapses) is a plain insert, not an upsert. Rows older
-- than ~2x the exclusion window are opportunistically pruned by the
-- daily-gen cron.
-- ============================================================================

CREATE TABLE IF NOT EXISTS v6_daily_track_history (
    business_id   uuid        NOT NULL,
    direction_key text        NOT NULL,
    spotify_id    text        NOT NULL,
    served_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, direction_key, spotify_id, served_at)
);

CREATE INDEX IF NOT EXISTS idx_v6_history_lookup
    ON v6_daily_track_history (business_id, direction_key, served_at DESC);

ALTER TABLE v6_daily_track_history ENABLE ROW LEVEL SECURITY;
-- No anon policies: writes/reads via service_role only.

-- ============================================================================
-- v6_direction_tracks_recent: same as v5_direction_tracks but excludes any
-- track already served to this (business, direction) within the last
-- p_exclude_days days. Pass p_exclude_days=0 to disable the exclusion
-- (used by the caller as the pool-exhaustion fallback).
-- ============================================================================

-- p_inst_pref (added 2026-08-21): 'none' | 'soft' | 'hard'. Same three-state
-- semantics as v5_direction_tracks — hard = strict WHERE, soft = ORDER BY
-- bias, none = unchanged.
--
-- p_pop_pref (added 2026-09-02): 'none' | 'soft' | 'hard'. Same three-state
-- semantics as v5_direction_tracks — hard OVERRIDES popularity window to
-- [60,100], soft biases hits (popularity >= 60) via ORDER BY, none unchanged.

-- Drop prior signature so re-runs don't leave orphaned overloads (same
-- reason as v5_direction_tracks above — CREATE OR REPLACE only replaces
-- on exact signature match).
DROP FUNCTION IF EXISTS v6_direction_tracks_recent(text[], int, int, int, int, int, uuid, text, int, text);
-- 2026-09-02: previous signature — added p_pop_pref after p_inst_pref.

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
        SELECT DISTINCT
            ta.spotify_id,
            ta.instrumentalness,
            ta.popularity
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          AND ta.tempo BETWEEN p_bpm_lo AND p_bpm_hi
          -- Effective popularity window: hard pop_pref overrides to [60,100].
          AND ta.popularity BETWEEN
              (CASE WHEN p_pop_pref = 'hard' THEN 60  ELSE p_pop_lo END)
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
    )
    SELECT spotify_id
    FROM candidates
    ORDER BY
      (p_inst_pref = 'soft' AND coalesce(instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND coalesce(popularity, 0) < 60)::int,
      random()
    LIMIT p_limit;
$$;
