-- Sonic-brand v4 track-analysis cache schema
-- Paste into Supabase SQL Editor (dashboard step 3 of the plan).
-- Safe to re-run: every CREATE uses IF NOT EXISTS.

-- ============================================================================
-- track_analyses: the per-spotify-id analysis cache.
-- Typed columns for the dimensions we filter on; raw_analysis jsonb keeps
-- everything else from RapidAPI so we never have to re-pull to recover a
-- field we didn't extract.
-- ============================================================================

CREATE TABLE IF NOT EXISTS track_analyses (
    spotify_id        text        PRIMARY KEY,
    energy            int,
    danceability      int,
    popularity        int,
    tempo             numeric,
    valence           int,
    acousticness      int,
    instrumentalness  int,
    raw_analysis      jsonb,
    status            text        NOT NULL DEFAULT 'ok',
    analyzed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_track_analyses_energy           ON track_analyses (energy);
CREATE INDEX IF NOT EXISTS idx_track_analyses_danceability     ON track_analyses (danceability);
CREATE INDEX IF NOT EXISTS idx_track_analyses_popularity       ON track_analyses (popularity);
CREATE INDEX IF NOT EXISTS idx_track_analyses_tempo            ON track_analyses (tempo);
CREATE INDEX IF NOT EXISTS idx_track_analyses_valence          ON track_analyses (valence);
CREATE INDEX IF NOT EXISTS idx_track_analyses_acousticness     ON track_analyses (acousticness);
CREATE INDEX IF NOT EXISTS idx_track_analyses_instrumentalness ON track_analyses (instrumentalness);
CREATE INDEX IF NOT EXISTS idx_track_analyses_status           ON track_analyses (status);

-- ============================================================================
-- playlist_tracks: which Spotify track is in which Spotify playlist.
-- Many-to-many. `position` preserves the order of the playlist on Spotify
-- (so we can recover the original sequence if needed for diversity).
-- DELETE WHERE playlist_id=? cleanly removes a playlist's association.
-- ============================================================================

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id  text        NOT NULL,
    spotify_id   text        NOT NULL,
    position     int,
    seen_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, spotify_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_spotify_id ON playlist_tracks (spotify_id);

-- ============================================================================
-- playlist_genres: which Data-Box genre row(s) a playlist belongs to.
-- Many-to-many. position_in_genre captures the slot order in Tab 2 so we
-- can honor "first N playlists per genre" semantics.
-- ============================================================================

CREATE TABLE IF NOT EXISTS playlist_genres (
    playlist_id        text NOT NULL,
    genre              text NOT NULL,
    position_in_genre  int,
    PRIMARY KEY (playlist_id, genre)
);

CREATE INDEX IF NOT EXISTS idx_playlist_genres_genre ON playlist_genres (genre);

-- ============================================================================
-- biztype_genres: the load-bearing column-G/H provenance table.
-- For each (business_type, genre) pair we record which Tab-1 column the
-- genre came from (G = first batch, H = second batch) and its position
-- within that column. The runtime joins through this table to tag every
-- preview-card with its column/position so the UI can render batch 1
-- before batch 2 with the original sheet ordering preserved.
-- ============================================================================

CREATE TABLE IF NOT EXISTS biztype_genres (
    business_type       text        NOT NULL,
    genre               text        NOT NULL,
    column_letter       char(1)     NOT NULL CHECK (column_letter IN ('G', 'H')),
    position_in_column  int         NOT NULL,
    in_sample           boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (business_type, genre)
);

CREATE INDEX IF NOT EXISTS idx_biztype_genres_genre     ON biztype_genres (genre);
CREATE INDEX IF NOT EXISTS idx_biztype_genres_in_sample ON biztype_genres (in_sample);

-- ============================================================================
-- RLS: enable on all four tables. Per dashboard step 4, the user adds a
-- single "anon read" SELECT policy per table in the Supabase UI. Writes
-- come exclusively via the service_role key (which bypasses RLS).
-- ============================================================================

ALTER TABLE track_analyses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlist_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlist_genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE biztype_genres  ENABLE ROW LEVEL SECURITY;
