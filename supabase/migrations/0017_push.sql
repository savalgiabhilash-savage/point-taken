-- 0017_push.sql — push notifications (Settings → Notifications; worker/fpl_worker/notify.py sends them).
-- Run in the Supabase SQL editor. Re-runnable.

-- One row per device/browser that turned notifications on, with that user's choices.
create table if not exists push_subscriptions (
    id          bigint generated always as identity primary key,
    user_id     uuid not null references auth.users(id) on delete cascade,
    endpoint    text not null unique,
    p256dh      text not null,
    auth        text not null,
    deadline    boolean not null default true,   -- reminder before each deadline, with the plan
    injuries    boolean not null default true,   -- a player in the squad gets a new flag
    created_at  timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
drop policy if exists push_subs_own on push_subscriptions;
create policy push_subs_own on push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- What was already sent (or recorded as the starting state), so each alert goes out once.
-- Written by the worker with the service key only; no user policies.
create table if not exists push_log (
    user_id  uuid not null references auth.users(id) on delete cascade,
    kind     text not null,     -- 'deadline' | 'flag'
    ref      text not null,     -- e.g. 'gw12' or '<player>:<status>:<chance>'
    sent     boolean not null default true,  -- false = recorded as the starting state, not sent
    at       timestamptz not null default now(),
    primary key (user_id, kind, ref)
);
alter table push_log enable row level security;
