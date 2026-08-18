-- Force l'évaluation unique du JWT par requête pour les politiques des épisodes.
drop policy if exists "TBA admin can insert episodes" on public.episodes;
create policy "TBA admin can insert episodes"
on public.episodes
for insert
to authenticated
with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'tba_admin');

drop policy if exists "TBA admin can update episodes" on public.episodes;
create policy "TBA admin can update episodes"
on public.episodes
for update
to authenticated
using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'tba_admin')
with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'tba_admin');

drop policy if exists "TBA admin can delete episodes" on public.episodes;
create policy "TBA admin can delete episodes"
on public.episodes
for delete
to authenticated
using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'tba_admin');
