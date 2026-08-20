-- Migration: super_liked_tracks — per-business record of tracks the owner
-- explicitly "super-liked" during onboarding's preview swipe deck.
--
-- Why: the preview cards now carry a Tinder-style super-like button on
-- top of the swipe left/right decisions. Super-liking a track records it
-- against the (future) business — nothing consumes these rows yet, but
-- they're captured for downstream playlist tuning ("keep more of these
-- tracks in future daily gens", "seed a taste vector", etc).
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

CREATE TABLE IF NOT EXISTS super_liked_tracks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  spotify_id  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, spotify_id)
);

CREATE INDEX IF NOT EXISTS super_liked_tracks_business_idx
  ON super_liked_tracks (business_id);

-- RLS — same model as the other business_* tables (2026-08-05 migration):
-- client-direct reads gated by owner check, writes via server endpoints
-- with service_role.
ALTER TABLE super_liked_tracks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own super_liked_tracks read" ON super_liked_tracks;
CREATE POLICY "own super_liked_tracks read" ON super_liked_tracks FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
