-- 0003_predictions.sql — Best-XI predictions, per-player prediction log, and model calibration.
-- Run this in the Supabase SQL editor (Run without RLS, like the earlier migrations).

-- The optimal XI we predicted for each gameweek (one row per gw + variant), scored after it finishes.
create table if not exists gw_predictions (
    id            bigint generated always as identity primary key,
    gw            integer not null,
    variant       text not null,              -- 'capped' (£100m) | 'uncapped' (no budget)
    squad         jsonb not null,             -- the 15 with predicted xp, is_start, is_captain
    predicted_pts numeric,                    -- predicted XI total (incl. captain doubling)
    actual_pts    numeric,                    -- actual XI total once the gameweek finishes
    scored        boolean not null default false,
    created_at    timestamptz default now(),
    scored_at     timestamptz,
    unique (gw, variant)
);

-- Per-player prediction snapshot for a gameweek — the raw material for per-position accuracy.
create table if not exists prediction_log (
    gw            integer not null,
    player_id     integer not null,
    position      text,
    predicted_xp  numeric,
    actual_pts    numeric,
    minutes       integer,
    scored        boolean not null default false,
    updated_at    timestamptz default now(),
    primary key (gw, player_id)
);

-- Per-position calibration multiplier learned from scored gameweeks; applied to future projections.
create table if not exists model_calibration (
    position      text primary key,           -- GK/DEF/MID/FWD
    n_gws         integer not null default 0,
    sum_pred      numeric not null default 0,
    sum_actual    numeric not null default 0,
    multiplier    numeric not null default 1.0,
    updated_at    timestamptz default now()
);
