-- 0005_rls.sql — enable Row Level Security across the app. Run in the Supabase SQL editor. Re-runnable.
-- The worker uses the service_role key, which BYPASSES RLS, so every pipeline write keeps working.

-- 1) Shared/global data: readable by anyone, writable only by the worker (service_role).
do $$
declare t text;
begin
  foreach t in array array[
    'teams','players','fixtures','projections','news_sentiment',
    'gw_predictions','prediction_log','model_calibration'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_public_read', t);
    execute format('create policy %I on %I for select using (true)', t || '_public_read', t);
  end loop;
end $$;

-- 2) Personal data: each user reads/writes only their own rows. The shared "me" demo stays public-read
--    so logged-out visitors still see a populated app.
do $$
declare t text;
begin
  foreach t in array array['user_team_state','optimizer_runs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format(
      'create policy %I on %I for select using (user_id = ''me'' or user_id = auth.uid()::text)',
      t || '_read', t);
    execute format(
      'create policy %I on %I for insert with check (user_id = auth.uid()::text)',
      t || '_insert', t);
    execute format(
      'create policy %I on %I for update using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text)',
      t || '_update', t);
  end loop;
end $$;
