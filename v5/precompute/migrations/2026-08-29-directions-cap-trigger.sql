-- Migration: enforce the 8-active-directions-per-business cap at the DB
-- level, so signup, apply-direction-change, migrations, and direct SQL
-- can't push a business past 8 active rows in business_directions.
--
-- Background: today the cap lives in apply-direction-change.js as a
-- SELECT-count-then-INSERT check (TOCTOU-racy under concurrent adds) plus
-- a soft "don't propose add at cap" hint to Gemini in direction-chat.js.
-- Signup has no cap at all — it only stays in bounds because the swipe
-- deck client-side shows a max of 8 cards. A crafted signup payload would
-- currently blow past the cap.
--
-- The trigger below closes all three gaps in one place. Fires BEFORE the
-- write, so failing checks abort the transaction with a check_violation
-- error before any row lands. Race-safe via a per-business advisory lock:
-- concurrent txs touching the same business_id serialize; different
-- businesses run in parallel.
--
-- Client-visible errors: apply-direction-change already returns a friendly
-- code:'cap_reached' via its app-level check, so end users never see the
-- raw exception. Signup should be updated to cap the array at 8 before
-- INSERT so a legit signup with 8 picks never hits the trigger and a
-- crafted payload with 20 picks is silently trimmed to the first 8
-- (rather than aborting the whole signup).
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

CREATE OR REPLACE FUNCTION enforce_active_directions_cap()
RETURNS trigger AS $$
DECLARE
  target_biz     uuid;
  current_active int;
BEGIN
  -- Determine the target business + short-circuit no-op cases.
  IF TG_OP = 'INSERT' THEN
    -- Inserting an already-inactive row can't affect the active count.
    IF NEW.active IS NOT TRUE THEN
      RETURN NEW;
    END IF;
    target_biz := NEW.business_id;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Only relevant when the resulting row is active AND either:
    --   (a) it just flipped from inactive → active, or
    --   (b) it moved to a different business (rare).
    -- An already-active row that stays active on the same business
    -- doesn't change the count for that business, so skip.
    IF NEW.active IS NOT TRUE THEN
      RETURN NEW;
    END IF;
    IF OLD.active IS TRUE AND OLD.business_id = NEW.business_id THEN
      RETURN NEW;
    END IF;
    target_biz := NEW.business_id;

  ELSE
    RETURN NEW;
  END IF;

  -- Per-business advisory lock, released at end of transaction. Serializes
  -- concurrent inserts/updates against the same business_id so two racing
  -- adds can't both pass the count check and both land at 9. Different
  -- businesses hash to different keys and run in parallel.
  PERFORM pg_advisory_xact_lock(hashtext(target_biz::text));

  -- Count active rows for the target business, excluding the row being
  -- written (matters for UPDATE — we're about to make it active, so it
  -- shouldn't be double-counted).
  SELECT count(*)
    INTO current_active
    FROM business_directions
   WHERE business_id = target_biz
     AND active = true
     AND id <> NEW.id;

  IF current_active >= 8 THEN
    RAISE EXCEPTION 'business % already has 8 active directions', target_biz
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS business_directions_cap ON business_directions;
CREATE TRIGGER business_directions_cap
BEFORE INSERT OR UPDATE ON business_directions
FOR EACH ROW
EXECUTE FUNCTION enforce_active_directions_cap();

COMMIT;

-- ---- Verification (run after commit) ----
-- Should return zero rows: any current business with more than 8 active.
--   SELECT business_id, count(*) FROM business_directions
--    WHERE active = true GROUP BY business_id HAVING count(*) > 8;
--
-- Should fail with "business ... already has 8 active directions":
--   INSERT INTO business_directions (business_id, genres, bpm_range)
--   SELECT business_id, '["Bossa Nova"]'::jsonb, '{"min":80,"max":110}'::jsonb
--   FROM business_directions
--   WHERE active = true
--   GROUP BY business_id
--   HAVING count(*) = 8
--   LIMIT 1;
