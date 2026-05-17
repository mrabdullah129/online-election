-- Secure Online Election Management System
-- Run this file only once on a fresh Supabase project.
-- If your project already has these tables/types and voting needs a fix,
-- run supabase/fix-vote-rpc.sql instead.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.app_role as enum ('super_admin', 'creator', 'voter');
create type public.creator_request_status as enum ('pending', 'approved', 'rejected');
create type public.registration_status as enum ('registered', 'waitlisted', 'finalized', 'admin_override');
create type public.notification_status as enum ('queued', 'sent', 'failed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  phone text,
  role public.app_role not null default 'voter',
  organization text,
  creator_approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.creator_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references public.profiles(id) on delete set null,
  full_name text not null,
  email text not null,
  phone text not null,
  organization text not null,
  purpose text not null,
  status public.creator_request_status not null default 'pending',
  rejection_reason text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.elections (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null,
  category text not null,
  code_prefix text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  registration_deadline timestamptz not null,
  max_voters integer not null check (max_voters > 0),
  published boolean not null default false,
  locked boolean not null default false,
  finalized_voter_count integer not null default 0,
  result_locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  check (registration_deadline <= end_at)
);

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  name text not null,
  designation text not null,
  manifesto text not null,
  photo_url text,
  created_at timestamptz not null default now()
);

create table public.voter_registrations (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  accepted_terms boolean not null default false,
  status public.registration_status not null default 'registered',
  secret_code_hash text,
  secret_code_suffix text,
  secret_code_ordinal integer,
  voted boolean not null default false,
  voted_at timestamptz,
  override_by uuid references public.profiles(id) on delete set null,
  joined_at timestamptz not null default now(),
  unique (election_id, voter_id),
  unique (election_id, secret_code_hash)
);

create table public.anonymous_votes (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  secret_code_hash text not null,
  created_at timestamptz not null default now(),
  unique (election_id, secret_code_hash)
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_label text not null default 'System',
  action text not null,
  table_name text,
  record_id uuid,
  detail text not null,
  ip_address inet,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_email text not null,
  type text not null,
  subject text not null,
  body text,
  status public.notification_status not null default 'queued',
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index elections_public_idx on public.elections (published, start_at, end_at);
create index registrations_election_idx on public.voter_registrations (election_id, status);
create index votes_election_idx on public.anonymous_votes (election_id, candidate_id);
create index audit_created_idx on public.audit_logs (created_at desc);

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'super_admin'
  );
$$;

create or replace function public.is_creator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'creator'
      and creator_approved = true
  );
$$;

create or replace function public.log_action(
  p_action text,
  p_table_name text,
  p_record_id uuid,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := 'System';
begin
  select coalesce(full_name, email)
    into v_actor
    from public.profiles
   where id = auth.uid();

  insert into public.audit_logs(actor_id, actor_label, action, table_name, record_id, detail)
  values (auth.uid(), coalesce(v_actor, 'System'), p_action, p_table_name, p_record_id, p_detail);
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data ->> 'phone',
    'voter'
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.finalize_election(p_election_id uuid)
returns table(voter_id uuid, email text, secret_code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_election public.elections%rowtype;
  v_registration record;
  v_index integer := 0;
  v_secret text;
begin
  select * into v_election
    from public.elections
   where id = p_election_id
   for update;

  if not found then
    raise exception 'Election not found';
  end if;

  if v_election.locked then
    raise exception 'Election is already locked';
  end if;

  if v_election.creator_id <> auth.uid() and not public.is_super_admin() then
    raise exception 'Not allowed';
  end if;

  update public.elections
     set locked = true,
         finalized_voter_count = (
           select count(*) from public.voter_registrations
           where election_id = p_election_id and status = 'registered'
         ),
         updated_at = now()
   where id = p_election_id;

  for v_registration in
    select r.id, r.voter_id, p.email
     from public.voter_registrations r
     join public.profiles p on p.id = r.voter_id
    where r.election_id = p_election_id
       and r.status = 'registered'
     order by r.joined_at asc, r.id asc
  loop
    v_index := v_index + 1;
    v_secret := concat(
      v_election.code_prefix,
      '-',
      lpad(v_index::text, 4, '0'),
      '-',
      upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 4))
    );

    update public.voter_registrations
       set status = 'finalized',
           secret_code_hash = encode(extensions.digest(convert_to(upper(trim(v_secret)), 'UTF8'), 'sha256'), 'hex'),
           secret_code_suffix = right(v_secret, 4),
           secret_code_ordinal = v_index
     where id = v_registration.id;

    insert into public.notifications(recipient_email, type, subject, body)
    values (
      v_registration.email,
      'secret_id',
      concat('Your secure voter ID for ', v_election.title),
      concat('Use this secret voter ID during the election window: ', v_secret)
    );

    voter_id := v_registration.voter_id;
    email := v_registration.email;
    secret_code := v_secret;
    return next;
  end loop;

  perform public.log_action('finalization', 'elections', p_election_id, 'Finalized voter list and generated secret IDs.');
end;
$$;

