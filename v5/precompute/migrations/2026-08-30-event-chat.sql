-- 2026-08-30 — persist the special-events chat transcript.
--
-- Adds `business_event_chats` — one row per message in the events-tab
-- chat (chat that produces a { name_he, description_he } for a one-off
-- event playlist). Mirrors the design of business_direction_chats
-- (2026-08-25 migration) except the chat is scoped to events instead
-- of directions:
--   selected_direction_id  →  event_id
--
-- `event_id` is nullable and backfilled by /api/v6/account/upsert-event
-- when the owner finalizes an event — all messages produced by that
-- chat session are stamped with the freshly-created event's id, so the
-- admin API can surface "here's the conversation that produced this
-- event".
--
-- No changes to business_events itself.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

CREATE TABLE IF NOT EXISTS business_event_chats (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role         text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content      text        NOT NULL,
  -- Structured payload attached to an assistant turn when Gemini reaches
  -- confirming state: `{ name_he, description_he }`. Null on every other
  -- assistant turn AND on user turns.
  proposal     jsonb,
  -- Backfilled when the chat session produces a saved event. Nullable
  -- because most rows exist BEFORE finalization; the finalize endpoint
  -- runs one UPDATE across the session's rows.
  event_id     uuid        REFERENCES business_events(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_event_chats_biz_time_idx
  ON business_event_chats (business_id, created_at);

CREATE INDEX IF NOT EXISTS business_event_chats_event_idx
  ON business_event_chats (event_id) WHERE event_id IS NOT NULL;

-- RLS — same shape as business_direction_chats: client-direct reads
-- gated by owner check, writes via server endpoint with service_role.
ALTER TABLE business_event_chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own event chats read" ON business_event_chats;
CREATE POLICY "own event chats read" ON business_event_chats FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
