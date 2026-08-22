-- 2026-08-22 — Drop legacy tables left over from v1/v2 that had
-- catastrophically permissive RLS (USING true on all CRUD ops) and are
-- unreferenced by any v4/v5/v6 code path.
--
-- Verified before drop:
--   `spotify_tokens` — only referenced by api/spotify.js (root-level
--     v1-era proxy that is not part of any active flow). Contained no
--     rows at time of drop (checked via SELECT count(*)).
--   `taste_memory` — no references in api/, v4/, v5/, or v6/. Truly
--     orphaned.
--
-- Before the drop, both tables were browser-accessible via the anon key
-- because their policies were `USING (true)` on all commands (see the
-- 2026-08-22 audit run). Dropping the tables removes the exposure and
-- eliminates the "wide-open RLS" pattern from the schema so future
-- copy-paste additions can't inherit it.
--
-- Second sweep (same date, second verification pass): five more v1/v2/v3-era
-- tables verified as unreferenced by any v4/v5/v6/cron code path. Each had
-- permissive anon-insert (and in some cases anon-read) RLS policies —
-- attacker-usable as a scratch data store even though the tables held
-- nothing sensitive. Drop removes the tables AND the permissive policies
-- from the schema so the "wide-open RLS" pattern can't accidentally get
-- copy-pasted into a future table.
--
-- Verified unreferenced by grep across api/v4/, api/v5/, api/v6/, api/cron/,
-- v6/:
--   `analyses`          — only mentioned in v3/ frontend + v4 log strings
--   `user_spotify`      — zero references anywhere
--   `song_recognitions` — zero references anywhere
--   `track_feedback`    — only v3/v2 frontends + one-off scripts/
--   `learned_insights`  — only in scripts/ dev tools
--
-- v3/v2 frontends are historical (see CLAUDE.md "Version Landscape") and
-- dropping these tables just means feedback/recognition features on those
-- pages 500 instead of silently storing to attacker-shared tables. If v3
-- or v2 flows are ever needed again, restore from git history.

-- IF NOT EXISTS makes this idempotent — safe to re-run.

DROP TABLE IF EXISTS public.spotify_tokens    CASCADE;
DROP TABLE IF EXISTS public.taste_memory      CASCADE;
DROP TABLE IF EXISTS public.analyses          CASCADE;
DROP TABLE IF EXISTS public.user_spotify      CASCADE;
DROP TABLE IF EXISTS public.song_recognitions CASCADE;
DROP TABLE IF EXISTS public.track_feedback    CASCADE;
DROP TABLE IF EXISTS public.learned_insights  CASCADE;
