-- ============================================================================
-- 2026-11-02 — Archive of replaced taste profiles.
--
-- Ami's dashboard can re-run the (two-deck) onboarding for an existing
-- business and replace its taste profile with the result (POST
-- /api/internal/taste-bench with `replace`). Before anything is replaced, the
-- business's whole current profile row and both of its recipe libraries are
-- copied here, so the previous taste is never lost. A replacement can't be
-- undone with the chat's or the admin console's undo (their snapshots don't
-- carry the energy scale); restoring goes through this table.
--
-- One row per replacement. RLS on, no policies: server-only (service role).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.business_taste_profile_archive (
  id                 bigserial PRIMARY KEY,
  business_id        uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  profile            jsonb NOT NULL,          -- the whole business_taste_profiles row as it was
  option1_directions jsonb,                   -- its active business_v7_directions rows
  level_directions   jsonb,                   -- its active business_v7_level_directions rows
  delivery_mode      text,                    -- the playlist type at the time
  reason             text NOT NULL,           -- 'reonboard'
  source             text NOT NULL,           -- who replaced it, e.g. 'ami-dashboard'
  archived_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_taste_profile_archive_business_idx
  ON public.business_taste_profile_archive (business_id, archived_at DESC);

ALTER TABLE public.business_taste_profile_archive ENABLE ROW LEVEL SECURITY;

-- New tables get no grants automatically (2026-10-30): the server writes and
-- reads this with the service role.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_taste_profile_archive TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.business_taste_profile_archive_id_seq TO service_role;
