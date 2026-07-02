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

-- ============================================================================
-- Ami-dashboard tables (added for /v4/ami/).
--
-- scan_jobs: queue of playlists newly added to the Data Box that need to be
-- scanned through RapidAPI. One row per pending / in-flight / finished
-- playlist. Priority is set by Ami via drag-drop in the dashboard (lower =
-- higher priority). The cron worker (POST /api/v4/ami-cron-tick) polls this
-- table every minute, acquires the highest-priority row via a soft lock
-- (locked_at), and drives it through fetching_tracks -> analyzing -> done.
--
-- Statuses:
--   pending          -> not started; cron will fetch playlist_tracks first
--   fetching_tracks  -> transitional; cron is fetching /v1/playlists/{id}/tracks
--   analyzing        -> cron is calling RapidAPI for the tracks
--   done             -> all tracks landed in track_analyses
--   error            -> unrecoverable failure; error column has details
--   paused           -> RapidAPI monthly cap reached; auto-resumes next month
--   stopped          -> user hit STOP in the dashboard; revived on next scan
--                       (revives to 'analyzing' if tracks_total > 0 else 'pending')
--   skipped          -> user toggled the trash icon on a pending row. Cron
--                       ignores it. Clicking the trash icon again flips it
--                       back to 'pending'.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scan_jobs (
    playlist_id        text        PRIMARY KEY,
    playlist_title     text        NOT NULL,
    playlist_url       text        NOT NULL,
    -- Primary genre + position captured at scan time (from Tab 2). Cron uses
    -- these to insert playlist_genres after the playlist has been analyzed.
    -- If a playlist appears under multiple genres in the sheet, only the
    -- first (genre, position) is stored here; secondary placements are handled
    -- by the next scan.
    genre              text        NOT NULL,
    position_in_genre  int         NOT NULL,
    business_types     text[]      NOT NULL DEFAULT '{}',
    priority           int         NOT NULL DEFAULT 1000,
    status             text        NOT NULL DEFAULT 'pending',
    tracks_total       int         NOT NULL DEFAULT 0,
    tracks_analyzed    int         NOT NULL DEFAULT 0,
    error              text,
    locked_at          timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_active
    ON scan_jobs (priority ASC, created_at ASC)
    WHERE status IN ('pending', 'fetching_tracks', 'analyzing');

CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs (status);

ALTER TABLE scan_jobs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- batch_control: single-row table gating the cron worker. Cron only picks up
-- jobs when is_active = true. Ami's "Start batch" button flips this to true;
-- "Stop batch" flips it back to false (and also marks in-flight jobs as
-- 'stopped'). Default is false so a fresh install doesn't auto-run cron on
-- any leftover pending rows without an explicit user Go.
-- ============================================================================

CREATE TABLE IF NOT EXISTS batch_control (
    id          int         PRIMARY KEY DEFAULT 1,
    is_active   boolean     NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (id = 1)
);

INSERT INTO batch_control (id, is_active)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE batch_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS batch_control_anon_read ON batch_control;
CREATE POLICY batch_control_anon_read ON batch_control
    FOR SELECT TO anon USING (true);

CREATE OR REPLACE FUNCTION set_batch_active(p_active boolean)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE batch_control
       SET is_active  = p_active,
           updated_at = now()
     WHERE id = 1;
    RETURN p_active;
END;
$$;

-- ============================================================================
-- scan_logs: live activity log written by ami-cron-tick and read by the
-- dashboard's "Live activity log" terminal panel. Rows are polled by the
-- browser every ~2s. Not strictly needed — cron would still work without it
-- — but gives Ami visibility into what's happening in real time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scan_logs (
    id               bigserial   PRIMARY KEY,
    playlist_id      text,
    playlist_title   text,
    spotify_id       text,
    level            text        NOT NULL DEFAULT 'info',   -- info | warn | error | success
    kind             text,       -- track_ok | track_not_found | retry | terminal | job_start | job_done | note
    message          text        NOT NULL,
    duration_ms      int,
    tracks_analyzed  int,
    tracks_total     int,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_logs_id_desc ON scan_logs (id DESC);

ALTER TABLE scan_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scan_logs_anon_read ON scan_logs;
CREATE POLICY scan_logs_anon_read ON scan_logs
    FOR SELECT TO anon USING (true);

-- ============================================================================
-- rapidapi_usage: monthly call counter for the RapidAPI track-analysis PRO
-- tier (50K calls/month). Replaces batch.mjs's state/rapidapi-call-count.json
-- for the serverless cron path (Vercel functions have no persistent FS).
-- One row per UTC month, keyed 'YYYY-MM'. Incremented atomically by
-- increment_rapidapi_usage() before each RapidAPI call.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapidapi_usage (
    month       text        PRIMARY KEY,
    calls       int         NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rapidapi_usage ENABLE ROW LEVEL SECURITY;

-- Set rapidapi_usage.calls to an exact value (authoritative sync from
-- RapidAPI response headers). Used by the cron worker after every actual
-- RapidAPI call (headers give X-RateLimit-Requests-Limit and -Remaining)
-- and by /api/v4/ami-sync-usage on demand.
CREATE OR REPLACE FUNCTION sync_rapidapi_usage(p_month text, p_calls int)
RETURNS int
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO rapidapi_usage (month, calls, updated_at)
    VALUES (p_month, p_calls, now())
    ON CONFLICT (month) DO UPDATE
      SET calls      = EXCLUDED.calls,
          updated_at = now();
    RETURN p_calls;
END;
$$;

-- Atomic increment RPC. Returns the new call count so callers can gate on
-- the safety threshold without a separate read.
CREATE OR REPLACE FUNCTION increment_rapidapi_usage(p_month text, p_delta int DEFAULT 1)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    new_calls int;
BEGIN
    INSERT INTO rapidapi_usage (month, calls, updated_at)
    VALUES (p_month, p_delta, now())
    ON CONFLICT (month) DO UPDATE
      SET calls      = rapidapi_usage.calls + EXCLUDED.calls,
          updated_at = now()
    RETURNING calls INTO new_calls;
    RETURN new_calls;
END;
$$;

-- Acquire the soft lock on a scan_jobs row. Returns 1 if the caller won the
-- race (lock was as expected and is now set to p_new_lock), 0 otherwise.
-- p_expected_lock may be NULL (first-time acquire) or a prior timestamp (for
-- take-over of a stale lock).
CREATE OR REPLACE FUNCTION acquire_scan_job_lock(
    p_playlist_id   text,
    p_expected_lock timestamptz,
    p_new_lock      timestamptz
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    rows_affected int;
BEGIN
    UPDATE scan_jobs
       SET locked_at  = p_new_lock,
           updated_at = now()
     WHERE playlist_id = p_playlist_id
       AND ((locked_at IS NULL AND p_expected_lock IS NULL)
             OR locked_at = p_expected_lock);
    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    RETURN rows_affected;
END;
$$;

-- Bulk-revive all 'stopped' scan_jobs. Each row goes to 'analyzing' if it
-- already has tracks fetched (tracks_total > 0), else back to 'pending' so
-- the fetch runs again. Pure UPDATE — never INSERT — so it won't trip the
-- scan_jobs NOT NULL constraints the way a partial PostgREST upsert can.
-- Returns the number of rows revived.
CREATE OR REPLACE FUNCTION revive_stopped_scan_jobs()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    rows_affected int;
BEGIN
    UPDATE scan_jobs
       SET status = CASE WHEN tracks_total > 0 THEN 'analyzing' ELSE 'pending' END,
           updated_at = now()
     WHERE status = 'stopped';
    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    RETURN rows_affected;
END;
$$;

-- Bulk toggle: flip every 'pending' row to 'skipped' (p_skip=true) or every
-- 'skipped' row to 'pending' (p_skip=false). Used by the dashboard's
-- "Skip all" / "Queue all" button. Returns the number of rows affected.
CREATE OR REPLACE FUNCTION toggle_all_scan_jobs_skip(p_skip boolean)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    rows_affected int;
BEGIN
    IF p_skip THEN
        UPDATE scan_jobs
           SET status = 'skipped', updated_at = now()
         WHERE status = 'pending';
    ELSE
        UPDATE scan_jobs
           SET status = 'pending', updated_at = now()
         WHERE status = 'skipped';
    END IF;
    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    RETURN rows_affected;
END;
$$;

-- Toggle a single scan_jobs row between 'pending' and 'skipped'. Only fires
-- if the current status matches the expected transition (pending -> skipped
-- or skipped -> pending). No-op for any other status (analyzing, done, etc.).
-- Returns the row's new (or unchanged) status.
CREATE OR REPLACE FUNCTION toggle_scan_job_skip(p_playlist_id text, p_skip boolean)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    result_status text;
BEGIN
    IF p_skip THEN
        UPDATE scan_jobs
           SET status     = 'skipped',
               updated_at = now()
         WHERE playlist_id = p_playlist_id
           AND status      = 'pending';
    ELSE
        UPDATE scan_jobs
           SET status     = 'pending',
               updated_at = now()
         WHERE playlist_id = p_playlist_id
           AND status      = 'skipped';
    END IF;
    SELECT status INTO result_status FROM scan_jobs WHERE playlist_id = p_playlist_id;
    RETURN result_status;
END;
$$;

-- Mark all currently-active scan_jobs as 'stopped'. Called by ami-stop when
-- Ami hits the STOP button. Does NOT clear locked_at — a cron that currently
-- holds the lock will finish its in-flight RapidAPI call, poll status, see
-- 'stopped', and bail without overwriting the status. Progress up to the last
-- completed call is preserved.
CREATE OR REPLACE FUNCTION stop_active_scan_jobs()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    rows_affected int;
BEGIN
    UPDATE scan_jobs
       SET status     = 'stopped',
           updated_at = now()
     WHERE status IN ('pending', 'fetching_tracks', 'analyzing');
    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    RETURN rows_affected;
END;
$$;

-- Mark all currently-active scan_jobs as 'paused'. Called when the cron tick
-- detects the RapidAPI monthly cap has been reached. Idempotent.
CREATE OR REPLACE FUNCTION pause_active_scan_jobs()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    rows_affected int;
BEGIN
    UPDATE scan_jobs
       SET status     = 'paused',
           locked_at  = NULL,
           updated_at = now()
     WHERE status IN ('pending', 'fetching_tracks', 'analyzing');
    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    RETURN rows_affected;
END;
$$;

-- Bulk-reorder scan_jobs by a caller-supplied ordering of playlist_ids.
-- Priorities are spaced by 10 (10, 20, 30, ...) so future single-row inserts
-- can slot in without a full renumber. Only updates rows that already exist;
-- silently ignores unknown playlist_ids. Returns rows_affected.
CREATE OR REPLACE FUNCTION reorder_scan_jobs(p_order text[])
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    rows_affected int;
BEGIN
    WITH pos AS (
        SELECT pid, i
          FROM unnest(p_order) WITH ORDINALITY AS t(pid, i)
    )
    UPDATE scan_jobs sj
       SET priority   = (pos.i * 10),
           updated_at = now()
      FROM pos
     WHERE sj.playlist_id = pos.pid;
    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    RETURN rows_affected;
END;
$$;
