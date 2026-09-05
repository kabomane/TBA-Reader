alter table public.tba_public_whisper
  add column if not exists whisper_tiny_public_url text;

create or replace function public.tba_public_whisper_config()
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'whisperEnabled', whisper_ready,
    'modelUrl', whisper_public_url,
    'modelUrls', jsonb_build_object(
      'tiny', whisper_tiny_public_url,
      'base', whisper_public_url
    )
  )
  from public.tba_public_whisper
  where id = true;
$$;

revoke all on function public.tba_public_whisper_config() from public;
grant execute on function public.tba_public_whisper_config() to anon, authenticated, service_role;
