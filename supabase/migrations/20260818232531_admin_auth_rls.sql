-- Lecture publique des épisodes, écritures réservées au compte Auth administrateur.
alter table public.episodes enable row level security;

drop policy if exists "TBA admin can insert episodes" on public.episodes;
create policy "TBA admin can insert episodes"
on public.episodes
for insert
to authenticated
with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin');

drop policy if exists "TBA admin can update episodes" on public.episodes;
create policy "TBA admin can update episodes"
on public.episodes
for update
to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin')
with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin');

drop policy if exists "TBA admin can delete episodes" on public.episodes;
create policy "TBA admin can delete episodes"
on public.episodes
for delete
to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin');

revoke all on public.episodes from anon, authenticated;
grant select on public.episodes to anon, authenticated;
grant insert, update, delete on public.episodes to authenticated;

-- La configuration publique reste lisible, jamais modifiable depuis le navigateur.
revoke all on public.tba_public_storage from anon, authenticated;
grant select on public.tba_public_storage to anon, authenticated;

-- Les tables d'infrastructure restent exclusivement accessibles au service serveur.
revoke all on public.tba_settings from anon, authenticated;
revoke all on public.tba_storage_jobs from anon, authenticated;

-- Le bucket reste public pour les URLs de lecture. Les opérations SQL Storage
-- sont limitées au compte Auth portant le rôle non modifiable tba_admin.
drop policy if exists "TBA admin can read media objects" on storage.objects;
create policy "TBA admin can read media objects"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'tba-media'
  and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin'
);

drop policy if exists "TBA admin can upload media objects" on storage.objects;
create policy "TBA admin can upload media objects"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'tba-media'
  and name like 'episodes/%'
  and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin'
);

drop policy if exists "TBA admin can update media objects" on storage.objects;
create policy "TBA admin can update media objects"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'tba-media'
  and name like 'episodes/%'
  and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin'
)
with check (
  bucket_id = 'tba-media'
  and name like 'episodes/%'
  and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin'
);

drop policy if exists "TBA admin can delete media objects" on storage.objects;
create policy "TBA admin can delete media objects"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'tba-media'
  and name like 'episodes/%'
  and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'tba_admin'
);
