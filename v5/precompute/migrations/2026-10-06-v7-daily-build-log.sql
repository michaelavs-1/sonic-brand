-- v7 daily build log (2026-10-06): what happened when a business's daily
-- playlists were built — or why they weren't. One row per attempt worth
-- knowing about:
--   source  = 'cron' (api/cron/v7-generate-daily.js) | 'dashboard'
--             (api/v7/account/generate-daily.js — first login, "צור פלייליסטים",
--             "המקום פתוח?", "החליפו עכשיו", "השלימו עכשיו")
--   outcome = 'built' | 'partial' | 'zero-built' | 'build-failed' | 'outer-throw'
--             | 'no-directions' | 'no-genres' | 'no-hours' | 'bad-hours'
--             | 'no-taste-profile' | 'nothing-to-build:<reason>'
--   built / failed = playlist counts; detail = the error text, if any.
-- Routine cron skips (closed today, too early, already built, …) aren't logged.
-- Read by api/v7/account/daily-status.js: the dashboard's "why no playlists"
-- line and the "דווחו" report email. Writers are best-effort (a missing
-- table never blocks a build). Server-only: RLS on, no policies.
-- Idempotent.

CREATE TABLE IF NOT EXISTS v7_daily_build_log (
  id          bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  il_date     date NOT NULL,
  source      text NOT NULL,
  outcome     text NOT NULL,
  built       int  NOT NULL DEFAULT 0,
  failed      int  NOT NULL DEFAULT 0,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS v7_daily_build_log_biz_created
  ON v7_daily_build_log (business_id, created_at DESC);

ALTER TABLE v7_daily_build_log ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
