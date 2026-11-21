-- Cloud workspace visits (humanstudy-desktop PR #161, "Hub integration required").
--
-- The Hub issues one canonical visit UUID per logical cloud-workspace visit. It reaches the runtime as
-- HS_VISIT_ID and as hs_visit on the workspace URL, and runtime rows carry it as a top-level column.
-- online_workspace_visits holds the Hub's own record of each visit and of the terminal reason it decided,
-- kept apart from the runtime's per-process session.start / session.end sequence.

-- ---------------------------------------------------------------------------------------------
-- research_events.visit_id
-- ---------------------------------------------------------------------------------------------
alter table public.research_events add column if not exists visit_id uuid;
comment on column public.research_events.visit_id is
  'Hub-issued cloud workspace visit (online_workspace_visits.id). Null for desktop, headless, older rows and workspaces opened without a Hub visit.';
create index if not exists research_events_owner_visit_idx
  on public.research_events(owner_id, visit_id) where visit_id is not null;

-- Same definition as 20261022223132_research_data_contract_v1.sql, with visit_id appended
-- (create or replace view may only add columns at the end).
create or replace view public.research_session_delivery with (security_invoker = true) as
with s as (
  select owner_id, surface, install_id, research_session_id,
         min(contract_version) as contract_version,
         count(*) as events_received,
         max(client_seq) as max_seq_received,
         max(case when event_type in ('session.end', 'delivery.checkpoint')
                   and metadata->>'captured_through_seq' ~ '^[0-9]{1,10}$'
                  then (metadata->>'captured_through_seq')::bigint end) as declared_through_seq,
         bool_or(event_type = 'session.start') as has_start,
         bool_or(event_type = 'session.end') as has_end,
         count(*) filter (where event_type = 'delivery.rejected') as rejected_reports,
         min(occurred_at) as first_occurred_at,
         max(occurred_at) as last_occurred_at,
         max(received_at) as last_received_at,
         max(received_at - occurred_at) as max_delivery_lag
  from public.research_events
  group by owner_id, surface, install_id, research_session_id
), m as (
  select owner_id, research_session_id, count(distinct event_id) as events_missing_content
  from public.research_missing_content
  group by owner_id, research_session_id
), v as (
  -- A runtime session belongs to one visit; take its first stamped value.
  select owner_id, surface, install_id, research_session_id,
         (array_agg(visit_id order by client_seq) filter (where visit_id is not null))[1] as visit_id
  from public.research_events
  where visit_id is not null
  group by owner_id, surface, install_id, research_session_id
)
select s.*,
       greatest(s.max_seq_received, coalesce(s.declared_through_seq, 0)) as expected_events,
       greatest(s.max_seq_received, coalesce(s.declared_through_seq, 0)) - s.events_received as events_missing,
       coalesce(m.events_missing_content, 0) as events_missing_content,
       (s.has_end
        and greatest(s.max_seq_received, coalesce(s.declared_through_seq, 0)) = s.events_received
        and coalesce(m.events_missing_content, 0) = 0) as complete,
       v.visit_id
from s
left join m on m.owner_id = s.owner_id and m.research_session_id = s.research_session_id
left join v on v.owner_id = s.owner_id and v.surface = s.surface and v.install_id = s.install_id
  and v.research_session_id = s.research_session_id;
comment on view public.research_session_delivery is
  'Per research session: received events, sequence gaps, declared high-water mark and events with missing content. complete = ended, gap-free and all content present. visit_id = the Hub visit the session ran in, if stamped.';

-- ---------------------------------------------------------------------------------------------
-- online_workspace_visits: the Hub's record of each visit
-- ---------------------------------------------------------------------------------------------
create table public.online_workspace_visits (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace text not null check (workspace ~ '^try-(preview-[a-f0-9]{12}-)?[a-f0-9-]{36}$'),
  started_at timestamptz not null default now(),
  -- The provider's hard limit for the session, as last known to the Hub.
  provider_expires_at timestamptz,
  ended_at timestamptz,
  -- timeout: Hub deadline stop, or the provider limit passed without one.
  -- user_stop: explicit Stop. crash: the server did not start. unknown: ended without a known cause.
  end_reason text check (end_reason in ('timeout', 'user_stop', 'crash', 'unknown')),
  constraint online_workspace_visits_end check ((ended_at is null) = (end_reason is null))
);
comment on table public.online_workspace_visits is
  'Hub-side record of each cloud workspace visit and the terminal reason the Hub decided. Distinct from runtime session events in research_events (joined by research_events.visit_id).';
create index online_workspace_visits_owner_idx on public.online_workspace_visits(owner_id, started_at);
create index online_workspace_visits_open_idx on public.online_workspace_visits(workspace) where ended_at is null;

alter table public.online_workspace_visits enable row level security;
revoke all on public.online_workspace_visits from public, anon, authenticated, service_role;
grant select on public.online_workspace_visits to authenticated;
grant select, insert, update on public.online_workspace_visits to service_role;
create policy online_workspace_visits_select on public.online_workspace_visits for select to authenticated
  using (owner_id = (select auth.uid()));

-- Records a visit when its server starts or a reconnect reuses it. A fresh visit closes any earlier
-- visit of the same workspace that never recorded an end: the provider limit passed, or it is unknown.
create function public.online_visit_begin(visit uuid, owner uuid, workspace_name text, provider_expiry timestamptz)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  stamp timestamptz := pg_catalog.clock_timestamp();
  affected integer;
begin
  if visit is null or owner is null or workspace_name is null then
    raise exception 'invalid visit parameters';
  end if;
  update public.online_workspace_visits set
    ended_at = case when provider_expires_at <= stamp then provider_expires_at else stamp end,
    end_reason = case when provider_expires_at <= stamp then 'timeout' else 'unknown' end
  where workspace = workspace_name and ended_at is null and id <> visit;
  insert into public.online_workspace_visits (id, owner_id, workspace, started_at, provider_expires_at)
  values (visit, owner, workspace_name, stamp, provider_expiry)
  on conflict (id) do update set
    provider_expires_at = greatest(public.online_workspace_visits.provider_expires_at, excluded.provider_expires_at)
  where public.online_workspace_visits.owner_id = excluded.owner_id
    and public.online_workspace_visits.workspace = excluded.workspace
    and public.online_workspace_visits.ended_at is null;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;

-- Records the Hub's terminal decision once. A null visit ends whatever visit of the workspace is open.
create function public.online_visit_end(workspace_name text, visit uuid, reason text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  affected integer;
begin
  if workspace_name is null or reason is null then raise exception 'invalid visit parameters'; end if;
  update public.online_workspace_visits set ended_at = pg_catalog.clock_timestamp(), end_reason = reason
  where workspace = workspace_name and ended_at is null and (visit is null or id = visit);
  get diagnostics affected = row_count;
  return affected > 0;
end
$$;

revoke execute on function public.online_visit_begin(uuid, uuid, text, timestamptz),
  public.online_visit_end(text, uuid, text) from public, anon, authenticated;
grant execute on function public.online_visit_begin(uuid, uuid, text, timestamptz),
  public.online_visit_end(text, uuid, text) to service_role;

notify pgrst, 'reload schema';
