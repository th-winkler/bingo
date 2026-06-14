-- Optional helper RPC for host-side lobby renaming.
-- Run this in Supabase SQL Editor if the app reports that update_lobby_name is missing
-- and direct lobbies.update is blocked by your RLS policies.

create or replace function public.update_lobby_name(
  p_lobby_code text,
  p_host_token text,
  p_name text
)
returns table(id uuid, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby record;
  v_name text;
begin
  v_name := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 80);

  if v_name = '' then
    raise exception 'El nombre de la sala no puede estar vacío.';
  end if;

  select l.id, l.active_draw_id
    into v_lobby
    from public.lobbies l
   where l.lobby_code = upper(btrim(p_lobby_code))
   limit 1;

  if not found then
    raise exception 'Sala no encontrada.';
  end if;

  -- Reuse your existing host-token validation path.
  perform public.renew_host_lock(v_lobby.active_draw_id, p_host_token);

  return query
    update public.lobbies l
       set name = v_name
     where l.id = v_lobby.id
     returning l.id, l.name;
end;
$$;

grant execute on function public.update_lobby_name(text, text, text) to anon, authenticated;
