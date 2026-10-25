-- 0011_deadline_dispatch.sql — start the pre-deadline run on time, from Supabase instead of GitHub's schedule.
-- Run in the Supabase SQL editor. Re-runnable.
--
-- GitHub's scheduled runs can start hours late (GW8's fired 2 h after the deadline). A request to start a run
-- (workflow_dispatch) starts within a minute, so a database timer (pg_cron) checks every 5 minutes and, about
-- 100 minutes before each gameweek deadline, asks GitHub to start .github/workflows/deadline.yml (pg_net).
-- The worker keeps gw_deadlines current on every refresh, so moved deadlines are picked up automatically.
--
-- ONE-OFF, NOT IN THIS FILE: store your GitHub token in Supabase's encrypted vault (you paste it yourself):
--   select vault.create_secret('<your token>', 'github_dispatch_token');
-- The token needs "Actions: Read and write" on the fpl-selector repository only (fine-grained token).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every gameweek's deadline (written by the worker) and when its pre-deadline run was requested.
create table if not exists gw_deadlines (
    gw             integer primary key,
    deadline       timestamptz not null,
    dispatched_at  timestamptz
);
alter table gw_deadlines enable row level security;
drop policy if exists gw_deadlines_read on gw_deadlines;
create policy gw_deadlines_read on gw_deadlines for select using (true);  -- shown on the Accuracy tab

-- If a deadline is 90-110 minutes away and its run hasn't been requested yet, request it (once per GW;
-- again only if FPL moves the deadline by 3+ hours after the request).
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
        url := 'https://api.github.com/repos/savalgiabhilash-savage/fpl-selector/actions/workflows/deadline.yml/dispatches',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || token,
            'Accept', 'application/vnd.github+json',
            'X-GitHub-Api-Version', '2022-11-28',
            'User-Agent', 'fpl-selector-supabase'),
        body := jsonb_build_object('ref', 'master'));
    update gw_deadlines set dispatched_at = now() where gw = due.gw;
end $$;

revoke all on function public.dispatch_deadline_run() from public, anon, authenticated;

-- The timer: every 5 minutes (replaces any earlier copy of this job).
select cron.unschedule(jobid) from cron.job where jobname = 'fpl-deadline-dispatch';
select cron.schedule('fpl-deadline-dispatch', '*/5 * * * *', 'select public.dispatch_deadline_run()');
