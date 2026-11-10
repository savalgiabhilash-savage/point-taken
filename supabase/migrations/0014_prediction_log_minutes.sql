-- 0014_prediction_log_minutes.sql — keep each player's expected minutes and appearance points in the
-- pre-deadline snapshot. The model deletes a gameweek's projections once its deadline passes, and the Live GW
-- panel uses these to project players who are on the pitch or on the bench during a game (web/lib/live.ts).
-- Run in the Supabase SQL editor. Re-runnable.

alter table prediction_log add column if not exists exp_minutes numeric;
alter table prediction_log add column if not exists x_app_pts numeric;
