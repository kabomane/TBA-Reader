create table if not exists public.tba_public_storage (
  id boolean primary key default true check (id),
  r2_ready boolean not null default false,
  r2_public_url text
);

insert into public.tba_public_storage (id, r2_ready, r2_public_url)
select true, r2_ready, r2_public_url
from public.tba_settings
where id = true
on conflict (id) do update
set r2_ready = excluded.r2_ready,
    r2_public_url = excluded.r2_public_url;

alter table public.tba_public_storage enable row level security;

drop policy if exists "Public can read TBA storage config" on public.tba_public_storage;
create policy "Public can read TBA storage config"
on public.tba_public_storage
for select
to anon, authenticated
using (true);

revoke all on public.tba_public_storage from public;
grant select on public.tba_public_storage to anon, authenticated;
grant select, insert, update on public.tba_public_storage to service_role;

create or replace function public.tba_public_storage_config()
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'r2Ready', r2_ready,
    'r2PublicUrl', r2_public_url
  )
  from public.tba_public_storage
  where id = true;
$$;

revoke all on function public.tba_public_storage_config() from public;
grant execute on function public.tba_public_storage_config() to anon, authenticated, service_role;
