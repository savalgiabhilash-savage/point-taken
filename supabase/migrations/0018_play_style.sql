-- 0018_play_style.sql — each user's play style: risk profile (Safe / Balanced / Bold) and goal, set by the
-- 5-question quiz (Settings, or the card on My Team) or the Optimizer's switch. The optimizer reads
-- profiles.risk (worker/fpl_worker/risk.py). Run in the Supabase SQL editor. Safe to re-run.
-- Existing RLS on profiles (0004) already limits each user to their own row.

alter table profiles add column if not exists risk text default 'balanced';
alter table profiles add column if not exists goal text;
alter table profiles add column if not exists quiz_done_at timestamptz;

alter table profiles drop constraint if exists profiles_risk_check;
alter table profiles add constraint profiles_risk_check check (risk in ('safe', 'balanced', 'bold'));
alter table profiles drop constraint if exists profiles_goal_check;
alter table profiles add constraint profiles_goal_check
    check (goal is null or goal in ('this_gw', 'long_term', 'mini_league', 'rank', 'chips'));
