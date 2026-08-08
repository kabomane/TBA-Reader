create extension if not exists supabase_vault with schema vault;

alter table public.episodes
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists storage_bytes bigint not null default 0,
  add column if not exists data jsonb not null default '{}'::jsonb;

alter table public.episodes
  drop constraint if exists episodes_storage_provider_check,
  add constraint episodes_storage_provider_check
    check (storage_provider in ('supabase', 'r2')),
  drop constraint if exists episodes_storage_bytes_check,
  add constraint episodes_storage_bytes_check
    check (storage_bytes >= 0),
  drop constraint if exists episodes_data_object_check,
  add constraint episodes_data_object_check
    check (jsonb_typeof(data) = 'object');

with media as (
  select
    e.id,
    e.youtube_url,
    e.image_path,
    e.audio_path,
    'episodes/' || e.id || '/body.md' as body_path,
    image.metadata as image_metadata,
    audio.metadata as audio_metadata,
    body.metadata as body_metadata
  from public.episodes e
  left join storage.objects image
    on image.bucket_id = 'tba-media' and image.name = e.image_path
  left join storage.objects audio
    on audio.bucket_id = 'tba-media' and audio.name = e.audio_path
  left join storage.objects body
    on body.bucket_id = 'tba-media' and body.name = 'episodes/' || e.id || '/body.md'
)
update public.episodes e
set
  storage_provider = 'supabase',
  storage_bytes = coalesce((m.image_metadata ->> 'size')::bigint, 0)
    + coalesce((m.audio_metadata ->> 'size')::bigint, 0)
    + coalesce((m.body_metadata ->> 'size')::bigint, 0),
  data = jsonb_strip_nulls(jsonb_build_object(
    'youtube', m.youtube_url,
    'body', jsonb_build_object(
      'key', m.body_path,
      'size', coalesce((m.body_metadata ->> 'size')::bigint, 0),
      'mime', coalesce(m.body_metadata ->> 'mimetype', 'text/markdown'),
      'etag', m.body_metadata ->> 'eTag'
    ),
    'image', case when m.image_path is null then null else jsonb_build_object(
      'key', m.image_path,
      'size', coalesce((m.image_metadata ->> 'size')::bigint, 0),
      'mime', m.image_metadata ->> 'mimetype',
      'etag', m.image_metadata ->> 'eTag'
    ) end,
    'audio', case when m.audio_path is null then null else jsonb_build_object(
      'key', m.audio_path,
      'size', coalesce((m.audio_metadata ->> 'size')::bigint, 0),
      'mime', m.audio_metadata ->> 'mimetype',
      'etag', m.audio_metadata ->> 'eTag'
    ) end
  ))
from media m
where e.id = m.id
  and (e.data = '{}'::jsonb or not (e.data ? 'body'));

create table if not exists public.tba_settings (
  id boolean primary key default true check (id),
  auto_migration_enabled boolean not null default false,
  trigger_percent smallint not null default 75 check (trigger_percent between 2 and 99),
  target_percent smallint not null default 60 check (target_percent between 1 and 98),
  quota_bytes bigint not null default 1000000000 check (quota_bytes > 0),
  r2_account_id text,
  r2_parent_access_key_id text,
  r2_bucket text,
  r2_public_url text,
  r2_ready boolean not null default false,
  updated_at timestamptz not null default now(),
  check (target_percent < trigger_percent)
);

insert into public.tba_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.tba_settings enable row level security;
revoke all on public.tba_settings from public, anon, authenticated;
grant select, insert, update on public.tba_settings to service_role;

create table if not exists public.tba_storage_jobs (
  id uuid primary key default gen_random_uuid(),
  episode_id text not null references public.episodes(id) on delete cascade,
  source_provider text not null check (source_provider in ('supabase', 'r2')),
  target_provider text not null check (target_provider in ('supabase', 'r2')),
  status text not null default 'queued'
    check (status in ('queued', 'copying', 'verifying', 'committing', 'cleanup', 'complete', 'error')),
  manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest) = 'object'),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tba_storage_jobs_episode_created_idx
  on public.tba_storage_jobs (episode_id, created_at desc);

create unique index if not exists tba_storage_jobs_one_active_idx
  on public.tba_storage_jobs (episode_id)
  where status in ('queued', 'copying', 'verifying', 'committing', 'cleanup');

alter table public.tba_storage_jobs enable row level security;
revoke all on public.tba_storage_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.tba_storage_jobs to service_role;

create or replace function public.tba_storage_bytes()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select coalesce(sum((metadata ->> 'size')::bigint), 0)
  from storage.objects
  where bucket_id = 'tba-media';
$$;

revoke all on function public.tba_storage_bytes() from public, anon, authenticated;
grant execute on function public.tba_storage_bytes() to service_role;

create or replace function public.tba_object_info(object_keys text[])
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', name,
    'size', coalesce((metadata ->> 'size')::bigint, 0),
    'mime', metadata ->> 'mimetype',
    'etag', metadata ->> 'eTag'
  )), '[]'::jsonb)
  from storage.objects
  where bucket_id = 'tba-media' and name = any(object_keys);
$$;

revoke all on function public.tba_object_info(text[]) from public, anon, authenticated;
grant execute on function public.tba_object_info(text[]) to service_role;

create or replace function public.tba_orphan_stats()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with referenced as (
    select data -> 'body' ->> 'key' as name from public.episodes
    union select data -> 'image' ->> 'key' from public.episodes
    union select data -> 'audio' ->> 'key' from public.episodes
  )
  select jsonb_build_object(
    'objects', count(*) filter (where r.name is null),
    'bytes', coalesce(sum((o.metadata ->> 'size')::bigint) filter (where r.name is null), 0)
  )
  from storage.objects o
  left join referenced r on r.name = o.name
  where o.bucket_id = 'tba-media';
$$;

revoke all on function public.tba_orphan_stats() from public, anon, authenticated;
grant execute on function public.tba_orphan_stats() to service_role;

create or replace function public.tba_public_storage_config()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'r2Ready', r2_ready,
    'r2PublicUrl', r2_public_url
  )
  from public.tba_settings
  where id = true;
$$;

revoke all on function public.tba_public_storage_config() from public;
grant execute on function public.tba_public_storage_config() to anon, authenticated, service_role;

create or replace function public.tba_get_secret(secret_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  return (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = secret_name
    order by updated_at desc
    limit 1
  );
end;
$$;

revoke all on function public.tba_get_secret(text) from public, anon, authenticated;
grant execute on function public.tba_get_secret(text) to service_role;

create or replace function public.tba_upsert_secret(secret_name text, secret_value text, secret_description text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select id into existing_id
  from vault.decrypted_secrets
  where name = secret_name
  order by updated_at desc
  limit 1;

  if existing_id is null then
    perform vault.create_secret(secret_value, secret_name, secret_description);
  else
    perform vault.update_secret(existing_id, secret_value, secret_name, secret_description);
  end if;
end;
$$;

revoke all on function public.tba_upsert_secret(text, text, text) from public, anon, authenticated;
grant execute on function public.tba_upsert_secret(text, text, text) to service_role;
