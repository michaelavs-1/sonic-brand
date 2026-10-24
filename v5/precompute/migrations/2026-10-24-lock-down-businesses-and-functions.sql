-- 2026-10-24: close two doors a client could open with the public Supabase key
-- (found in the pre-pilot DevTools audit). Idempotent; safe to re-run.

-- 1. businesses
--    The table's only policy, own_business, is FOR ALL USING / WITH CHECK
--    (owner_id = auth.uid()), and anon / authenticated held every table
--    privilege. So a logged-in owner could edit any column of their own row
--    straight through the REST API (clear subscription_ends_at after
--    cancelling and keep getting playlists, set paid_at or version), insert
--    extra businesses, or delete theirs.
--    The browser only ever writes onboarding_expanded
--    (markOnboardingExpanded in v7/account/app.js, same in v6). Everything
--    else goes through server endpoints on the service key, which this
--    doesn't touch.
revoke insert, update, delete, truncate, references, trigger on public.businesses from anon, authenticated;
grant update (onboarding_expanded) on public.businesses to authenticated;

-- 2. Functions only our servers call (all with the service key)
--    Postgres lets PUBLIC execute every function by default, so anyone with
--    the public key could run the heavy playlist-pool functions directly,
--    past our rate limits. The scan-control functions can't write as anon
--    (RLS), but nothing outside the servers needs them either.
--    Left public on purpose: v7_anchor_tracks (swipe deck, anon key),
--    v5_anchor_tracks / v5_direction_tracks / cached_playlist / cached_preview
--    (endpoints that call them with the anon key), hit_popularity_floor
--    (called inside functions that run as anon), consume_credit (checks the
--    owner itself), and the trigger functions.
--    CREATE OR REPLACE keeps these grants; a DROP + CREATE resets them, so
--    re-run this block after recreating one of these functions that way.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        'v7_timeline_pool', 'v7_track_genres', 'v6_direction_tracks_recent',
        'acquire_scan_job_lock', 'increment_rapidapi_usage', 'sync_rapidapi_usage',
        'pause_active_scan_jobs', 'stop_active_scan_jobs', 'revive_stopped_scan_jobs',
        'set_batch_active', 'reorder_scan_jobs', 'toggle_scan_job_skip',
        'toggle_all_scan_jobs_skip', 'rename_biztype', 'rename_genre_globally'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Check: expect owner_can_update_other_columns = false,
-- owner_can_update_onboarding_expanded = true, and 15 / 0 / 15 functions.
select
  has_table_privilege('authenticated', 'public.businesses', 'update')                              as owner_can_update_other_columns,
  has_column_privilege('authenticated', 'public.businesses', 'onboarding_expanded', 'update')     as owner_can_update_onboarding_expanded,
  has_table_privilege('authenticated', 'public.businesses', 'insert')                              as owner_can_insert,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('v7_timeline_pool','v7_track_genres','v6_direction_tracks_recent','acquire_scan_job_lock',
       'increment_rapidapi_usage','sync_rapidapi_usage','pause_active_scan_jobs','stop_active_scan_jobs',
       'revive_stopped_scan_jobs','set_batch_active','reorder_scan_jobs','toggle_scan_job_skip',
       'toggle_all_scan_jobs_skip','rename_biztype','rename_genre_globally'))                     as functions_locked,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('v7_timeline_pool','v7_track_genres','v6_direction_tracks_recent','acquire_scan_job_lock',
       'increment_rapidapi_usage','sync_rapidapi_usage','pause_active_scan_jobs','stop_active_scan_jobs',
       'revive_stopped_scan_jobs','set_batch_active','reorder_scan_jobs','toggle_scan_job_skip',
       'toggle_all_scan_jobs_skip','rename_biztype','rename_genre_globally')
     and has_function_privilege('anon', p.oid, 'execute'))                                        as still_public,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('v7_timeline_pool','v7_track_genres','v6_direction_tracks_recent','acquire_scan_job_lock',
       'increment_rapidapi_usage','sync_rapidapi_usage','pause_active_scan_jobs','stop_active_scan_jobs',
       'revive_stopped_scan_jobs','set_batch_active','reorder_scan_jobs','toggle_scan_job_skip',
       'toggle_all_scan_jobs_skip','rename_biztype','rename_genre_globally')
     and has_function_privilege('service_role', p.oid, 'execute'))                                as server_can_run;
