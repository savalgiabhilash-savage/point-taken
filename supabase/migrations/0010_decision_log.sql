-- 0010_decision_log.sql — keep what the app recommended at each deadline, and FPL's own expected points.
-- Run in the Supabase SQL editor. Re-runnable. Until it runs, the worker skips both quietly.

-- The optimizer's last pre-deadline plan per user and GW (optimizer_runs only keeps the latest run, so
-- the GW6 wildcard suggestion couldn't be audited). Replaced on every run until the deadline, then frozen.
create table if not exists decision_log (
    user_id     text not null,
    gw          integer not null,
    run         jsonb not null,           -- squad, transfers, captain, chip advice, horizon, expected gain
    updated_at  timestamptz default now(),
    primary key (user_id, gw)
);
alter table decision_log enable row level security;
drop policy if exists decision_log_read on decision_log;
create policy decision_log_read on decision_log for select using (user_id = auth.uid()::text);

-- FPL's own expected points (bootstrap ep_next) for the same GW, snapshotted with our prediction as a
-- possible future model input (not a benchmark: accuracy is measured against actual points).
alter table prediction_log add column if not exists fpl_ep numeric;
