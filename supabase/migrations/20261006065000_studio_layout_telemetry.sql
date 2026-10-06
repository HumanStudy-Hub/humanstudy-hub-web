-- Workspace revision is assigned by the authenticated events endpoint at receipt.
-- Older events remain nullable; this is an observed revision, not a document snapshot.
alter table public.studio_events
  add column workspace_revision integer check (workspace_revision > 0);

alter table public.studio_events
  drop constraint studio_events_event_type_check;
alter table public.studio_events
  add constraint studio_events_event_type_check
  check (event_type in ('click','pointer','scroll','selection','visibility','chat','review','layout'));
