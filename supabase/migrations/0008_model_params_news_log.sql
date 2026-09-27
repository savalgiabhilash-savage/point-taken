-- 0008_model_params_news_log.sql — learned model parameters + the log that learns the news weight.
-- Run in the Supabase SQL editor. Re-runnable. Until it runs, the worker uses defaults (news weight 1.0)
-- and skips the logging, so nothing breaks.

-- Parameters the worker learns from outcomes and reads back each run (e.g. news_weight).
create table if not exists model_params (
    key         text primary key,
    value       numeric not null,
    n           integer,                  -- observations the value was learned from
    note        text,
    updated_at  timestamptz default now()
);

-- Every player whose projection was changed by news, snapshotted before the deadline, then scored with
-- whether he actually started. predict.py refits news_weight from this each run.
create table if not exists news_effect_log (
    gw          integer not null,
    player_id   integer not null,
    start_rate  numeric,                  -- minutes-model start rate (form only)
    fpl_avail   numeric,                  -- availability from FPL's flag alone
    news_adj    numeric,                  -- effective news effect (topic- and age-weighted), <= 0
    started     boolean,
    scored      boolean not null default false,
    primary key (gw, player_id)
);

alter table model_params enable row level security;
alter table news_effect_log enable row level security;
drop policy if exists model_params_read on model_params;
create policy model_params_read on model_params for select using (true);
drop policy if exists news_effect_log_read on news_effect_log;
create policy news_effect_log_read on news_effect_log for select using (true);
