-- 0015_ai_usage.sql — log each AI (Claude) feature use per account, for Settings → AI usage.
-- Run in the Supabase SQL editor. Re-runnable.
--
-- One row per feature use (an Assistant answer may take several Claude calls; `calls` counts them).
-- cost_usd is an estimate from the API's token counts × list prices (web/lib/ai-usage.ts).

create table if not exists ai_usage (
    id                  bigint generated always as identity primary key,
    user_id             uuid not null references auth.users(id) on delete cascade,
    feature             text not null,            -- 'assistant' | 'team_upload'
    model               text not null,
    calls               integer not null default 1,
    input_tokens        integer not null default 0,
    output_tokens       integer not null default 0,
    cache_write_tokens  integer not null default 0,
    cache_read_tokens   integer not null default 0,
    cost_usd            numeric not null default 0,
    created_at          timestamptz not null default now()
);
create index if not exists ai_usage_user_time on ai_usage (user_id, created_at desc);

alter table ai_usage enable row level security;
drop policy if exists ai_usage_select_own on ai_usage;
drop policy if exists ai_usage_insert_own on ai_usage;
create policy ai_usage_select_own on ai_usage for select using (auth.uid() = user_id);
create policy ai_usage_insert_own on ai_usage for insert with check (auth.uid() = user_id);
