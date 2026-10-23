-- Studio keeps original research resources private under the same owner/workspace
-- key structure as source PDFs. No public read or cross-workspace access is added.
update storage.buckets
set public = false,
    file_size_limit = 26214400,
    allowed_mime_types = array[
      'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
      'application/json', 'text/x-python', 'text/x-r',
      'image/png', 'image/jpeg', 'image/webp', 'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
where id = 'studio-sources';

alter policy studio_sources_insert on storage.objects to authenticated
with check (
  bucket_id = 'studio-sources'
  and array_length(storage.foldername(name), 1) = 2
  and name ~ '/[0-9a-f-]{36}[.](pdf|txt|md|csv|json|png|jpg|jpeg|webp|zip|docx|xlsx|py|r)$'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.studio_workspaces w
    where w.id::text = (storage.foldername(name))[2]
      and w.owner_id = (select auth.uid())
  )
);

alter policy studio_sources_select on storage.objects to authenticated
using (
  bucket_id = 'studio-sources'
  and array_length(storage.foldername(name), 1) = 2
  and name ~ '/[0-9a-f-]{36}[.](pdf|txt|md|csv|json|png|jpg|jpeg|webp|zip|docx|xlsx|py|r)$'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.studio_workspaces w
    where w.id::text = (storage.foldername(name))[2]
      and w.owner_id = (select auth.uid())
  )
);
