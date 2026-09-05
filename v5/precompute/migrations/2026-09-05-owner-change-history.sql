-- 2026-09-05 — owner-change history: three additions so nothing an owner
-- can change to their business's data disappears without a trace.
--
--   1. super_liked_tracks.deleted_at  (column, soft-delete)
--      Currently toggle-super-like hard-DELETEs the row when the owner
--      un-super-likes a track. That loses the history — you can no longer
--      tell that the owner ever tapped it. Add a deleted_at column so
--      un-super-like is a PATCH now(), and re-super-like clears it back
--      to NULL. Nothing consumes super_liked_tracks yet (per CLAUDE.md
--      DATA MODEL note), so no reader-side updates needed.
--
--   2. business_settings_changes  (new table)
--      Records changes to business-level settings that today upsert
--      in-place with no history: `name` (via businesses row) and `hours`
--      (via business_hours row). Generic table so we can add more fields
--      later without another migration.
--
--   3. deleted_events  (new table)
--      Archive for business_events rows the owner deletes. Mirrors the
--      deleted_tracks / deleted_playlists pattern used by Ami's cleanup
--      flow — snapshot the row's contents so admin API can show a full
--      per-business event history, not just "current events."
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

-- 1. super_liked_tracks — soft delete via deleted_at.
--    Existing UNIQUE(business_id, spotify_id) constraint stays: we never
--    duplicate rows; toggling just moves deleted_at back and forth.
ALTER TABLE super_liked_tracks
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2. business_settings_changes — one row per owner-driven settings change.
CREATE TABLE IF NOT EXISTS business_settings_changes (
  id          bigserial   PRIMARY KEY,
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Which setting moved. Free text (not a CHECK-enum) so we can add fields
  -- later without another migration; current values in use are 'name' and
  -- 'hours'.
  field       text        NOT NULL,
  -- Snapshots of the value before/after. jsonb (not text) so structured
  -- fields like `hours` (the weekly object) fit natively; simple string
  -- fields like `name` land as JSON-quoted strings.
  before      jsonb,
  after       jsonb,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_settings_changes_biz_time_idx
  ON business_settings_changes (business_id, changed_at DESC);

-- 3. deleted_events — archive of business_events rows on delete.
--    Same id as the original event so it's easy to correlate with any
--    other tables that referenced it (business_playlists.event_id
--    survives the delete-event flow since that endpoint doesn't touch
--    playlists — orphaned event_ids will match deleted_events.id).
CREATE TABLE IF NOT EXISTS deleted_events (
  id                  uuid        PRIMARY KEY,
  business_id         uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name                text,
  description         text,
  original_created_at timestamptz,
  deleted_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deleted_events_biz_time_idx
  ON deleted_events (business_id, deleted_at DESC);

-- 4. RLS — all three admin-only. No anon SELECT policies; dashboard reads
--    go through /api/internal/* with the service role.
ALTER TABLE business_settings_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_events            ENABLE ROW LEVEL SECURITY;
-- super_liked_tracks RLS unchanged — it already has an owner-read policy
-- from the 2026-08-20 migration; adding a column doesn't change access.

COMMIT;
