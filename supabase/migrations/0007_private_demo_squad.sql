-- 0007_private_demo_squad.sql — stop exposing the owner's squad ("me") to anonymous readers.
-- Run in the Supabase SQL editor. Re-runnable.
--
-- 0005 let anyone read user_team_state / optimizer_runs rows where user_id = 'me' so logged-out visitors
-- saw a demo. The web app now asks logged-out visitors to log in instead, so personal rows become
-- own-rows only. The worker (service role) still writes 'me' and is unaffected.
-- NOTE: the Expo app's My Team tab reads 'me' without signing in; it shows nothing after this until the
-- app gets sign-in.

do $$
declare t text;
begin
  foreach t in array array['user_team_state','optimizer_runs'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format(
      'create policy %I on %I for select using (user_id = auth.uid()::text)',
      t || '_read', t);
  end loop;
end $$;
