-- Migration: move per-business operational data out of auth.users.
-- raw_user_meta_data.sonic.b[businessId].* into dedicated Postgres tables.
--
-- Why: Supabase embeds user_metadata into the access-token JWT. As per-
-- business playlists/events/hours/place data accumulated it inflated the
-- JWT past Node's 16KB HTTP header cap, causing 431 errors on every
-- authenticated API call. Moving the data to tables lets user_metadata
-- shrink back to what it was designed for (small identity flags) and
-- keeps the JWT bounded regardless of how many playlists a business has.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.
--
-- After running this: run scripts/migrate-user-metadata-to-tables.mjs to
-- backfill existing users' data into the new tables and compact their
-- user_metadata blobs in one pass. See CLAUDE.md for the full deploy
-- sequence.

BEGIN;

-- 1) business_playlists — one row per Spotify playlist we've created.
--    spotify_id is the PK: it's globally unique across Spotify and matches
--    the PK on created_playlists (the expiry ledger). Drops the surrogate
--    uuid the earlier draft had — one less indirection.
CREATE TABLE IF NOT EXISTS business_playlists (
  spotify_id  text        PRIMARY KEY,
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url         text        NOT NULL,
  label       text,
  ico         text,                              -- 🎵 daily / 🎪 event
  track_count int,
  genres      jsonb,                             -- array of strings
  bpm_range   jsonb,                             -- {min, max} — event playlists only
  expansion   jsonb,                             -- {direction, popularityWindow} — daily/onboarding only
  event_id    uuid,                              -- back-ref to business_events.id when applicable
  expanded_at timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_playlists_biz_created_idx
  ON business_playlists (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS business_playlists_biz_expires_idx
  ON business_playlists (business_id, expires_at);
CREATE INDEX IF NOT EXISTS business_playlists_event_idx
  ON business_playlists (event_id) WHERE event_id IS NOT NULL;

-- 2) business_events — one row per special event a business tracks.
CREATE TABLE IF NOT EXISTS business_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        text,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_events_biz_idx
  ON business_events (business_id);

-- 3) business_hours — one row per business. Weekly hours read/written
--    atomically by the hours-editor so jsonb beats 7 rows on read/write
--    cost and complexity.
CREATE TABLE IF NOT EXISTS business_hours (
  business_id     uuid        PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  hours           jsonb       NOT NULL,          -- {0..6: {closed, open?, close?}}
  longest_minutes int,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 4) business_place — one row per business. Google Places metadata that
--    feeds the Gemini musical-directions prompt as external grounding.
CREATE TABLE IF NOT EXISTS business_place (
  business_id       uuid        PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  place_id          text,
  name              text,
  address           text,
  primary_type      text,
  types             jsonb,
  editorial_summary text,
  price_level       text,
  website_uri       text,
  vibe              jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 5) businesses gets a boolean flag replacing user_metadata's
--    b[bizId].onboardingExpanded — same strict one-time semantics.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS onboarding_expanded boolean NOT NULL DEFAULT false;

-- 6) RLS: client-direct reads only. Writes go via server endpoints with the
--    service-role key which bypasses RLS entirely. Owner check is a
--    subquery on businesses.owner_id = auth.uid().
ALTER TABLE business_playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_hours     ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_place     ENABLE ROW LEVEL SECURITY;

-- DROP + CREATE the policies so re-running the migration picks up any
-- future tweaks. CREATE POLICY has no IF NOT EXISTS in Postgres 15.
DROP POLICY IF EXISTS "own business_playlists read" ON business_playlists;
DROP POLICY IF EXISTS "own business_events read"    ON business_events;
DROP POLICY IF EXISTS "own business_hours read"     ON business_hours;
DROP POLICY IF EXISTS "own business_place read"     ON business_place;

CREATE POLICY "own business_playlists read" ON business_playlists FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "own business_events read" ON business_events FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "own business_hours read" ON business_hours FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "own business_place read" ON business_place FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
