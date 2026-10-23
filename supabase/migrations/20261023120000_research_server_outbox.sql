-- Research collection T08: durable outbox for server-produced research batches (web).
-- HumanStudy-Hub/humanstudy-desktop#27 / #30. NOT APPLIED. Shared dev/production project: review,
-- validate in a rolled-back transaction (tests/research-server-outbox.sql), then apply with owner
-- approval. The live version name may differ from this filename; rename to match after applying.
--
-- Additive only. Nothing existing is altered or dropped:
--   research_server_outbox                one row per server batch (= one research session)
--   research_server_outbox_guard          trigger: delivery bookkeeping only, payload released once
--   studio_cas_workspace_research(...)    the existing CAS + outbox insert in ONE transaction
--   research_server_outbox_delivery       view: pending / failing / rejected / delivered, confirmed
--                                         against research_events and research_missing_content
-- studio_cas_workspace, studio_research_history and its trigger are untouched and still run.

create table public.research_server_outbox (
  -- = research_session_id of every event in the batch (derived from a stable producer key).
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  producer text not null check (producer ~ '^[a-z][a-z0-9_.-]{0,59}$'),
  project_id text check (project_id ~ '^[A-Za-z0-9_.:-]{8,80}$'),
  event_count integer not null check (event_count between 1 and 10000),
  content_count integer not null check (content_count between 0 and 10000),
  -- {"events": [ResearchEvent...], "content": [{sha256, bytes, mime, text}...]}. Released (set to
  -- null) only after delivery was confirmed by reading the rows back.
  payload jsonb check (payload is null or (jsonb_typeof(payload) = 'object'
    and jsonb_typeof(payload->'events') = 'array' and jsonb_typeof(payload->'content') = 'array')),
  created_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  last_error text check (char_length(last_error) <= 200),
  delivered_at timestamptz,
  constraint research_server_outbox_payload_until_delivered check (payload is not null or delivered_at is not null)
);
comment on table public.research_server_outbox is
  'Research-data contract v1 server outbox (web). One row per server-produced batch, written in the same transaction as the workspace commit. Delivery copies it into research_events/research_content; see research_server_outbox_delivery.';
create index research_server_outbox_pending_idx on public.research_server_outbox(owner_id, created_at) where delivered_at is null;
create index research_server_outbox_pending_all_idx on public.research_server_outbox(created_at) where delivered_at is null;

create function public.research_server_outbox_stamp() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  new.created_at := now();
  new.attempts := 0; new.last_attempt_at := null; new.last_error := null; new.delivered_at := null;
  if new.payload is null then raise exception 'outbox payload required' using errcode = '23514'; end if;
  return new;
end;
$$;
create trigger research_server_outbox_stamp before insert on public.research_server_outbox
for each row execute function public.research_server_outbox_stamp();

-- Updates may only record delivery attempts, mark delivery once, and release the payload after it.
create function public.research_server_outbox_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
     or new.producer is distinct from old.producer or new.project_id is distinct from old.project_id
     or new.event_count is distinct from old.event_count or new.content_count is distinct from old.content_count
     or new.created_at is distinct from old.created_at then
    raise exception 'immutable outbox identity' using errcode = '23514';
  end if;
  if new.attempts < old.attempts then raise exception 'outbox attempts are monotonic' using errcode = '23514'; end if;
  if old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at then
    raise exception 'outbox delivery is recorded once' using errcode = '23514';
  end if;
  if new.payload is distinct from old.payload and (new.payload is not null or new.delivered_at is null) then
    raise exception 'outbox payload can only be released after delivery' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger research_server_outbox_guard before update on public.research_server_outbox
for each row execute function public.research_server_outbox_guard();
revoke all on function public.research_server_outbox_stamp() from public;
revoke all on function public.research_server_outbox_guard() from public;

alter table public.research_server_outbox enable row level security;
create policy research_server_outbox_insert on public.research_server_outbox for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy research_server_outbox_select on public.research_server_outbox for select to authenticated
  using (owner_id = (select auth.uid()));
