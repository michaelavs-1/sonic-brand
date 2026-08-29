-- 2026-08-29-created-playlists-backoff.sql
--
-- Adds retry-with-exponential-backoff bookkeeping to the created_playlists
-- ledger so /api/cron/expire-playlists can:
--   1. Stop hammering the same failed row every hour (avoids cluster-failure
--      backlogs like the 141-row pileup discovered after Aug 22).
--   2. Guarantee that no row is ever permanently abandoned — we back off up
--      to 24h between attempts but keep trying until deleted_at is set.
--   3. Fire exactly one alert email per chronically-failing row (roughly at
--      the 15h mark, after ~5 consecutive failures).
--
-- Column meanings:
--   attempts        int      Number of failed cleanup attempts on this row.
--                            Incremented after every failed cron tick.
--   last_error      text     Truncated (400 char) error message from the most
--                            recent failure. Replaces the vaguer `error` column
--                            (kept for backwards compat, no read path uses it
--                            anymore — new writes go to last_error).
--   next_attempt_at timestamptz
--                            When this row becomes eligible again. NULL =
--                            immediately eligible (never attempted or just
--                            reset). Cron query becomes:
--                              WHERE deleted_at IS NULL
--                                AND expires_at <= now()
--                                AND (next_attempt_at IS NULL
--                                  OR next_attempt_at <= now())
--   alerted_at      timestamptz
--                            When the chronic-failure alert email was sent
--                            for this row. NULL = not yet alerted. Prevents
--                            alert storming when many rows cross the
--                            attempts>=5 threshold in the same tick.
--
-- Backoff schedule (client-side; the DB just stores the timestamps):
--   attempts=1 → +1h,  =2 → +2h,  =3 → +4h,  =4 → +8h,  =5 → +16h,
--   >=6         → capped at +24h.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index).

ALTER TABLE public.created_playlists
  ADD COLUMN IF NOT EXISTS attempts        int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error      text,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS alerted_at      timestamptz;

-- Partial index over "cron eligible" rows only. Keeps the working set tight
-- since most rows in the table are either deleted_at IS NOT NULL (already
-- cleaned) or expires_at > now() (still live). Both are excluded.
CREATE INDEX IF NOT EXISTS created_playlists_cron_eligible_idx
  ON public.created_playlists (next_attempt_at NULLS FIRST, expires_at)
  WHERE deleted_at IS NULL;

-- Backfill NULL alerted_at → no-op (already default).
-- Backfill next_attempt_at → NULL means "immediately eligible" which matches
-- the current cron behavior for pre-migration rows. No data change needed.
