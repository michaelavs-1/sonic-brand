-- 2026-10-21 — v7 musical portraits ("who this owner is musically").
--
-- A short Hebrew text per business, kept by Rubin, that the taste chat
-- ("הטעם המוזיקלי שלכם") reads on every turn. Rewritten after every "success"
-- in that chat (the chat and the owner understood each other and the chat
-- offered the confirm button) from the messages that led to it; the first
-- version comes from the onboarding answers. Every version is kept: the
-- current portrait is the newest row.
--
-- Written by api/v7/account/taste-portrait.js (and
-- scripts/_v7-backfill-taste-portraits.mjs for accounts from before it);
-- read by api/v7/account/_taste-context.js and the admin API.
--
-- Idempotent. Run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS business_taste_portraits (
  id           bigserial   PRIMARY KEY,
  business_id  uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  portrait_he  text        NOT NULL,
  -- 'onboarding' = the first version, from the onboarding answers;
  -- 'chat' = rewritten after a success in the taste chat;
  -- 'backfill' = written for an account from before portraits existed.
  source       text        NOT NULL CHECK (source IN ('onboarding', 'chat', 'backfill')),
  -- The assistant message (with the confirm button) whose success led to
  -- this version. Null for 'onboarding' / 'backfill'.
  message_id   uuid        REFERENCES business_direction_chats(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_taste_portraits_biz_time_idx
  ON business_taste_portraits (business_id, created_at DESC);

-- Server-only (service role), like the other v7 logs.
ALTER TABLE business_taste_portraits ENABLE ROW LEVEL SECURITY;
