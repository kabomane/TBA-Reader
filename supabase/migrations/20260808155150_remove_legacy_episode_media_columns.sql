do $$
begin
  if exists (
    select 1
    from public.episodes
    where data -> 'body' ->> 'key' is null
      or youtube_url is distinct from nullif(data ->> 'youtube', '')
      or image_path is distinct from data -> 'image' ->> 'key'
      or audio_path is distinct from data -> 'audio' ->> 'key'
  ) then
    raise exception 'Legacy episode columns do not match the storage manifest';
  end if;
end
$$;

alter table public.episodes
  drop column if exists youtube_url,
  drop column if exists image_path,
  drop column if exists audio_path;
