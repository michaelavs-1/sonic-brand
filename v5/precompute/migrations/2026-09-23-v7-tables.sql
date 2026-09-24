-- Migration: v7 runtime tables + businesses.version / paid_at columns.
--
-- Why: v7 changes the mental model. Onboarding directions are diagnostic
-- taste PROBES, not playlist seeds — after the swipe deck the picked /
-- disliked directions dissolve (inside generateTasteProfile) into a flat,
-- full-catalog taste profile. v7 therefore writes NO business_directions
-- rows; instead it persists a single per-business taste profile row and,
-- later (Phase B), energy-tiered "v7 directions" derived from that profile.
--
-- Also adds businesses.version so the v6 daily-gen cron can skip v7
-- businesses and the (future) v7 cron can target only them, and
-- businesses.paid_at as a placeholder payment-completion marker (v7 signup
-- fires only after the payment step — "no non-paying clients").
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

-- 0) businesses.version + paid_at.
--    version defaults to 'v6' so every pre-existing row keeps its v6
--    behavior; v7 signup sets 'v7'. paid_at is set by v7 signup at the
--    payment step (placeholder — no real payment integration yet).
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT 'v6';
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;
CREATE INDEX IF NOT EXISTS businesses_version_idx ON businesses (version);

-- 1) business_taste_profiles — one row per v7 business. The flat, full-
--    catalog taste profile produced by generateTasteProfile(): every one
--    of the 116 canonical genres bucketed approved / conditional /
--    excluded, plus a per-user dynamic energy scale (energy_levels_total
--    2..6) and carry-through prefs. audit_tally is the per-genre
--    like/dislike count captured at onboarding — analytics ONLY, not used
--    to build playlists.
CREATE TABLE IF NOT EXISTS business_taste_profiles (
  business_id                 uuid        PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  energy_levels_total         int,                       -- 2..6, dynamic per user
  approved_genres             jsonb,                     -- [{genre, energy_level}]
  conditional_genres          jsonb,                     -- [{genre, energy_level, note_en}] — DATA ONLY in the initial v7 build
  excluded_genres             jsonb,                     -- [string]
  instrumentalness_preference text        DEFAULT 'none',
  popularity_preference       text        DEFAULT 'none',
  reasoning_en                text,
  audit_tally                 jsonb,                     -- [{genre, like, dislike}] — analytics only
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- 2) business_v7_settings — per-business delivery mode chosen at the
--    first-login gate. delivery_mode stays NULL until the owner picks
--    Option 1 (4 playlists/day) or Option 2 (2 playlists/day). timeline
--    is the Option-2 interactive-timeline placeholder (nullable).
CREATE TABLE IF NOT EXISTS business_v7_settings (
  business_id   uuid        PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  delivery_mode text        CHECK (delivery_mode IN ('option1', 'option2')),
  timeline      jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 3) business_v7_directions — energy-tiered directions for Option 1
--    (populated by the Phase B energy-directions call at mode selection).
--    No BPM / preferences here — v7 emits no tempo axis and prefs live on
--    the taste profile.
CREATE TABLE IF NOT EXISTS business_v7_directions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  energy_tier text        NOT NULL CHECK (energy_tier IN ('high', 'low')),
  rank        int,
  title_en    text,
  genres      jsonb       NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_v7_directions_active_idx
  ON business_v7_directions (business_id) WHERE active = true;

-- 4) RLS — same model as the other business_* tables (2026-08-05 /
--    2026-08-20 migrations): owner-scoped client-direct SELECT; all writes
--    go through server endpoints with service_role (which bypasses RLS).
ALTER TABLE business_taste_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own taste profile read" ON business_taste_profiles;
CREATE POLICY "own taste profile read" ON business_taste_profiles FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

ALTER TABLE business_v7_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own v7 settings read" ON business_v7_settings;
CREATE POLICY "own v7 settings read" ON business_v7_settings FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

ALTER TABLE business_v7_directions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own v7 directions read" ON business_v7_directions;
CREATE POLICY "own v7 directions read" ON business_v7_directions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
