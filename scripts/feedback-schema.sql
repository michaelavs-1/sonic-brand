-- ══════════════════════════════════════════════════════════════════
-- SonicBrand Feedback Learning System — Supabase Schema
-- Run once in Supabase SQL Editor.
-- Creates 1 table + 2 views for global threshold-based learning.
-- ══════════════════════════════════════════════════════════════════

-- ─── TABLE: track_feedback ────────────────────────────────────────
-- One row per user feedback action (thumbs down / never again / reason).
-- Global — all users contribute to one learning pool.
CREATE TABLE IF NOT EXISTS track_feedback (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id         UUID REFERENCES analyses(id) ON DELETE SET NULL,
  track_spotify_id    TEXT NOT NULL,
  track_name          TEXT,
  artist_spotify_id   TEXT,
  artist_name         TEXT,
  feedback_type       TEXT NOT NULL CHECK (feedback_type IN ('thumbs_down','never_again','thumbs_up')),
  reason_code         TEXT, -- 'too_mainstream' | 'wrong_era' | 'wrong_energy' | 'wrong_language' | 'artist_ban' | NULL
  context             JSONB, -- snapshot of settings: {biz, faders, familiarity_band}
  user_name           TEXT,  -- optional: which user gave the feedback
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tf_artist      ON track_feedback(artist_spotify_id);
CREATE INDEX IF NOT EXISTS idx_tf_track       ON track_feedback(track_spotify_id);
CREATE INDEX IF NOT EXISTS idx_tf_reason      ON track_feedback(reason_code);
CREATE INDEX IF NOT EXISTS idx_tf_type        ON track_feedback(feedback_type);
CREATE INDEX IF NOT EXISTS idx_tf_created     ON track_feedback(created_at DESC);

-- ─── VIEW: learned_artist_banlist ─────────────────────────────────
-- Artists banned after 3+ thumbs_down/never_again from 3+ distinct analyses
-- (threshold prevents a single user from "poisoning" an artist globally).
CREATE OR REPLACE VIEW learned_artist_banlist AS
SELECT
  artist_spotify_id,
  MAX(artist_name)                           AS artist_name,
  COUNT(DISTINCT analysis_id)                AS distinct_contexts,
  COUNT(*)                                   AS total_downvotes,
  ARRAY_AGG(DISTINCT reason_code) FILTER (WHERE reason_code IS NOT NULL) AS reasons,
  MAX(created_at)                            AS last_downvote_at
FROM track_feedback
WHERE feedback_type IN ('thumbs_down','never_again')
  AND artist_spotify_id IS NOT NULL
  AND artist_spotify_id <> ''
GROUP BY artist_spotify_id
HAVING COUNT(DISTINCT analysis_id) >= 3;

-- ─── VIEW: learned_track_banlist ──────────────────────────────────
-- Specific tracks banned after 2+ downvotes (tracks are stronger signal).
CREATE OR REPLACE VIEW learned_track_banlist AS
SELECT
  track_spotify_id,
  MAX(track_name)                            AS track_name,
  MAX(artist_name)                           AS artist_name,
  COUNT(*)                                   AS downvotes,
  MAX(created_at)                            AS last_downvote_at
FROM track_feedback
WHERE feedback_type IN ('thumbs_down','never_again')
  AND track_spotify_id IS NOT NULL
  AND track_spotify_id <> ''
GROUP BY track_spotify_id
HAVING COUNT(*) >= 2;

-- ─── VIEW: learned_reason_stats ───────────────────────────────────
-- Aggregate counts per reason_code — feeds into OpenAI brief as soft context.
CREATE OR REPLACE VIEW learned_reason_stats AS
SELECT
  reason_code,
  COUNT(*)                                   AS total,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS last_30d,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS last_7d
FROM track_feedback
WHERE feedback_type IN ('thumbs_down','never_again')
  AND reason_code IS NOT NULL
GROUP BY reason_code
ORDER BY total DESC;

-- ─── RLS: allow anon read + insert (feedback is non-sensitive) ────
ALTER TABLE track_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY tf_anon_select ON track_feedback
  FOR SELECT USING (true);

CREATE POLICY tf_anon_insert ON track_feedback
  FOR INSERT WITH CHECK (true);

-- Views inherit RLS from base table automatically.

-- ──────────────────────────────────────────────────────────────────
-- Done. After running, verify:
--   SELECT COUNT(*) FROM track_feedback;                   -- 0
--   SELECT * FROM learned_artist_banlist LIMIT 5;          -- empty until 3+ downvotes accumulate
--   SELECT * FROM learned_reason_stats;                    -- empty
-- ──────────────────────────────────────────────────────────────────
