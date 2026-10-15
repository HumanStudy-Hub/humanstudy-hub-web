-- Interaction-only collection: legacy screen/DOM recordings may be read/exported, never uploaded.
-- Restrictive policies also protect against older clients and additional permissive policies.
create policy desktop_recordings_disabled on public.desktop_replay_chunks
  as restrictive for insert to authenticated with check (false);

create policy desktop_recordings_storage_insert_disabled on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'desktop-replays'
    or coalesce((storage.foldername(name))[3] = 'blobs', false));

create policy desktop_recordings_storage_update_disabled on storage.objects
  as restrictive for update to authenticated
  using (bucket_id <> 'desktop-replays'
    or coalesce((storage.foldername(name))[3] = 'blobs', false))
  with check (bucket_id <> 'desktop-replays'
    or coalesce((storage.foldername(name))[3] = 'blobs', false));
