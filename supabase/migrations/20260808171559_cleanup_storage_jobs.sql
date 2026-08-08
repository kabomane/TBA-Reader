-- Les tâches terminées ne sont pas un historique métier : elles peuvent être supprimées.
delete from public.tba_storage_jobs
where status = 'complete';

-- Une tâche active remplace toute ancienne erreur du même épisode.
delete from public.tba_storage_jobs as failed
using public.tba_storage_jobs as active
where failed.episode_id = active.episode_id
  and failed.status = 'error'
  and active.status in ('queued', 'copying', 'verifying', 'committing', 'cleanup');

-- Parmi d'éventuelles erreurs historiques en double, garder uniquement la plus récente.
with ranked_errors as (
  select
    id,
    row_number() over (
      partition by episode_id
      order by updated_at desc, created_at desc, id desc
    ) as position
  from public.tba_storage_jobs
  where status = 'error'
)
delete from public.tba_storage_jobs as jobs
using ranked_errors
where jobs.id = ranked_errors.id
  and ranked_errors.position > 1;

drop index if exists public.tba_storage_jobs_one_active_idx;

create unique index tba_storage_jobs_one_open_idx
  on public.tba_storage_jobs (episode_id)
  where status in ('queued', 'copying', 'verifying', 'committing', 'cleanup', 'error');
