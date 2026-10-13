-- ============================================================================
-- 2026-10-13 — the admin console (Michael's dashboard, /api/internal/*).
--
-- The internal admin API moved to v7 and gained actions (Roni + Michael's
-- list, 2026-10-13). This adds what those need:
--
-- 1. business_taste_profiles.onboarding_probes — the swipe cards the owner saw
--    during onboarding (Round 1 + Round 2), each with its genres and whether
--    the owner liked it. Sent by the onboarding page at signup from now on;
--    NULL for accounts that signed up before (they only have audit_tally,
--    the per-genre like/dislike counts).
-- 2. business_taste_changes.source — 'chat' (the owner, through the taste
--    chat) or 'admin' (the admin console's direction edits). The owner's
--    "undo" never reverts an admin change, and the chat isn't shown them.
-- 3. business_v7_daily_picks — the admin's choice of which direction plays
--    in a given daily playlist on a given business day, instead of the usual
--    draw (Option 1: random + least alike; Option 2: the daily rotation).
--    The direction's genres are COPIED in, so later edits to the library
--    (which rewrite its rows) don't break a pick. The builders still drop any
--    genre that's no longer approved in that tier / level.
-- 4. gemini_call_log.cached_tokens — prompt tokens Google served from its
--    implicit cache, billed at a tenth of the input rate
--    (api/v6/gemini-pricing.js). Before this, cost_usd counted them at the
--    full input rate (so it ran slightly high).
-- 5. admin_actions — a log of every write made through the admin console
--    (direction edits, daily picks, rebuilds, coupons).
--
-- Until this runs: the read endpoints work (the new fields come back empty),
-- the direction edits work but aren't marked as admin changes, daily picks
-- answer 501, and Gemini calls log without cached_tokens.
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

-- ---- 1. onboarding swipe cards ------------------------------------------------
ALTER TABLE business_taste_profiles ADD COLUMN IF NOT EXISTS onboarding_probes jsonb;

-- ---- 2. who made a taste change -------------------------------------------------
ALTER TABLE business_taste_changes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'chat';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_taste_changes_source_check'
  ) THEN
    ALTER TABLE business_taste_changes
      ADD CONSTRAINT business_taste_changes_source_check CHECK (source IN ('chat', 'admin'));
  END IF;
END $$;

-- ---- 3. the admin's daily picks ---------------------------------------------------
CREATE TABLE IF NOT EXISTS business_v7_daily_picks (
  id                  bigserial   PRIMARY KEY,
  business_id         uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  il_date             date        NOT NULL,   -- the business day (Israel)
  mode                text        NOT NULL CHECK (mode IN ('option1', 'option2')),
  -- Option 1: 'high-1' | 'high-2' | 'low-1' | 'low-2' (= "אנרגיה גבוהה #1" …)
  -- Option 2: 'mix-<1|2>:L<level>' (= that energy level of "Daily Mix #1/#2")
  slot                text        NOT NULL,
  title_en            text,
  genres              jsonb       NOT NULL,   -- canonical names, copied at pick time
  energy_range        jsonb,                  -- Option 2: the recipe's own range, if any
  source_direction_id uuid,                   -- the library row it was copied from (may be gone)
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, il_date, slot)
);
CREATE INDEX IF NOT EXISTS business_v7_daily_picks_day_idx
  ON business_v7_daily_picks (business_id, il_date);
ALTER TABLE business_v7_daily_picks ENABLE ROW LEVEL SECURITY;   -- server-only (service role)

-- ---- 4. Gemini cached tokens -------------------------------------------------------
ALTER TABLE gemini_call_log ADD COLUMN IF NOT EXISTS cached_tokens integer NOT NULL DEFAULT 0;

-- ---- 5. admin action log ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_actions (
  id           bigserial   PRIMARY KEY,
  business_id  uuid        REFERENCES businesses(id) ON DELETE SET NULL,
  action       text        NOT NULL,          -- e.g. 'direction:add_genre', 'daily_pick:set', 'coupon:create'
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_business_idx ON admin_actions (business_id, created_at DESC);
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;   -- server-only (service role)

NOTIFY pgrst, 'reload schema';
