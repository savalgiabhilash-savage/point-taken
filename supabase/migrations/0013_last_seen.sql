-- 0013_last_seen.sql — record when each user last used the site, so scheduled runs only sync and
-- re-optimize recently active users (worker/fpl_worker/active_users.py, 7 days).
-- Run in the Supabase SQL editor. Re-runnable.
--
-- The site sets it (at most once per 6 hours per signed-in user) through the existing "update own profile"
-- RLS policy, so no new policy is needed. Existing users start as "seen now", so nobody drops out on day one.

alter table profiles add column if not exists last_seen_at timestamptz default now();
update profiles set last_seen_at = now() where last_seen_at is null;
