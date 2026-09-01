alter table public.tba_settings
  add column if not exists whisper_status text not null default 'disabled'
    check (whisper_status in ('disabled', 'installing', 'active', 'cleanup_required')),
  add column if not exists whisper_model_key text,
  add column if not exists whisper_error text,
  add column if not exists whisper_installed_at timestamptz;

create table if not exists public.tba_public_whisper (
  id boolean primary key default true check (id),
  whisper_ready boolean not null default false,
  whisper_public_url text,
  constraint tba_public_whisper_ready_url check (
    (whisper_ready and whisper_public_url is not null)
    or (not whisper_ready and whisper_public_url is null)
  )
);

insert into public.tba_public_whisper (id, whisper_ready, whisper_public_url)
values (true, false, null)
on conflict (id) do nothing;

alter table public.tba_public_whisper enable row level security;

drop policy if exists "Public can read TBA Whisper config" on public.tba_public_whisper;
create policy "Public can read TBA Whisper config"
on public.tba_public_whisper
for select
to anon, authenticated
using (true);

revoke all on public.tba_public_whisper from public;
grant select on public.tba_public_whisper to anon, authenticated;
grant select, insert, update on public.tba_public_whisper to service_role;

create or replace function public.tba_public_whisper_config()
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'whisperEnabled', whisper_ready,
    'modelUrl', whisper_public_url
  )
  from public.tba_public_whisper
  where id = true;
$$;

revoke all on function public.tba_public_whisper_config() from public;
grant execute on function public.tba_public_whisper_config() to anon, authenticated, service_role;
