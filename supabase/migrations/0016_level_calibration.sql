-- 0016_level_calibration.sql — calibration by prediction level (worker predict.py fits it, model.py applies it).
-- Run in the Supabase SQL editor. Re-runnable.
--
-- Live logs show the model under-predicts mid-range players (predicted ~0.4–2 pts, mostly rotation and
-- doubtful players) by ~0.3 pts each while its top predictions are on target; the per-position multiplier
-- can't see that (it only learns from predictions of 2+). One row per prediction-size bin.

create table if not exists calibration_levels (
    bin         integer primary key,
    lo          numeric not null,
    hi          numeric not null,
    pred_mean   numeric not null,   -- mean raw prediction in the bin (the interpolation point)
    multiplier  numeric not null,   -- shrunk actual ÷ predicted
    n           integer not null,
    updated_at  timestamptz default now()
);
alter table calibration_levels enable row level security;
drop policy if exists calibration_levels_read on calibration_levels;
create policy calibration_levels_read on calibration_levels for select using (true);

-- The multiplier applied to each logged prediction, so the next fit uses the raw prediction (no double correction).
alter table prediction_log add column if not exists level_mult numeric;
