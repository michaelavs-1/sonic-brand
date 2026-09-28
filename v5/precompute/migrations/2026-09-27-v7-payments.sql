-- Migration: v7 real payments via Hyp Pay (replaces the placeholder payment step).
--
-- Why: v7 signup must only create accounts for owners who actually paid.
-- The payment step now opens Hyp's hosted payment page (in an iframe) for an
-- automatic monthly charge (Hyp-managed recurring agreement, הוראת קבע). Each
-- attempt is one payment_checkouts row; its order_no is what we send to Hyp
-- as `Order`, and Hyp's redirect back (/api/v7/payment/return) marks it paid
-- after server-side verification. Signup then requires a paid checkout and
-- links it to the new business (business_id).
--
-- payment_coupons: first-month discounts only (Hyp's TashFirstPayment).
-- Seeds TEST50 (50% off the first month) for testing — deactivate it before
-- real customers arrive:  UPDATE payment_coupons SET active = false WHERE code = 'TEST50';
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

CREATE TABLE IF NOT EXISTS payment_coupons (
  code        text        PRIMARY KEY CHECK (code = upper(code)),
  percent_off int         NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  active      boolean     NOT NULL DEFAULT true,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_checkouts (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),  -- client-held handle
  order_no              bigserial     UNIQUE,                                -- sent to Hyp as Order
  hyp_env               text          NOT NULL CHECK (hyp_env IN ('test', 'production')),
  masof                 text          NOT NULL,                              -- terminal that took the payment
  email                 text          NOT NULL,
  business_name         text,
  onboarding_session_id text,
  coupon_code           text          REFERENCES payment_coupons(code),
  percent_off           int,
  amount_first          numeric(10,2) NOT NULL,                              -- first charge (after coupon)
  amount_monthly        numeric(10,2) NOT NULL,                              -- every later charge
  status                text          NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending', 'paid', 'failed')),
  hyp_trans_id          text,                                                -- redirect `Id`
  hyp_hk_id             text,                                                -- redirect `HKId` (recurring agreement)
  hyp_acode             text,
  hyp_ccode             text,
  hyp_amount            text,                                                -- redirect `Amount`, as sent
  return_query          text,                                                -- raw redirect query string (audit)
  paid_at               timestamptz,
  business_id           uuid          REFERENCES businesses(id) ON DELETE SET NULL,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_checkouts_business_idx ON payment_checkouts (business_id);

-- Server-only tables: RLS on, no policies (all access via service_role).
ALTER TABLE payment_coupons   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_checkouts ENABLE ROW LEVEL SECURITY;

INSERT INTO payment_coupons (code, percent_off, note)
VALUES ('TEST50', 50, 'Test coupon: 50% off the first month')
ON CONFLICT (code) DO NOTHING;

COMMIT;
