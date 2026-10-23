create index studio_events_owner_idx on public.studio_events(owner_id);
alter policy studio_workspaces_select on public.studio_workspaces to authenticated using (owner_id = (select auth.uid()));
alter policy studio_workspaces_insert on public.studio_workspaces to authenticated with check (owner_id = (select auth.uid()) and revision = 1);
alter policy studio_workspaces_update on public.studio_workspaces to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
alter policy studio_events_select on public.studio_events to authenticated using (owner_id = (select auth.uid()));
alter policy studio_events_insert on public.studio_events to authenticated
with check (owner_id = (select auth.uid()) and exists (
  select 1 from public.studio_workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())
));
alter policy studio_sources_insert on storage.objects to authenticated
with check (bucket_id = 'studio-sources' and array_length(storage.foldername(name), 1) = 2 and
  name ~ '/[0-9a-f-]{36}\.pdf$' and (storage.foldername(name))[1] = (select auth.uid())::text and
  exists (select 1 from public.studio_workspaces w where w.id::text = (storage.foldername(name))[2] and w.owner_id = (select auth.uid())));
alter policy studio_sources_select on storage.objects to authenticated
using (bucket_id = 'studio-sources' and array_length(storage.foldername(name), 1) = 2 and
  name ~ '/[0-9a-f-]{36}\.pdf$' and (storage.foldername(name))[1] = (select auth.uid())::text and
  exists (select 1 from public.studio_workspaces w where w.id::text = (storage.foldername(name))[2] and w.owner_id = (select auth.uid())));
