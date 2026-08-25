-- 2026-08-25 — direction-edit chat: transcript + change audit.
--
-- Adds two tables that back the profile-page chat where an owner refines
-- their musical directions (add / edit / remove) after onboarding. See
-- CLAUDE.md "Direction-edit chat" mechanism for the full flow.
--
--   business_direction_chats    — rolling per-business message log. Chat
--                                 context loader reads the tail; internal
--                                 admin API returns the full transcript.
--
--   business_direction_changes  — one row per committed change (add/edit/
--                                 remove) with before/after JSON snapshots
--                                 and pointers into the message log that
--                                 produced the change. Admin API surfaces
--                                 this as the "what changed and when" feed
--                                 for each business.
--
-- No changes to business_directions itself — removals are the existing
-- soft-disable (active=false); adds/edits mutate the same row in place. The
-- audit table is the durable record of what moved.
--
-- Idempotent. Safe to run twice. Run in Supabase SQL Editor.

BEGIN;

-- 1) business_direction_chats — one row per message.
CREATE TABLE IF NOT EXISTS business_direction_chats (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role                  text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content               text        NOT NULL,
  -- Optional structured payload attached to an assistant turn (a proposed
  -- add/edit/remove operation shown as an inline confirm button).
  proposal              jsonb,
  -- Which direction card the user had selected when they sent this turn.
  -- Null for turns that didn't target a specific direction.
  selected_direction_id uuid        REFERENCES business_directions(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_direction_chats_biz_time_idx
  ON business_direction_chats (business_id, created_at);

-- 2) business_direction_changes — one row per committed change.
--    direction_id nullable: for 'add' it's the freshly-inserted direction's
--    id (populated after the INSERT); for 'edit'/'remove' it's the existing
--    direction. before/after are direction snapshots — null on the missing
--    side (add has no before, remove has no after).
CREATE TABLE IF NOT EXISTS business_direction_changes (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  direction_id          uuid        REFERENCES business_directions(id) ON DELETE SET NULL,
  kind                  text        NOT NULL CHECK (kind IN ('add', 'edit', 'remove')),
  before                jsonb,
  after                 jsonb,
  -- Pointers into business_direction_chats for the message range that
  -- produced this change. Both nullable so a server-initiated change
  -- (future admin action) can still write an audit row without a chat.
  message_id_first      uuid        REFERENCES business_direction_chats(id) ON DELETE SET NULL,
  message_id_last       uuid        REFERENCES business_direction_chats(id) ON DELETE SET NULL,
  -- What we did with the currently-live Spotify playlist for the affected
  -- direction. 'rebuilt' for add/edit (fresh playlist created today);
  -- 'expired' or 'kept' for remove (user chose whether to nuke today's
  -- playlist or let it run out the clock).
  playlist_action       text        CHECK (playlist_action IN ('rebuilt', 'expired', 'kept')),
  applied_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_direction_changes_biz_time_idx
  ON business_direction_changes (business_id, applied_at);

-- 3) RLS — same model as business_directions (2026-08-20 migration): the
--    account dashboard reads its own rows via anon-key + owner check;
--    writes go through server endpoints with service_role.
ALTER TABLE business_direction_chats  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own direction chats read" ON business_direction_chats;
CREATE POLICY "own direction chats read" ON business_direction_chats FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

ALTER TABLE business_direction_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own direction changes read" ON business_direction_changes;
CREATE POLICY "own direction changes read" ON business_direction_changes FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMIT;
