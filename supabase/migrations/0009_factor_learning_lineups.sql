-- 0009_factor_learning_lineups.sql — live-learned factors (penalties, set pieces, return from injury,
-- predicted line-ups) and the news-derived team context they read. Run in the Supabase SQL editor after
-- 0008. Re-runnable. Until it runs, those factors use their default weights and logging is skipped.

-- Every player a live-only factor touched, snapshotted before the deadline and scored afterwards.
-- predict.py refits each factor's weight (model_params, key "<factor>_weight") from this.
create table if not exists factor_effect_log (
    gw          integer not null,
    player_id   integer not null,
    factor      text not null,            -- penalty | setpiece | return | lineup
    base        numeric,                  -- the prediction without the factor (goals, assists or P(start))
    term        numeric,                  -- what the factor adds at weight 1
    actual      numeric,                  -- what happened (goals, assists, or 1/0 started)
    scored      boolean not null default false,
    primary key (gw, player_id, factor)
);

-- Predicted starting XIs read from news before each deadline (lineups.py).
create table if not exists predicted_lineups (
    gw           integer not null,
    team_id      integer not null,
    player_id    integer not null,
    predicted    boolean not null,        -- true = named in the predicted XI
    confidence   numeric,                 -- Claude's confidence in the article's line-up (0..1)
    source       text,
    url          text,
    published_at timestamptz,
    primary key (gw, team_id, player_id)
);

-- Managerial changes detected from news (lineups.py): older games count less after a change.
create table if not exists team_context (
    team_id            integer primary key,
    manager_changed_at date,
    manager            text,
    summary            text,
    source             text,
    url                text,
    updated_at         timestamptz default now()
);

alter table factor_effect_log enable row level security;
alter table predicted_lineups enable row level security;
alter table team_context enable row level security;
drop policy if exists factor_effect_log_read on factor_effect_log;
create policy factor_effect_log_read on factor_effect_log for select using (true);
drop policy if exists predicted_lineups_read on predicted_lineups;
create policy predicted_lineups_read on predicted_lineups for select using (true);
drop policy if exists team_context_read on team_context;
create policy team_context_read on team_context for select using (true);
