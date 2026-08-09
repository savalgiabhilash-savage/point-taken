-- 0004_profiles.sql — per-user profile mapping an auth user to their FPL entry ID.
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists profiles (
    id            uuid primary key references auth.users(id) on delete cascade,
    fpl_entry_id  integer,
    created_at    timestamptz default now(),
    updated_at    timestamptz default now()
);

alter table profiles enable row level security;

-- Each user can see and manage only their own profile row.
drop policy if exists profiles_select_own on profiles;
drop policy if exists profiles_insert_own on profiles;
drop policy if exists profiles_update_own on profiles;

create policy profiles_select_own on profiles for select using (auth.uid() = id);
create policy profiles_insert_own on profiles for insert with check (auth.uid() = id);
create policy profiles_update_own on profiles for update using (auth.uid() = id) with check (auth.uid() = id);
