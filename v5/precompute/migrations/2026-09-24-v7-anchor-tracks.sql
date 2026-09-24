-- ============================================================================
-- 2026-09-24 — v7_anchor_tracks: cheap "one random track per genre" for the
-- v7 swipe deck. ADDITIVE ONLY — does not touch v5_anchor_tracks (v6 keeps
-- using it unchanged).
--
-- Why a new function:
--   v5_anchor_tracks picks its random track with ORDER BY random() LIMIT 1
--   over EVERY track matching genre + tempo + popularity. To return 1 row it
--   touches all candidates, and because track_analyses has a tempo index the
--   planner can end up scanning every tempo-matching track in the catalog —
--   so cost tracks the BPM window, not the genre. v7 has no tempo concept and
--   sent 0-300 ("any"), which roughly doubled the cost and pushed every 4-card
--   call past the anon role's 3s statement_timeout (57014, measured
--   2026-09-23: 6/6 failures, even for small genres).
--
-- What this does instead (per spec):
--   1. Sample a handful of random PLAYLISTS tagged with the genre
--      (idx_playlist_genres_genre — tens to hundreds of rows per genre).
--   2. Take those playlists' tracks (playlist_tracks PK leads with
--      playlist_id) and look each up in track_analyses by PK.
--   3. Apply the inst_pref / pop_pref filters and biases, pick one at random.
--   Work is bounded by the sample size, not by the genre or catalog size.
--   No tempo parameter at all — v7 never had one.
--
--   Tier 1 samples 8 playlists. Only if that yields nothing for a spec
--   (typically a 'hard' preference that the sampled playlists can't satisfy)
--   does tier 2 re-sample 200 playlists for just those specs. Still bounded.
--   Specs that find nothing in either tier are absent from the result; the
--   client drops that card (same degradation as v5_anchor_tracks).
--
-- Distribution note: "random playlist, then random track" slightly favours
-- tracks from smaller playlists vs. a uniform draw over the whole genre.
-- Irrelevant for a preview card.
--
-- Input:  p_specs jsonb — [{ "rank": int, "genre": text,
--                            "inst_pref": "none"|"soft"|"hard",
--                            "pop_pref":  "none"|"soft"|"hard" }, ...]
-- Output: (rank int, spotify_id text), at most one row per rank.
--
-- Preference semantics match v5_anchor_tracks:
--   inst_pref 'hard' → instrumentalness >= 85 required; 'soft' → instrumentals
--   sort first. pop_pref 'hard' → popularity 60-100 required; 'soft' → hits
--   (>= 60) sort first. 'none' → no effect.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

DROP FUNCTION IF EXISTS v7_anchor_tracks(jsonb);

CREATE FUNCTION v7_anchor_tracks(p_specs jsonb)
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
              AND (s.pop_pref  <> 'hard' OR ta.popularity BETWEEN 60 AND 100)
            ORDER BY
              (s.inst_pref = 'soft' AND coalesce(ta.instrumentalness, 0) < 85)::int,
              (s.pop_pref  = 'soft' AND coalesce(ta.popularity, 0) < 60)::int,
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
              AND (s.pop_pref  <> 'hard' OR ta.popularity BETWEEN 60 AND 100)
            ORDER BY
              (s.inst_pref = 'soft' AND coalesce(ta.instrumentalness, 0) < 85)::int,
              (s.pop_pref  = 'soft' AND coalesce(ta.popularity, 0) < 60)::int,
              random()
            LIMIT 1
        ) AS pick
        WHERE s.rank NOT IN (SELECT t.rank FROM tier1 t)
    )
    SELECT t.rank, t.spotify_id FROM tier1 t
    UNION ALL
    SELECT t.rank, t.spotify_id FROM tier2 t;
$$;

-- The v7 endpoint calls this with the anon key (same as v6's anchor
-- endpoint), so anon needs EXECUTE. Explicit rather than relying on
-- Supabase's default privileges.
GRANT EXECUTE ON FUNCTION v7_anchor_tracks(jsonb) TO anon, authenticated, service_role;

-- Make PostgREST pick up the new function immediately.
NOTIFY pgrst, 'reload schema';
