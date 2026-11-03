-- ============================================================================
-- 2026-11-03 — Spotify accounts: which account each business's playlists go on.
--
-- Until now every playlist was made on one Spotify account ("Robin - Sonic
-- Brands", the RUBIN_* env vars). More accounts are coming, each business set
-- to one of them by hand (Roni). This adds:
--   spotify_accounts                      one row per account. No secrets: an
--                                         account's login token lives in env
--                                         vars (api/_spotify-accounts.js).
--   businesses.spotify_account_id         the account a business's NEW
--                                         playlists are made on.
--   created_playlists.spotify_account_id  the account a playlist was made on,
--                                         so it's changed and deleted there,
--                                         even after its business has moved.
--
-- Today: one account, 'robin-1', with every business on it.
--
-- Moving a business (its next playlists go to the new account; the ones
-- already made stay where they are until they expire):
--   UPDATE public.businesses SET spotify_account_id = '<account id>' WHERE id = '<business id>';
-- New businesses get the active account marked is_default.
--
-- Accounts are never deleted (the ledger points at them): set active = false.
-- RLS on, no policies: server-only (service role).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.spotify_accounts (
  id              text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,40}$'),  -- also names its env vars
  label           text,                         -- internal name, e.g. 'Robin 1'
  email           text,                         -- the account's Spotify login email
  spotify_user_id text,
  display_name    text,                         -- the name Spotify shows
  is_default      boolean NOT NULL DEFAULT false,   -- new businesses go here
  active          boolean NOT NULL DEFAULT true,    -- false = out of use
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- At most one default account.
CREATE UNIQUE INDEX IF NOT EXISTS spotify_accounts_one_default
  ON public.spotify_accounts (is_default) WHERE is_default;

ALTER TABLE public.spotify_accounts ENABLE ROW LEVEL SECURITY;

-- New tables get no grants automatically (2026-10-30).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spotify_accounts TO service_role;

INSERT INTO public.spotify_accounts (id, label, email, spotify_user_id, display_name, is_default)
VALUES ('robin-1', 'Robin 1', 'sonic.brands1@gmail.com', '316gotb2mutzdjmghprpgmxwq62i', 'Robin - Sonic Brands', true)
ON CONFLICT (id) DO NOTHING;

-- The account a new business starts on (the column default below).
CREATE OR REPLACE FUNCTION public.default_spotify_account()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM public.spotify_accounts WHERE is_default AND active LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.default_spotify_account() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.default_spotify_account() TO service_role;

-- Every existing business is on the one account.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS spotify_account_id text REFERENCES public.spotify_accounts(id);
UPDATE public.businesses SET spotify_account_id = 'robin-1' WHERE spotify_account_id IS NULL;
ALTER TABLE public.businesses
  ALTER COLUMN spotify_account_id SET DEFAULT public.default_spotify_account();

-- Every playlist so far was made on it too. Writers that don't say (Ami's test
-- playlists, the old versions) use the RUBIN_* account, so that's the default.
ALTER TABLE public.created_playlists
  ADD COLUMN IF NOT EXISTS spotify_account_id text DEFAULT 'robin-1' REFERENCES public.spotify_accounts(id);
UPDATE public.created_playlists SET spotify_account_id = 'robin-1' WHERE spotify_account_id IS NULL;