create policy research_server_outbox_update on public.research_server_outbox for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
revoke all on public.research_server_outbox from public, anon, authenticated;
grant select, insert on public.research_server_outbox to authenticated;
grant update (attempts, last_attempt_at, last_error, delivered_at, payload) on public.research_server_outbox to authenticated;
-- Scheduled drain (/api/cron/research-outbox) for owners who do not return. It checks the owner's
-- web agreement itself, because the service role bypasses the research_events consent policy.
grant select on public.research_server_outbox to service_role;
grant update (attempts, last_attempt_at, last_error, delivered_at, payload) on public.research_server_outbox to service_role;
grant select, insert on public.research_events, public.research_content to service_role;
grant select on public.research_consents, public.research_missing_content to service_role;

-- ---------------------------------------------------------------------------------------------
-- Commit + capture in one transaction
-- ---------------------------------------------------------------------------------------------
-- Same CAS as studio_cas_workspace (it is called, not copied). The outbox insert runs in a
-- sub-transaction: if it fails for any reason the workspace commit still stands and the function
-- reports outbox_stored = false, so research capture can never block or roll back a user's save.
create function public.studio_cas_workspace_research(p_id uuid, p_expected_revision integer, p_document jsonb, p_outbox jsonb)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  saved public.studio_workspaces;
  stored boolean := false;
begin
  select * into saved from public.studio_cas_workspace(p_id, p_expected_revision, p_document);
  if not found then
    return jsonb_build_object('workspace', null, 'outbox_stored', false);
  end if;
  begin
    if jsonb_typeof(p_outbox) <> 'array' then raise exception 'outbox must be an array'; end if;
    insert into public.research_server_outbox(id, owner_id, producer, project_id, event_count, content_count, payload)
    select (b->>'id')::uuid, auth.uid(), b->>'producer', b->>'project_id', (b->>'event_count')::integer,
           (b->>'content_count')::integer, b->'payload'
    from jsonb_array_elements(p_outbox) as o(b)
    on conflict (id) do nothing;
    stored := true;
  exception when others then
    stored := false;
  end;
  return jsonb_build_object('workspace', to_jsonb(saved), 'outbox_stored', stored);
end;
$$;
revoke all on function public.studio_cas_workspace_research(uuid, integer, jsonb, jsonb) from public, anon;
grant execute on function public.studio_cas_workspace_research(uuid, integer, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Observability
-- ---------------------------------------------------------------------------------------------
-- state: delivered          marked and confirmed (all events present, no missing content)
--        delivered_unconfirmed  marked, but rows or content are missing (investigate)
--        rejected           the service refused a row; payload retained for review, not retried
--        failing            pending with at least one failed attempt
--        pending            not yet attempted
create view public.research_server_outbox_delivery with (security_invoker = true) as
select o.id, o.owner_id, o.producer, o.project_id, o.created_at, o.attempts, o.last_attempt_at, o.last_error,
       o.delivered_at, o.event_count, o.content_count,
       coalesce(e.events_present, 0) as events_present,
       coalesce(m.events_missing_content, 0) as events_missing_content,
       case
         when o.delivered_at is not null and coalesce(e.events_present, 0) = o.event_count and coalesce(m.events_missing_content, 0) = 0 then 'delivered'
         when o.delivered_at is not null then 'delivered_unconfirmed'
         when o.last_error like 'rejected:%' then 'rejected'
         when o.attempts > 0 then 'failing'
         else 'pending'
       end as state,
       now() - o.created_at as age
from public.research_server_outbox o
left join lateral (
  select count(*) as events_present from public.research_events r
  where r.owner_id = o.owner_id and r.research_session_id = o.id
) e on true
left join lateral (
  select count(distinct mc.event_id) as events_missing_content from public.research_missing_content mc
  where mc.owner_id = o.owner_id and mc.research_session_id = o.id
) m on true;
comment on view public.research_server_outbox_delivery is
  'Server research batches with confirmed delivery state. Anything not ''delivered'' is a known gap in the web server dataset.';
revoke all on public.research_server_outbox_delivery from anon, authenticated;
grant select on public.research_server_outbox_delivery to authenticated, service_role;
