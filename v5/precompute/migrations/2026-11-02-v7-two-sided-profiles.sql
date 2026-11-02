-- ============================================================================
-- 2026-11-02 — Two-sided taste profiles (the two-deck onboarding, Ami).
--
-- A profile built by the new onboarding has a calm side (the lower half of
-- the owner's energy scale, from the calm deck's likes) and an energetic side
-- (the upper half, from the energetic deck's likes), and may approve a
-- both-ways genre twice, once per side (shared/genre-sides.js). The flag tells
-- the taste chat and the admin console's edits (v7/generation/taste-ops.js)
-- to keep the two sides apart and respect them.
--
-- Default false: every existing profile is unchanged and keeps behaving as
-- before (one entry per genre, energy placed relative to the owner's genres).
-- Signup sets it to true only when the owner liked something on both decks.
--
-- A new column on an existing table — the table's grants already cover it.
-- ============================================================================

ALTER TABLE public.business_taste_profiles
  ADD COLUMN IF NOT EXISTS two_sided boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.business_taste_profiles.two_sided IS
  'Two-deck onboarding (2026-11-02): calm side = levels <= N/2, energetic side = levels > N/2; a both-ways genre may be approved once per side. false = the older one-entry-per-genre profile.';
