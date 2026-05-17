-- Create app_state table for cross-browser data sync
-- Run this migration after setting up the main schema

create table if not exists public.app_state (
  user_id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- For demo purposes, disable RLS so data is accessible from any browser
-- In production, enable RLS and add proper security policies
alter table public.app_state disable row level security;

-- Create index for faster lookups
create index if not exists idx_app_state_user_id on public.app_state(user_id);

-- Set up realtime for this table
do $$
begin
  if not exists (
    select 1
    from pg_publication_rel pr
    join pg_publication p on p.oid = pr.prpubid
    join pg_class c on c.oid = pr.prrelid
    join pg_namespace n on n.oid = c.relnamespace
    where p.pubname = 'supabase_realtime'
      and n.nspname = 'public'
      and c.relname = 'app_state'
  ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end
$$;