create or replace function public.cast_vote(
  p_election_id uuid,
  p_candidate_id uuid,
  p_secret_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_election public.elections%rowtype;
  v_secret text := upper(trim(p_secret_code));
  v_secret_match text[];
  v_secret_ordinal integer;
  v_secret_suffix text;
  v_hash text := encode(extensions.digest(convert_to(upper(trim(p_secret_code)), 'UTF8'), 'sha256'), 'hex');
  v_registration_id uuid;
begin
  v_secret_match := regexp_match(v_secret, '^([A-Z0-9][A-Z0-9_-]*)-([0-9]{4})-([A-Z0-9]{4})$');
  if v_secret_match is not null then
    v_secret_ordinal := v_secret_match[2]::integer;
    v_secret_suffix := v_secret_match[3];
  end if;

  select * into v_election
    from public.elections
   where id = p_election_id
   for update;

  if not found or not v_election.published or not v_election.locked then
    raise exception 'Election is not open';
  end if;

  if now() < v_election.start_at or now() > v_election.end_at then
    raise exception 'Outside voting window';
  end if;

  if not exists (
    select 1 from public.candidates
     where id = p_candidate_id and election_id = p_election_id
  ) then
    raise exception 'Candidate does not belong to this election';
  end if;

  select id into v_registration_id
    from public.voter_registrations
   where election_id = p_election_id
     and voter_id = auth.uid()
     and (
       secret_code_hash = v_hash
       or (
         v_secret_ordinal is not null
         and secret_code_ordinal = v_secret_ordinal
         and upper(secret_code_suffix) = v_secret_suffix
         and v_secret like upper(v_election.code_prefix) || '-%'
       )
     )
     and status in ('finalized', 'admin_override')
     and voted = false
   for update;

  if not found then
    raise exception 'Invalid secret ID or vote already used';
  end if;

  insert into public.anonymous_votes(election_id, candidate_id, secret_code_hash)
  values (p_election_id, p_candidate_id, v_hash);

  update public.voter_registrations
     set voted = true,
         voted_at = now(),
         secret_code_hash = v_hash
   where id = v_registration_id;

  insert into public.audit_logs(actor_label, action, table_name, record_id, detail)
  values ('Anonymous voter', 'vote', 'elections', p_election_id, 'Anonymous ballot recorded.');

  return true;
end;
$$;

create or replace view public.public_election_results as
select
  e.id as election_id,
  e.title,
  e.category,
  e.start_at,
  e.end_at,
  e.published,
  e.locked,
  e.result_locked,
  c.id as candidate_id,
  c.name as candidate_name,
  c.designation,
  c.photo_url,
  count(v.id)::integer as vote_count
from public.elections e
join public.candidates c on c.election_id = e.id
left join public.anonymous_votes v on v.candidate_id = c.id
where e.published = true
group by e.id, c.id;

alter table public.profiles enable row level security;
alter table public.creator_requests enable row level security;
alter table public.elections enable row level security;
alter table public.candidates enable row level security;
alter table public.voter_registrations enable row level security;
alter table public.anonymous_votes enable row level security;
alter table public.audit_logs enable row level security;
alter table public.notifications enable row level security;

create policy "profiles read self or admin"
on public.profiles for select
using (id = auth.uid() or public.is_super_admin());

create policy "profiles update self basic fields"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

create policy "profiles admin update"
on public.profiles for update
using (public.is_super_admin())
with check (public.is_super_admin());

create policy "creator requests insert authenticated"
on public.creator_requests for insert
with check (auth.uid() is not null);

create policy "creator requests read owner or admin"
on public.creator_requests for select
using (public.is_super_admin() or requester_id = auth.uid() or email = (select email from public.profiles where id = auth.uid()));

create policy "creator requests admin update"
on public.creator_requests for update
using (public.is_super_admin())
with check (public.is_super_admin());

create policy "elections public read published"
on public.elections for select
using (published = true or creator_id = auth.uid() or public.is_super_admin());

create policy "elections creator insert"
on public.elections for insert
with check (creator_id = auth.uid() and public.is_creator());

create policy "elections creator update before result lock"
on public.elections for update
using ((creator_id = auth.uid() and result_locked = false) or public.is_super_admin())
with check ((creator_id = auth.uid() and result_locked = false) or public.is_super_admin());

create policy "candidates public read"
on public.candidates for select
using (
  exists (
    select 1 from public.elections e
     where e.id = candidates.election_id
       and (e.published = true or e.creator_id = auth.uid() or public.is_super_admin())
  )
);

create policy "candidates creator manage drafts"
on public.candidates for all
using (
  exists (
    select 1 from public.elections e
     where e.id = candidates.election_id
       and e.creator_id = auth.uid()
       and e.published = false
  )
  or public.is_super_admin()
)
with check (
  exists (
    select 1 from public.elections e
     where e.id = candidates.election_id
       and e.creator_id = auth.uid()
       and e.published = false
  )
  or public.is_super_admin()
);

create policy "registrations read own creator admin"
on public.voter_registrations for select
using (
  voter_id = auth.uid()
  or public.is_super_admin()
  or exists (
    select 1 from public.elections e
     where e.id = voter_registrations.election_id
       and e.creator_id = auth.uid()
  )
);

create policy "registrations voter join"
on public.voter_registrations for insert
with check (
  voter_id = auth.uid()
  and accepted_terms = true
  and exists (
    select 1 from public.elections e
     where e.id = election_id
       and e.published = true
       and e.locked = false
       and now() <= e.registration_deadline
       and (
         select count(*) from public.voter_registrations r
          where r.election_id = e.id and r.status = 'registered'
       ) < e.max_voters
  )
);

create policy "registrations admin update"
on public.voter_registrations for update
using (public.is_super_admin())
with check (public.is_super_admin());

create policy "votes no direct read"
on public.anonymous_votes for select
using (false);

create policy "audit admin read"
on public.audit_logs for select
using (public.is_super_admin());

create policy "notifications admin read"
on public.notifications for select
using (public.is_super_admin());

create policy "notifications own read"
on public.notifications for select
using (recipient_email = (select email from public.profiles where id = auth.uid()));
