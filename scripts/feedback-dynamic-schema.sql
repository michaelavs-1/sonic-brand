-- ══════════════════════════════════════════════════════════════════
-- SonicBrand — Dynamic Learning Insights Schema (V2)
-- Run once in Supabase SQL Editor after feedback-schema.sql.
-- Creates the learned_insights table — home for GPT-4o reflections.
-- ══════════════════════════════════════════════════════════════════

-- ─── TABLE: learned_insights ──────────────────────────────────────
-- Each row = one rule/insight synthesized by GPT-4o from feedback.
-- Scope captures the contextual conditions (biz, faders, era, etc.)
-- so rules activate only when the current context matches.
CREATE TABLE IF NOT EXISTS learned_insights (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_text        TEXT NOT NULL,        -- human-readable IF/THEN rule
  scope            JSONB,                -- e.g. {"biz":"cafe","energy_max":0.5}
  confidence       NUMERIC DEFAULT 0.5,  -- 0..1 — GPT's self-assessed confidence
  based_on_count   INT DEFAULT 0,        -- how many feedback rows this rule draws from
  category         TEXT,                 -- 'artist_avoid'|'era_avoid'|'energy'|'language'|'mainstream'|'general'
  usage_count      INT DEFAULT 0,        -- how many analyses cited this rule
  hit_count        INT DEFAULT 0,        -- how many analyses produced NO downvotes after citing it
  signature        TEXT UNIQUE,          -- dedup hash: lower(rule_text) trimmed
  superseded_by    UUID REFERENCES learned_insights(id) ON DELETE SET NULL,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_li_active     ON learned_insights(active);
CREATE INDEX IF NOT EXISTS idx_li_category   ON learned_insights(category);
CREATE INDEX IF NOT EXISTS idx_li_confidence ON learned_insights(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_li_created    ON learned_insights(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_li_scope_gin  ON learned_insights USING GIN (scope);

-- ─── RLS: allow anon read + insert + update ──────────────────────
ALTER TABLE learned_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS li_anon_select ON learned_insights;
CREATE POLICY li_anon_select ON learned_insights
  FOR SELECT USING (true);

DROP POLICY IF EXISTS li_anon_insert ON learned_insights;
CREATE POLICY li_anon_insert ON learned_insights
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS li_anon_update ON learned_insights;
CREATE POLICY li_anon_update ON learned_insights
  FOR UPDATE USING (true) WITH CHECK (true);

-- ─── VIEW: active_insights ───────────────────────────────────────
-- Convenience view: only active, ranked by confidence×based_on_count.
CREATE OR REPLACE VIEW active_insights AS
SELECT
  id,
  rule_text,
  scope,
  confidence,
  based_on_count,
  category,
  usage_count,
  hit_count,
  created_at,
  last_used_at,
  (confidence * LEAST(based_on_count, 20) / 20.0) AS strength
FROM learned_insights
WHERE active = TRUE
  AND superseded_by IS NULL
ORDER BY strength DESC, created_at DESC;

-- ─── VIEW: insight_summary ───────────────────────────────────────
-- Quick stats for the drawer UI.
CREATE OR REPLACE VIEW insight_summary AS
SELECT
  COUNT(*) FILTER (WHERE active = TRUE) AS active_count,
  COUNT(*)                               AS total_count,
  AVG(confidence) FILTER (WHERE active = TRUE) AS avg_confidence,
  MAX(created_at)                        AS last_generated_at,
  SUM(usage_count)                       AS total_citations
FROM learned_insights;

-- ──────────────────────────────────────────────────────────────────
-- Done. Verify:
--   SELECT COUNT(*) FROM learned_insights;   -- 0
--   SELECT * FROM insight_summary;           -- all zeros/nulls
-- ──────────────────────────────────────────────────────────────────
