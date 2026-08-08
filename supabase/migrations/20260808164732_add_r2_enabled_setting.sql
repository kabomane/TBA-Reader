alter table public.tba_settings
  add column if not exists r2_enabled boolean not null default false;
