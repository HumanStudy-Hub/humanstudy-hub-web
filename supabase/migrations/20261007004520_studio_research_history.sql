-- Scientific content is append-only; drafts and extracted source text remain
-- in the live document instead of duplicating on every autosave.
create function public.studio_research_snapshot(p_document jsonb) returns jsonb
language sql immutable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'formatVersion', 1,
    'title', p_document->'title',
    'model', coalesce(p_document#>'{model,program}', p_document->'model'),
    'sources', coalesce((select jsonb_agg(source - 'text' - 'pages' order by ordinal)
      from jsonb_array_elements(coalesce(p_document->'sources', '[]'::jsonb)) with ordinality as s(source, ordinal)), '[]'::jsonb),
    'annotations', coalesce(p_document->'annotations', '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(conversation - 'draft' - 'updatedAt' - 'selected' - 'modelAnchor' - 'sourceSelection' order by ordinal)
      from jsonb_array_elements(coalesce(p_document->'conversations', '[]'::jsonb)) with ordinality as c(conversation, ordinal)), '[]'::jsonb),
    'reviewResponses', coalesce(p_document->'reviewResponses', '{}'::jsonb),
    'artifacts', coalesce(p_document->'artifacts', '[]'::jsonb),
    'acceptedPackage', p_document->'acceptedPackage',
    'pipeline', (p_document->'pipeline') - 'updatedAt',
    'discussion', (p_document->'discussion') - 'updatedAt'
  );
$$;

create table public.studio_research_history (
  workspace_id uuid not null references public.studio_workspaces(id) on delete cascade,
  revision integer not null check (revision > 0),
  owner_id uuid not null references auth.users(id) on delete cascade,
  recorded_at timestamptz not null,
  capture_kind text not null check (capture_kind in ('initial','change','baseline')),
  knowledge jsonb not null check (jsonb_typeof(knowledge) = 'object'),
  primary key (workspace_id, revision)
);
create index studio_research_history_owner_at_idx on public.studio_research_history(owner_id, recorded_at);
alter table public.studio_research_history enable row level security;
create policy studio_research_history_select on public.studio_research_history
for select to authenticated using (owner_id = (select auth.uid()));
-- The invoker trigger needs INSERT. A direct insertion can only record the
-- caller's exact current committed document, never forge a historical state.
create policy studio_research_history_insert on public.studio_research_history
for insert to authenticated with check (
  owner_id = (select auth.uid()) and exists (
    select 1 from public.studio_workspaces w
    where w.id = workspace_id and w.owner_id = (select auth.uid())
      and w.revision = studio_research_history.revision
      and w.updated_at = recorded_at
      and public.studio_research_snapshot(w.document) = knowledge
      and ((w.revision = 1 and capture_kind = 'initial') or (w.revision > 1 and capture_kind = 'change'))
  )
);
revoke all on public.studio_research_history from anon, authenticated;
grant select, insert on public.studio_research_history to authenticated;

create function public.studio_capture_research_history() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
declare snapshot jsonb;
begin
  snapshot := public.studio_research_snapshot(new.document);
  if tg_op = 'INSERT' or public.studio_research_snapshot(old.document) is distinct from snapshot then
    insert into public.studio_research_history(workspace_id, revision, owner_id, recorded_at, capture_kind, knowledge)
    values (new.id, new.revision, new.owner_id, new.updated_at, case when tg_op = 'INSERT' then 'initial' else 'change' end, snapshot);
  end if;
  return new;
end;
$$;
create trigger studio_capture_research_history after insert or update on public.studio_workspaces
for each row execute function public.studio_capture_research_history();

revoke all on function public.studio_research_snapshot(jsonb) from public;
revoke all on function public.studio_capture_research_history() from public;
grant execute on function public.studio_research_snapshot(jsonb) to authenticated;

-- Existing documents establish a baseline; earlier overwritten states cannot
-- be reconstructed and are deliberately not presented as historical records.
insert into public.studio_research_history(workspace_id, revision, owner_id, recorded_at, capture_kind, knowledge)
select id, revision, owner_id, updated_at, 'baseline', public.studio_research_snapshot(document)
from public.studio_workspaces;

-- Client-observed revision is distinct from the server revision at receipt.
alter table public.studio_events add column display_revision integer check (display_revision > 0);
create index studio_events_workspace_created_id_idx on public.studio_events(workspace_id, created_at, id);
