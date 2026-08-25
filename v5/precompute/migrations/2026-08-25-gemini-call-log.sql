-- 2026-08-25 — per-call Gemini spend log.
--
-- Every request through /api/v6/gemini writes one row here after the
-- upstream response comes back (fire-and-forget so it doesn't add
-- latency to the user-facing call). Cost is computed server-side from
-- token counts × per-model rates (see api/v6/gemini-pricing.js).
--
-- Attribution:
--   * Calls originating from a signed-in user's dashboard (event chat,
--     direction-edit chat, etc.) pass `business_id` directly at write
--     time and never touch `onboarding_session_id`.
--   * Onboarding calls (musical directions) happen before the business
--     exists. The client mints a random `onboarding_session_id` at
--     v6/app.js boot and passes it on every Gemini call during that
--     tab's flow. On signup, api/v6/account/signup.js runs one
--     UPDATE that backfills business_id and clears the session id.
--     Rows left with a non-null session id (owner abandoned the flow
--     before signing up) form the "abandoned onboarding" bucket in the
--     admin spend endpoint.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

CREATE TABLE IF NOT EXISTS gemini_call_log (
  id                     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             timestamptz    NOT NULL DEFAULT now(),
  model                  text           NOT NULL,
  label                  text,                     -- caller-supplied tag,
                                                   -- e.g. 'musical-directions-top'
                                                   -- or 'event-chat-turn'
  input_tokens           int,
  output_tokens          int,                      -- includes thinking tokens
                                                   -- (Google bills them at the
                                                   -- output rate — see pricing
                                                   -- module)
  thinking_tokens        int,                      -- broken out for analytics;
                                                   -- already inside output_tokens
                                                   -- for cost purposes
  total_tokens           int,
  cost_usd               numeric(12, 8),
  business_id            uuid           REFERENCES businesses(id) ON DELETE SET NULL,
  onboarding_session_id  text,                     -- ephemeral tab-lifetime UUID
                                                   -- from the client
  http_status            int,
  finish_reason          text
);

CREATE INDEX IF NOT EXISTS gemini_call_log_time_idx
  ON gemini_call_log (created_at);
CREATE INDEX IF NOT EXISTS gemini_call_log_biz_time_idx
  ON gemini_call_log (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gemini_call_log_session_idx
  ON gemini_call_log (onboarding_session_id)
  WHERE onboarding_session_id IS NOT NULL;

-- RLS: writes are server-only (service_role bypasses). Reads only via
-- the internal admin API (also service_role). No policy = deny by
-- default for anon/authenticated roles.
ALTER TABLE gemini_call_log ENABLE ROW LEVEL SECURITY;

COMMIT;
