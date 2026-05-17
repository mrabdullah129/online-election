-- Create app_state table for cross-browser data sync
-- Run this migration after setting up the main schema

create table if not exists public.app_state (
  user_id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- Enable RLS if you want per-user access control
alter table public.app_state enable row level security;

-- Create RLS policy: users can only see their own state
create policy "Users can manage their own app state"
  on public.app_state
  as permissive
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- Create index for faster lookups
create index if not exists idx_app_state_user_id on public.app_state(user_id);

-- Set up realtime for this table
alter publication supabase_realtime add table public.app_state;
