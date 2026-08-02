-- v5 Supabase RPCs. Paste into Supabase SQL Editor and run once.
-- Idempotent (CREATE OR REPLACE).

-- ============================================================================
-- v5_created_playlists: audit log of playlists we create on Rubin's account.
-- Every successful create+add lands here with a 24h expiration. The
-- /api/v5/cron-expire-playlists worker sweeps expired rows and empties +
-- unfollows them on Spotify's side.
-- ============================================================================

CREATE TABLE IF NOT EXISTS v5_created_playlists (
    spotify_id  text        PRIMARY KEY,
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    deleted_at  timestamptz,
    error       text
);

CREATE INDEX IF NOT EXISTS idx_v5_created_playlists_expiration
    ON v5_created_playlists (expires_at)
    WHERE deleted_at IS NULL;

ALTER TABLE v5_created_playlists ENABLE ROW LEVEL SECURITY;
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
            (elem->>'rank')::int    AS rank,
            lower(elem->>'genre')   AS genre,
            (elem->>'bpm_lo')::int  AS bpm_lo,
            (elem->>'bpm_hi')::int  AS bpm_hi
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
              AND ta.popularity BETWEEN p_pop_lo AND p_pop_hi
            ORDER BY random()
            LIMIT 1
        ) AS sub
    ),
    -- Tier 2: fallback (genre only). Runs only for ranks that missed tier 1.
    -- Since fallback is much more expensive per genre (bigger candidate pool),
    -- gating it to just the missing ranks keeps the common case fast.
    missing_specs AS (
        SELECT rank, genre
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
            ORDER BY random()
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

CREATE OR REPLACE FUNCTION v5_direction_tracks(
    p_genres    text[],
    p_bpm_lo    int,
    p_bpm_hi    int,
    p_pop_lo    int,
    p_pop_hi    int,
    p_limit     int DEFAULT 10
) RETURNS TABLE (
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT DISTINCT
            ta.spotify_id
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          AND ta.tempo      BETWEEN p_bpm_lo AND p_bpm_hi
          AND ta.popularity BETWEEN p_pop_lo AND p_pop_hi
    )
    SELECT spotify_id
    FROM candidates
    ORDER BY random()
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

CREATE OR REPLACE FUNCTION v6_direction_tracks_recent(
    p_genres        text[],
    p_bpm_lo        int,
    p_bpm_hi        int,
    p_pop_lo        int,
    p_pop_hi        int,
    p_limit         int,
    p_biz_id        uuid,
    p_direction_key text,
    p_exclude_days  int DEFAULT 7
) RETURNS TABLE (
    spotify_id text
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT DISTINCT
            ta.spotify_id
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          AND ta.tempo      BETWEEN p_bpm_lo AND p_bpm_hi
          AND ta.popularity BETWEEN p_pop_lo AND p_pop_hi
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
    ORDER BY random()
    LIMIT p_limit;
$$;
