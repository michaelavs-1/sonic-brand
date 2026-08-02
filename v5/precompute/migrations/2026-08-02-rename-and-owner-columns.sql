-- Migration: rename v5_created_playlists → created_playlists,
--            add owner_id + business_id columns (nullable, FK w/ ON DELETE SET NULL).
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.
--
-- Why nullable: onboarding builds playlists BEFORE the user account exists,
-- so /api/v5/record-playlist writes the initial ledger row with owner_id/
-- business_id = NULL. The signup endpoint back-fills those columns once the
-- account is created and the playlists are attached to a business. Ledger
-- rows for pre-migration playlists stay NULL forever (they're already
-- orphans on Rubin's Spotify).
--
-- Why ON DELETE SET NULL: if we delete a user or business (e.g. via the
-- purge scripts), the ledger row stays so the expire-playlists cron can
-- still unfollow the Spotify playlist on schedule. Losing the linkage is
-- fine at that point — the row is already unreachable from the app.

BEGIN;

-- 1) Add the new columns if missing.
ALTER TABLE v5_created_playlists
  ADD COLUMN IF NOT EXISTS owner_id    uuid NULL REFERENCES auth.users(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS business_id uuid NULL REFERENCES public.businesses(id) ON DELETE SET NULL;

-- 2) Index them for common lookups (per-owner cleanup, per-business list).
CREATE INDEX IF NOT EXISTS created_playlists_owner_id_idx    ON v5_created_playlists(owner_id);
CREATE INDEX IF NOT EXISTS created_playlists_business_id_idx ON v5_created_playlists(business_id);

-- 3) Rename the table (and the misleadingly-prefixed expiration index).
--    Guarded on existence so a second run is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'v5_created_playlists' AND relkind = 'r') THEN
    ALTER TABLE v5_created_playlists RENAME TO created_playlists;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_v5_created_playlists_expiration' AND relkind = 'i') THEN
    ALTER INDEX idx_v5_created_playlists_expiration RENAME TO idx_created_playlists_expiration;
  END IF;
END$$;

COMMIT;
