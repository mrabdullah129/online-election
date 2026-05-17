-- Patch for existing Supabase projects where voting fails with:
-- "function digest(text, unknown) does not exist"
-- "Invalid secret ID or vote already used"
--
-- Run this file in the Supabase SQL editor for an existing project.
-- Do not rerun supabase/schema.sql unless you are creating a fresh database.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.voter_registrations
  add column if not exists secret_code_ordinal integer;

with ranked_registrations as (
  select
    id,
    row_number() over (partition by election_id order by joined_at asc, id asc) as ordinal
  from public.voter_registrations
  where secret_code_suffix is not null
)
update public.voter_registrations registrations
   set secret_code_ordinal = ranked_registrations.ordinal
  from ranked_registrations
 where registrations.id = ranked_registrations.id
   and registrations.secret_code_ordinal is null;

create unique index if not exists registrations_secret_ordinal_idx
on public.voter_registrations (election_id, secret_code_ordinal)
where secret_code_ordinal is not null;

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
