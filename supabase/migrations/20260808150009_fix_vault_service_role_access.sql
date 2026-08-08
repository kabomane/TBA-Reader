create or replace function public.tba_get_secret(secret_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = secret_name
  order by updated_at desc
  limit 1;
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
