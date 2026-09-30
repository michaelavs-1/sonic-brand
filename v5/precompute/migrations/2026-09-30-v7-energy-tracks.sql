-- ============================================================================
-- 2026-09-30 — v7_energy_tracks: random tracks from a set of genres whose
-- track_analyses.energy (0-100) falls inside a range. ADDITIVE ONLY — a new
-- function; nothing existing is altered.
--
-- Used by Ami's prompt dashboard (step 4, Option 1): the "playlist by energy"
-- test button, via /api/v7/ami/test-playlist. Ami is examining whether the
-- per-track energy value is worth using in the daily playlists.
--
-- The pool is the one Option 1's daily playlists draw from
-- (v6_direction_tracks_recent with bpm 0-300 and popularity 0-100, no
-- per-business history): distinct analysed tracks in any playlist tagged with
-- one of the genres, the same instrumentalness / popularity preference rules
-- — plus the energy range. Tracks with no energy value are left out.
--
-- Output: (spotify_id, energy, matches) — at most p_limit random rows;
-- `matches` = how many tracks in the whole pool fall in the range (the same
-- on every row; no rows when nothing matches).
--
-- Server-only (the endpoint uses the service key).
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

DROP FUNCTION IF EXISTS v7_energy_tracks(text[], int, int, text, text, int);

CREATE FUNCTION v7_energy_tracks(
    p_genres     text[],
    p_energy_lo  int,
    p_energy_hi  int,
    p_inst_pref  text DEFAULT 'none',
    p_pop_pref   text DEFAULT 'none',
    p_limit      int  DEFAULT 50
) RETURNS TABLE (
    spotify_id text,
    energy     int,
    matches    bigint
)
LANGUAGE sql STABLE
AS $$
    WITH candidates AS (
        SELECT DISTINCT
            ta.spotify_id,
            ta.energy,
            ta.instrumentalness,
            ta.popularity
        FROM playlist_genres pg
        JOIN playlist_tracks pt ON pt.playlist_id = pg.playlist_id
        JOIN track_analyses  ta ON ta.spotify_id  = pt.spotify_id
        WHERE ta.status = 'ok'
          AND pg.genre = ANY(SELECT lower(g) FROM unnest(p_genres) AS g)
          -- Same pool as Option 1 (it passes bpm 0-300, popularity 0-100).
          AND ta.tempo BETWEEN 0 AND 300
          AND ta.popularity BETWEEN (CASE WHEN p_pop_pref = 'hard' THEN 60 ELSE 0 END) AND 100
          AND (p_inst_pref <> 'hard' OR coalesce(ta.instrumentalness, 0) >= 85)
          AND ta.energy BETWEEN p_energy_lo AND p_energy_hi
    )
    SELECT c.spotify_id, c.energy, count(*) OVER () AS matches
    FROM candidates c
    ORDER BY
      (p_inst_pref = 'soft' AND coalesce(c.instrumentalness, 0) < 85)::int,
      (p_pop_pref  = 'soft' AND coalesce(c.popularity, 0) < 60)::int,
      random()
    LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION v7_energy_tracks(text[], int, int, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION v7_energy_tracks(text[], int, int, text, text, int) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---- check (run after) -------------------------------------------------------
-- A few Bossa Nova tracks with energy 20-40, and how many match in total:
--   SELECT * FROM v7_energy_tracks(ARRAY['Bossa Nova'], 20, 40, 'none', 'none', 5);
