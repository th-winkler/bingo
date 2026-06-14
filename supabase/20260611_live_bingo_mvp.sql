create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.lobbies (
  id uuid primary key default gen_random_uuid(),
  lobby_code text not null unique,
  name text not null,
  host_password_hash text not null,
  active_draw_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.draws (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid not null references public.lobbies(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'closed', 'cancelled')),
  current_count integer not null default 0 check (current_count between 0 and 75),
  last_number integer check (last_number between 1 and 75),
  host_token_hash text,
  lock_holder text,
  lock_claimed_at timestamptz,
  lock_expires_at timestamptz,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

alter table public.lobbies
  drop constraint if exists lobbies_active_draw_id_fkey;

alter table public.lobbies
  add constraint lobbies_active_draw_id_fkey
  foreign key (active_draw_id) references public.draws(id) on delete set null;

create table if not exists public.draw_events (
  id bigserial primary key,
  draw_id uuid not null references public.draws(id) on delete cascade,
  event_index integer not null check (event_index between 1 and 75),
  number integer not null check (number between 1 and 75),
  operator_name text,
  created_at timestamptz not null default clock_timestamp(),
  unique (draw_id, event_index),
  unique (draw_id, number)
);

create table if not exists public.draw_closures (
  id bigserial primary key,
  draw_id uuid not null references public.draws(id) on delete cascade unique,
  closed_by text,
  closed_at timestamptz not null default now(),
  final_count integer not null,
  final_numbers jsonb not null
);

create unique index if not exists draws_one_active_per_lobby
  on public.draws(lobby_id)
  where status = 'active';

create index if not exists draw_events_draw_order_idx
  on public.draw_events(draw_id, event_index);

alter table public.draw_events
  alter column created_at set default clock_timestamp();

alter table public.lobbies enable row level security;
alter table public.draws enable row level security;
alter table public.draw_events enable row level security;
alter table public.draw_closures enable row level security;

revoke all on public.lobbies from anon, authenticated;
revoke all on public.draws from anon, authenticated;
revoke all on public.draw_events from anon, authenticated;
revoke all on public.draw_closures from anon, authenticated;

grant select on public.lobbies to anon, authenticated;
grant select on public.draws to anon, authenticated;
grant select on public.draw_events to anon, authenticated;
grant select on public.draw_closures to anon, authenticated;
grant usage, select on sequence public.draw_events_id_seq to anon, authenticated;
grant usage, select on sequence public.draw_closures_id_seq to anon, authenticated;

drop policy if exists "public can read lobbies" on public.lobbies;
create policy "public can read lobbies"
  on public.lobbies for select
  to anon, authenticated
  using (true);

drop policy if exists "public can read draws" on public.draws;
create policy "public can read draws"
  on public.draws for select
  to anon, authenticated
  using (true);

drop policy if exists "public can read draw events" on public.draw_events;
create policy "public can read draw events"
  on public.draw_events for select
  to anon, authenticated
  using (true);

drop policy if exists "public can read draw closures" on public.draw_closures;
create policy "public can read draw closures"
  on public.draw_closures for select
  to anon, authenticated
  using (true);

create or replace function public._random_lobby_code()
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := '';
  i integer;
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;
  return code;
end;
$$;

create or replace function public._new_host_token()
returns text
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select encode(gen_random_bytes(32), 'base64');
$$;

create or replace function public._token_matches(p_token text, p_hash text)
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select p_token is not null
     and p_hash is not null
     and crypt(p_token, p_hash) = p_hash;
$$;

create or replace function public.create_lobby(p_name text, p_host_password text)
returns table(lobby_code text, lobby_id uuid, draw_id uuid, host_token text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_code text;
  v_lobby_id uuid;
  v_draw_id uuid;
  v_token text;
  attempts integer := 0;
begin
  if nullif(trim(p_name), '') is null then
    raise exception 'Lobby name is required';
  end if;
  if length(coalesce(p_host_password, '')) < 4 then
    raise exception 'Host password must contain at least 4 characters';
  end if;

  loop
    attempts := attempts + 1;
    v_code := public._random_lobby_code();
    begin
      insert into public.lobbies(lobby_code, name, host_password_hash)
      values (v_code, trim(p_name), crypt(p_host_password, gen_salt('bf')))
      returning id into v_lobby_id;
      exit;
    exception when unique_violation then
      if attempts >= 8 then
        raise exception 'Could not allocate a lobby code';
      end if;
    end;
  end loop;

  v_token := public._new_host_token();

  insert into public.draws(lobby_id, host_token_hash, lock_holder, lock_claimed_at, lock_expires_at)
  values (v_lobby_id, crypt(v_token, gen_salt('bf')), 'host', now(), now() + interval '60 seconds')
  returning id into v_draw_id;

  update public.lobbies set active_draw_id = v_draw_id where id = v_lobby_id;

  lobby_code := v_code;
  lobby_id := v_lobby_id;
  draw_id := v_draw_id;
  host_token := v_token;
  return next;
end;
$$;

create or replace function public.claim_host(p_lobby_code text, p_host_password text, p_lock_holder text default 'host')
returns table(lobby_id uuid, draw_id uuid, host_token text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_lobby public.lobbies%rowtype;
  v_draw public.draws%rowtype;
  v_token text;
begin
  select * into v_lobby
  from public.lobbies
  where upper(lobby_code) = upper(trim(p_lobby_code))
  for update;

  if not found or crypt(coalesce(p_host_password, ''), v_lobby.host_password_hash) <> v_lobby.host_password_hash then
    raise exception 'Invalid lobby code or host password';
  end if;

  select * into v_draw
  from public.draws
  where id = v_lobby.active_draw_id and status = 'active'
  for update;

  if not found then
    raise exception 'No active draw for lobby';
  end if;

  v_token := public._new_host_token();

  update public.draws
  set host_token_hash = crypt(v_token, gen_salt('bf')),
      lock_holder = nullif(trim(coalesce(p_lock_holder, 'host')), ''),
      lock_claimed_at = now(),
      lock_expires_at = now() + interval '60 seconds'
  where id = v_draw.id;

  lobby_id := v_lobby.id;
  draw_id := v_draw.id;
  host_token := v_token;
  return next;
end;
$$;

create or replace function public.renew_host_lock(p_draw_id uuid, p_host_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  select host_token_hash into v_hash
  from public.draws
  where id = p_draw_id and status = 'active';

  if not found or not public._token_matches(p_host_token, v_hash) then
    raise exception 'Invalid host token';
  end if;

  -- Do not update lock timestamps on a timer. The previous implementation wrote to
  -- public.draws every renewal, which triggered Realtime reloads and replayed UI
  -- animations while the app was idle.
  return true;
end;
$$;

create or replace function public.draw_next_number(p_draw_id uuid, p_host_token text)
returns table(number integer, event_index integer)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_draw public.draws%rowtype;
  v_number integer;
  v_next_index integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_draw_id::text, 0));

  select * into v_draw
  from public.draws
  where id = p_draw_id
  for update;

  if not found or v_draw.status <> 'active' then
    raise exception 'Draw is not active';
  end if;
  if not public._token_matches(p_host_token, v_draw.host_token_hash) then
    raise exception 'Invalid host token';
  end if;
  if v_draw.current_count >= 75 then
    raise exception 'All numbers have been drawn';
  end if;

  select n into v_number
  from generate_series(1, 75) as n
  where not exists (
    select 1 from public.draw_events e
    where e.draw_id = p_draw_id and e.number = n
  )
  order by random()
  limit 1;

  if v_number is null then
    raise exception 'All numbers have been drawn';
  end if;

  v_next_index := v_draw.current_count + 1;

  insert into public.draw_events(draw_id, event_index, number, operator_name)
  values (p_draw_id, v_next_index, v_number, v_draw.lock_holder);

  update public.draws
  set current_count = v_next_index,
      last_number = v_number,
      lock_expires_at = now() + interval '60 seconds'
  where id = p_draw_id;

  number := v_number;
  event_index := v_next_index;
  return next;
end;
$$;

create or replace function public.close_draw_and_create_new(p_lobby_id uuid, p_draw_id uuid, p_host_token text)
returns table(lobby_id uuid, old_draw_id uuid, new_draw_id uuid, host_token text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_draw public.draws%rowtype;
  v_numbers jsonb;
  v_count integer;
  v_new_draw_id uuid;
  v_new_token text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_lobby_id::text, 0));

  select * into v_draw
  from public.draws d
  where d.id = p_draw_id and d.lobby_id = p_lobby_id
  for update;

  if not found or v_draw.status <> 'active' then
    raise exception 'Draw is not active';
  end if;
  if not public._token_matches(p_host_token, v_draw.host_token_hash) then
    raise exception 'Invalid host token';
  end if;

  select coalesce(jsonb_agg(e.number order by e.event_index), '[]'::jsonb), count(*)::integer
  into v_numbers, v_count
  from public.draw_events e
  where e.draw_id = p_draw_id;

  update public.draws d
  set status = 'closed',
      closed_at = now(),
      host_token_hash = null,
      lock_holder = null,
      lock_claimed_at = null,
      lock_expires_at = null
  where d.id = p_draw_id and d.status = 'active';

  insert into public.draw_closures(draw_id, closed_by, final_count, final_numbers)
  values (p_draw_id, v_draw.lock_holder, v_count, v_numbers);

  v_new_token := public._new_host_token();

  insert into public.draws(lobby_id, host_token_hash, lock_holder, lock_claimed_at, lock_expires_at)
  values (p_lobby_id, crypt(v_new_token, gen_salt('bf')), v_draw.lock_holder, now(), now() + interval '60 seconds')
  returning id into v_new_draw_id;

  update public.lobbies
  set active_draw_id = v_new_draw_id
  where id = p_lobby_id;

  close_draw_and_create_new.lobby_id := p_lobby_id;
  close_draw_and_create_new.old_draw_id := p_draw_id;
  close_draw_and_create_new.new_draw_id := v_new_draw_id;
  close_draw_and_create_new.host_token := v_new_token;
  return next;
end;
$$;

create or replace function public.get_lobby_state(p_lobby_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_lobby public.lobbies%rowtype;
  v_draw public.draws%rowtype;
  v_events jsonb;
  v_last3 jsonb;
begin
  select * into v_lobby
  from public.lobbies
  where upper(lobby_code) = upper(trim(p_lobby_code));

  if not found then
    raise exception 'Lobby not found';
  end if;

  select * into v_draw
  from public.draws
  where id = v_lobby.active_draw_id;

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', e.id,
      'draw_id', e.draw_id,
      'event_index', e.event_index,
      'number', e.number,
      'operator_name', e.operator_name,
      'created_at', e.created_at
    ) order by e.event_index),
    '[]'::jsonb
  ) into v_events
  from public.draw_events e
  where e.draw_id = v_draw.id;

  select coalesce(jsonb_agg(item order by (item->>'event_index')::integer desc), '[]'::jsonb)
  into v_last3
  from (
    select jsonb_build_object('event_index', e.event_index, 'number', e.number, 'created_at', e.created_at) item
    from public.draw_events e
    where e.draw_id = v_draw.id
    order by e.event_index desc
    limit 3
  ) s;

  return jsonb_build_object(
    'lobby', jsonb_build_object(
      'id', v_lobby.id,
      'lobby_code', v_lobby.lobby_code,
      'name', v_lobby.name,
      'active_draw_id', v_lobby.active_draw_id,
      'created_at', v_lobby.created_at
    ),
    'draw', jsonb_build_object(
      'id', v_draw.id,
      'lobby_id', v_draw.lobby_id,
      'status', v_draw.status,
      'current_count', v_draw.current_count,
      'last_number', v_draw.last_number,
      'lock_holder', v_draw.lock_holder,
      'lock_claimed_at', v_draw.lock_claimed_at,
      'lock_expires_at', v_draw.lock_expires_at,
      'created_at', v_draw.created_at,
      'closed_at', v_draw.closed_at
    ),
    'events', v_events,
    'current_number', v_draw.last_number,
    'last3', v_last3,
    'status', v_draw.status
  );
end;
$$;

grant execute on function public.create_lobby(text, text) to anon, authenticated;
grant execute on function public.claim_host(text, text, text) to anon, authenticated;
grant execute on function public.renew_host_lock(uuid, text) to anon, authenticated;
grant execute on function public.draw_next_number(uuid, text) to anon, authenticated;
grant execute on function public.close_draw_and_create_new(uuid, uuid, text) to anon, authenticated;
grant execute on function public.get_lobby_state(text) to anon, authenticated;

-- Realtime publication: required by Supabase Realtime Postgres Changes.
do $$
begin
  begin
    alter publication supabase_realtime add table public.draw_events;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.draws;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.lobbies;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.draw_closures;
  exception when duplicate_object then null;
  end;
end $$;
