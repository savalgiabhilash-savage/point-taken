-- Phase 3: store the full, transparent xPts component breakdown on each projection.
-- The big-5 component columns already exist from 0001; these add the remaining pieces plus a
-- flexible jsonb blob for the underlying inputs (xg90, xa90, p_cs, fixture_adj, opponent, ...).
alter table projections add column if not exists x_appearance_pts numeric;
alter table projections add column if not exists x_saves_pts numeric;
alter table projections add column if not exists x_deductions_pts numeric;
alter table projections add column if not exists components jsonb;
