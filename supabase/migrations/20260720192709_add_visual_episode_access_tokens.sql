alter table public.episodes
  add column if not exists token text null;

alter table public.episodes
  drop constraint if exists episodes_token_format_check;

alter table public.episodes
  add constraint episodes_token_format_check
  check (token is null or token ~ '^[0-9a-f]{16}$');
