-- Apply in the Supabase SQL editor or migration runner after configuring Auth.
create table if not exists public.studio_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  revision integer not null default 1 check (revision > 0),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_workspaces_owner_updated_idx on public.studio_workspaces(owner_id, updated_at desc);
alter table public.studio_workspaces enable row level security;
create policy studio_workspaces_select on public.studio_workspaces for select to authenticated using (owner_id = auth.uid());
create policy studio_workspaces_insert on public.studio_workspaces for insert to authenticated with check (owner_id = auth.uid() and revision = 1);
create policy studio_workspaces_update on public.studio_workspaces for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Every update must pass through the CAS RPC. Direct PostgREST PATCH lacks the
-- transaction-local expected revision marker and is rejected by this trigger.
create function public.studio_workspace_revision_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_setting('studio.expected_revision', true) is distinct from old.revision::text then
    raise exception 'workspace update requires expected revision' using errcode = '40001';
  end if;
  if new.owner_id is distinct from old.owner_id or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'immutable workspace identity' using errcode = '23514';
  end if;
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;

create trigger studio_workspace_revision_guard before update on public.studio_workspaces
for each row execute function public.studio_workspace_revision_guard();

create function public.studio_cas_workspace(p_id uuid, p_expected_revision integer, p_document jsonb)
returns setof public.studio_workspaces
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_expected_revision < 1 or jsonb_typeof(p_document) <> 'object' or
     nullif(trim(p_document->>'title'), '') is null or char_length(p_document->>'title') > 160 then
    raise exception 'invalid workspace document' using errcode = '22023';
  end if;
  perform set_config('studio.expected_revision', p_expected_revision::text, true);
  return query
    update public.studio_workspaces
       set document = p_document, title = trim(p_document->>'title')
     where id = p_id and owner_id = auth.uid() and revision = p_expected_revision
     returning *;
end;
$$;

revoke all on function public.studio_workspace_revision_guard() from public;
revoke all on function public.studio_cas_workspace(uuid, integer, jsonb) from public;
grant execute on function public.studio_cas_workspace(uuid, integer, jsonb) to authenticated;
grant select, insert, update on public.studio_workspaces to authenticated;

create table if not exists public.studio_events (
  id uuid primary key,
  workspace_id uuid not null references public.studio_workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id text not null check (char_length(session_id) between 1 and 80),
  event_type text not null check (event_type in ('click','pointer','scroll','selection','visibility','chat','review')),
  occurred_at timestamptz not null,
  target text check (target ~ '^[A-Za-z0-9_.:/#\[\]-]{1,160}$'),
  x double precision,
  y double precision,
  duration_ms integer check (duration_ms between 0 and 86400000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096),
  created_at timestamptz not null default now()
);

create index if not exists studio_events_workspace_at_idx on public.studio_events(workspace_id, occurred_at);
alter table public.studio_events enable row level security;
create policy studio_events_select on public.studio_events for select to authenticated using (owner_id = auth.uid());
create policy studio_events_insert on public.studio_events for insert to authenticated
with check (owner_id = auth.uid() and exists (
  select 1 from public.studio_workspaces w where w.id = workspace_id and w.owner_id = auth.uid()
));
grant select, insert on public.studio_events to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('studio-sources', 'studio-sources', false, 26214400, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 26214400, allowed_mime_types = array['application/pdf'];

create policy studio_sources_insert on storage.objects for insert to authenticated
with check (bucket_id = 'studio-sources' and array_length(storage.foldername(name), 1) = 2 and
  name ~ '/[0-9a-f-]{36}\.pdf$' and (storage.foldername(name))[1] = auth.uid()::text and
  exists (select 1 from public.studio_workspaces w where w.id::text = (storage.foldername(name))[2] and w.owner_id = auth.uid()));
create policy studio_sources_select on storage.objects for select to authenticated
using (bucket_id = 'studio-sources' and array_length(storage.foldername(name), 1) = 2 and
  name ~ '/[0-9a-f-]{36}\.pdf$' and (storage.foldername(name))[1] = auth.uid()::text and
  exists (select 1 from public.studio_workspaces w where w.id::text = (storage.foldername(name))[2] and w.owner_id = auth.uid()));
