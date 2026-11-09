-- 0012_repo_rename.sql — the GitHub repo was renamed fpl-selector -> point-taken (the app is now "Point Taken").
-- Run in the Supabase SQL editor. Re-runnable.
--
-- Same function as 0011, with the new repo name in the GitHub URL, so the pre-deadline run keeps starting.
-- The vault token (github_dispatch_token) still works: GitHub ties fine-grained tokens to the repo's id, not its name.

create or replace function public.dispatch_deadline_run() returns void
language plpgsql security definer set search_path = public as $$
declare
    due record;
    token text;
begin
    select gw, deadline into due from gw_deadlines
     where deadline between now() + interval '90 minutes' and now() + interval '110 minutes'
       and (dispatched_at is null or dispatched_at < deadline - interval '3 hours')
     order by deadline limit 1;
    if not found then
        return;
    end if;
    select decrypted_secret into token from vault.decrypted_secrets where name = 'github_dispatch_token';
    if token is null then
        raise warning 'github_dispatch_token is not in the vault; pre-deadline run for GW% not requested', due.gw;
        return;
    end if;
    perform net.http_post(
        url := 'https://api.github.com/repos/savalgiabhilash-savage/point-taken/actions/workflows/deadline.yml/dispatches',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || token,
            'Accept', 'application/vnd.github+json',
            'X-GitHub-Api-Version', '2022-11-28',
            'User-Agent', 'point-taken-supabase'),
        body := jsonb_build_object('ref', 'master'));
    update gw_deadlines set dispatched_at = now() where gw = due.gw;
end $$;

revoke all on function public.dispatch_deadline_run() from public, anon, authenticated;
