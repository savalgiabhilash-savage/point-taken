-- Preseason form factor (2026 World Cup) — a small, bounded multiplier on a player's attacking
-- output, blended into the xPts model until the domestic season provides live data. Populated by a
-- one-off `python -m fpl_worker.form --run` (the tournament is complete); the model reads it each run.

create table if not exists preseason_form (
  player_id   int primary key,
  form_mult   numeric not null default 1.0,
  source      text,
  detail      jsonb,
  updated_at  timestamptz not null default now()
);

-- Public read (it's shared, non-personal data the web can surface for transparency); writes are
-- service-role only (the worker bypasses RLS).
alter table preseason_form enable row level security;
drop policy if exists preseason_form_read on preseason_form;
create policy preseason_form_read on preseason_form for select using (true);
