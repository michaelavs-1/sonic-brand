-- 2026-10-26 — like / dislike on a daily playlist (v7 Home tab).
--
-- Two bare icons sit beside each daily playlist's "▶ פתח" button. A tap
-- records the verdict at once and opens a modal asking what the owner liked
-- or didn't ("מה אהבתם בפלייליסט?"), with an optional free-text field —
-- "שלח" stores the text, "דלג" leaves the verdict alone. Tapping the lit
-- icon again clears the verdict.
--
-- One row per (business, playlist): the owner's CURRENT verdict, replaced in
-- place when they change their mind and deleted when they clear it. Playlists
-- are per day, so the rows accumulate day by day on their own, and
-- business_playlists rows are never deleted — the admin API joins on
-- spotify_id for the playlist's name, genres and tracks.
--
-- Written by api/v7/account/playlist-feedback.js (service role); read
-- client-direct by the owner's dashboard (RLS below) and by the admin API.
--
-- Idempotent. Run in the Supabase SQL editor.

BEGIN;

CREATE TABLE IF NOT EXISTS business_playlist_feedback (
  id          bigserial   PRIMARY KEY,
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- The Spotify playlist id, as in business_playlists.spotify_id. Not an FK:
  -- business_playlist_opens does the same, and a verdict should survive a
  -- playlist row that was never written.
  spotify_id  text        NOT NULL,
  verdict     text        NOT NULL CHECK (verdict IN ('like', 'dislike')),
  -- What the owner typed in the modal. NULL = they skipped it (or cleared
  -- the text on a later pass).
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Bumped whenever the verdict or the reason changes.
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, spotify_id)
);

CREATE INDEX IF NOT EXISTS business_playlist_feedback_biz_time_idx
  ON business_playlist_feedback (business_id, updated_at DESC);

-- Same RLS model as the other business_* tables: owner-scoped client-direct
-- SELECT (the dashboard reads its own verdicts to light the icons); every
-- write goes through the server endpoint with the service role.
ALTER TABLE business_playlist_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own playlist feedback read" ON business_playlist_feedback;
CREATE POLICY "own playlist feedback read" ON business_playlist_feedback FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Explicit grants (CLAUDE.md → DATA MODEL: new public tables are not granted
-- automatically, service_role included). SELECT for the owner's own session
-- is what the policy above filters.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_playlist_feedback TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.business_playlist_feedback_id_seq TO service_role;
GRANT SELECT ON public.business_playlist_feedback TO authenticated;

COMMIT;
