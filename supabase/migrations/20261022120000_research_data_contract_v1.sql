-- Research-data contract v1 (docs/research-data-contract.md, lib/research-data/contract.ts).
-- HumanStudy-Hub/humanstudy-desktop#27 step 1. NOT APPLIED automatically: the Supabase project is
-- shared by development and production; apply on a branch database first (see the PR).
--
-- Additive only. Nothing here alters, drops or narrows desktop_events, desktop_replay_chunks,
-- studio_events, studio_research_history or their buckets, so desktop <= 0.6.6 and the current web
-- client keep writing exactly as before. Those tables are marked legacy below.
--
-- New objects:
--   research_events            one row per captured event, every surface (desktop | web | headless)
--   research_content           one row per content object stored in bucket research-content
--   bucket research-content    <owner_id>/<sha256>, insert-only, owner-scoped, no update/delete
--   research_session_delivery  per-session completeness (sequence gaps, declared high-water mark)
--   research_missing_content   event -> referenced content that is not (fully) present yet
--
-- Ownership rule (beta policy 2026-10-13): users may insert and read their own research data and
-- may not update or delete it. Deletion requests are handled by the team with the service role.

-- ---------------------------------------------------------------------------------------------
-- Validators (immutable, usable in CHECK constraints)
-- ---------------------------------------------------------------------------------------------

-- content_refs: [{ "role": "text", "sha256": "<64 hex>", "bytes": 123, "mime": "text/plain" }, ...]
create function public.research_valid_content_refs(refs jsonb) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select jsonb_typeof(refs) = 'array'
    and jsonb_array_length(refs) <= 64
    and not exists (
      select 1 from jsonb_array_elements(refs) as r(ref)
      where coalesce(not (
        jsonb_typeof(r.ref) = 'object'
        and r.ref->>'sha256' ~ '^[0-9a-f]{64}$'
        and r.ref->>'role' ~ '^[a-z][a-z0-9_.-]{0,39}$'
        and jsonb_typeof(r.ref->'bytes') = 'number'
        and (r.ref->>'bytes')::numeric >= 0
        and (r.ref->>'bytes')::numeric = trunc((r.ref->>'bytes')::numeric)
        and (r.ref->'mime' is null or r.ref->>'mime' ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$')
      ), true)
    );
$$;

-- Defense in depth behind the client sanitizer (contract section "Sanitization"): credentials and
-- home-directory paths are rejected rather than stored. Clients scrub first, so a hit is a client
-- bug; the contract requires clients to quarantine the rejected event and report it.
create function public.research_text_is_clean(t text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select t is null or not (
    t ~ '\msk-[A-Za-z0-9_-]{20,}'
    or t ~ '\mhsk_[A-Za-z0-9_-]{8,}'
    or t ~ '\meyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
    or t ~ '\m(ghp|gho|github_pat|xoxa|xoxb|xoxp)_[A-Za-z0-9_]{12,}'
    -- Home-directory paths (macOS, Linux, Windows; jsonb text doubles backslashes).
    or t ~ '(^|[^A-Za-z0-9_.~-])/(Users|home)/[A-Za-z0-9._-]+/'
    or t ~ '(^|[^A-Za-z0-9_])[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._ -]+[\\/]'
  );
$$;

revoke all on function public.research_valid_content_refs(jsonb) from public;
revoke all on function public.research_text_is_clean(text) from public;
grant execute on function public.research_valid_content_refs(jsonb) to authenticated, service_role;
grant execute on function public.research_text_is_clean(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- research_events
-- ---------------------------------------------------------------------------------------------
create table public.research_events (
  -- Assigned once at capture and persisted with the pending event, so a retry is the same row.
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contract_version text not null check (contract_version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'),
  surface text not null check (surface in ('desktop', 'web', 'headless')),
  -- Desktop install id, web browser id, or headless runner id. Never a hardware identifier.
  install_id text not null check (install_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  research_session_id uuid not null,
  -- 1, 2, 3 ... per (owner, surface, install, session), assigned at capture, persisted locally.
  client_seq bigint not null check (client_seq between 1 and 1000000000),
  data_type text not null check (data_type in (
    'session', 'interaction', 'navigation', 'selection_layout', 'conversation',
    'agent_execution', 'knowledge_artifact', 'source_input')),
  event_type text not null check (
    event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$' and char_length(event_type) <= 80
    -- Prohibited streams (contract section "Prohibitions"), whatever a client calls them.
    and event_type !~ '(mouse_?move|pointer_?move|pointer\.move|mouse\.move|trajectory|keystroke|key_?press|key_?down|rrweb|dom_snapshot|screen_record)'),
  occurred_at timestamptz not null,
  -- Set by the server at insert (trigger below); a client value is overwritten.
  received_at timestamptz not null default now(),
  project_id text check (project_id ~ '^[A-Za-z0-9_.:-]{8,80}$'),
  view text check (view ~ '^[A-Za-z0-9_.:/#-]{1,160}$'),
  target text check (char_length(target) between 1 and 160),
  -- Correlation. action_id = the primary user action that started the chain (its own id for the
  -- primary event); caused_by = the immediate parent event.
  action_id uuid,
  caused_by uuid,
  thread_id text check (thread_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  message_id text check (message_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  tool_call_id text check (tool_call_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  -- sha256 (hex) of the original source bytes: the source identity across projects and surfaces.
  source_id text check (source_id ~ '^[0-9a-f]{64}$'),
  artifact_id text check (char_length(artifact_id) between 1 and 200),
  artifact_version integer check (artifact_version > 0),
  duration_ms integer check (duration_ms between 0 and 86400000),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384),
  content_refs jsonb not null default '[]'::jsonb check (public.research_valid_content_refs(content_refs)),
  app_version text not null check (char_length(app_version) between 1 and 40),
  collector_version text not null check (char_length(collector_version) between 1 and 60),
  consent_version integer not null check (consent_version > 0),
  platform text check (platform in ('darwin', 'win32', 'linux', 'browser')),
  constraint research_events_seq_unique
    unique (owner_id, surface, install_id, research_session_id, client_seq),
  constraint research_events_primary_action check (
    event_type <> 'action.invoke' or action_id = id),
  constraint research_events_artifact_version check (
    artifact_version is null or artifact_id is not null),
  constraint research_events_clean check (
    public.research_text_is_clean(target) and public.research_text_is_clean(view)
    and public.research_text_is_clean(metadata::text))
);

comment on table public.research_events is
  'Research-data contract v1 (docs/research-data-contract.md). One row per captured event from desktop, web or headless. Insert/select own rows only; no update/delete. Delivery is complete when the row exists and every content_refs sha256 is present in research_content (see research_missing_content).';
comment on column public.research_events.occurred_at is 'Client clock at capture. Offline captures may be old; future values beyond 10 minutes are rejected.';
comment on column public.research_events.received_at is 'Server clock at insert; not client-settable.';
comment on column public.research_events.client_seq is 'Gap-free capture counter per (owner, surface, install, session). Gaps below the declared high-water mark are undelivered events.';

create index research_events_owner_session_idx
  on public.research_events(owner_id, research_session_id, client_seq);
create index research_events_owner_occurred_idx on public.research_events(owner_id, occurred_at);
create index research_events_project_idx on public.research_events(owner_id, project_id, occurred_at)
  where project_id is not null;
create index research_events_action_idx on public.research_events(action_id) where action_id is not null;
create index research_events_thread_idx on public.research_events(owner_id, thread_id, occurred_at)
  where thread_id is not null;
create index research_events_source_idx on public.research_events(source_id) where source_id is not null;
create index research_events_type_idx on public.research_events(event_type, occurred_at);
create index research_events_content_refs_idx on public.research_events using gin (content_refs jsonb_path_ops)
  where content_refs <> '[]'::jsonb;

create function public.research_events_stamp() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  new.received_at := now();
  return new;
end;
$$;
revoke all on function public.research_events_stamp() from public;
create trigger research_events_stamp before insert on public.research_events
for each row execute function public.research_events_stamp();

alter table public.research_events enable row level security;
-- No 30-day cutoff: an event captured offline weeks ago is still a valid record. The lower bound
-- only rejects clocks that are obviously wrong (before the collector existed).
create policy research_events_insert on public.research_events for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and occurred_at <= now() + interval '10 minutes'
    and occurred_at >= timestamptz '2026-01-01 00:00:00+00'
  );
create policy research_events_select on public.research_events for select to authenticated
  using (owner_id = (select auth.uid()));
revoke all on public.research_events from anon, authenticated;
grant select, insert on public.research_events to authenticated;

-- ---------------------------------------------------------------------------------------------
-- research_content + bucket research-content
-- ---------------------------------------------------------------------------------------------
-- Content is addressed per owner: object <owner_id>/<sha256>, row (owner_id, sha256).
-- Not global: a global content-addressed store would let any user test whether someone else had
-- uploaded a given file (hash probing), and would mix ownership for withdrawal requests. The same
-- paper imported by two users is stored twice; cross-user source comparison joins on sha256 with
-- the service role.
insert into storage.buckets (id, name, public, file_size_limit)
values ('research-content', 'research-content', false, 8388608)
on conflict (id) do nothing;

create table public.research_content (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- sha256 of the original, uncompressed bytes this row stands for (for a manifest: the whole
  -- content; for a part: that part).
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- whole: the object holds all bytes. part: one slice of a larger content. manifest: the object
  -- holds the JSON manifest; the bytes are the concatenation of `parts` in order.
  kind text not null check (kind in ('whole', 'part', 'manifest')),
  bytes bigint not null check (bytes >= 0),
  stored_bytes bigint not null check (stored_bytes > 0 and stored_bytes <= 8388608),
  mime text check (mime ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'),
  encoding text not null check (encoding in ('gzip', 'identity')),
  parts text[] check (parts is null or (cardinality(parts) between 2 and 10000
    and array_to_string(parts, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$')),
  object_path text generated always as (owner_id::text || '/' || sha256) stored,
  surface text not null check (surface in ('desktop', 'web', 'headless')),
  created_at timestamptz not null default now(),
  -- Set only by a service-role verifier that re-hashes the stored bytes (follow-up).
  verified_at timestamptz,
  primary key (owner_id, sha256),
  constraint research_content_parts check ((kind = 'manifest') = (parts is not null))
);
comment on table public.research_content is
  'Research-data contract v1: one row per object in bucket research-content at <owner_id>/<sha256>. Rows can only be inserted after the object exists. Insert/select own rows; no update/delete.';

alter table public.research_content enable row level security;
-- The row may only be recorded once the object is in Storage, so a row means "uploaded".
create policy research_content_insert on public.research_content for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and verified_at is null
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'research-content'
        and o.name = (select auth.uid())::text || '/' || research_content.sha256
    )
  );
create policy research_content_select on public.research_content for select to authenticated
  using (owner_id = (select auth.uid()));
revoke all on public.research_content from anon, authenticated;
grant select, insert on public.research_content to authenticated;

-- Storage: insert and read under the caller's own prefix, object name must be a sha256. No update
-- policy (so no upsert: a repeated upload of the same content is a duplicate, which clients treat
-- as already delivered) and no delete policy.
create policy research_content_storage_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'research-content'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy research_content_storage_select on storage.objects for select to authenticated
  using (
    bucket_id = 'research-content'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------------------------
-- Delivery / completeness
-- ---------------------------------------------------------------------------------------------
-- An event whose referenced content is absent, or a manifest whose parts are not all present.
create view public.research_missing_content with (security_invoker = true) as
select e.owner_id, e.surface, e.install_id, e.research_session_id, e.id as event_id, e.client_seq,
       e.event_type, ref->>'role' as role, ref->>'sha256' as sha256,
       case when c.sha256 is null then 'object_missing' else 'parts_missing' end as problem
from public.research_events e
cross join lateral jsonb_array_elements(e.content_refs) as ref
left join public.research_content c on c.owner_id = e.owner_id and c.sha256 = ref->>'sha256'
where c.sha256 is null
   or (c.kind = 'manifest' and exists (
         select 1 from unnest(c.parts) as p(sha256)
         where not exists (select 1 from public.research_content cp
                           where cp.owner_id = c.owner_id and cp.sha256 = p.sha256)));
comment on view public.research_missing_content is
  'Events whose referenced content is not fully present. Such an event is captured but not delivered.';

-- Per session: how many events arrived versus how many the client says it captured.
-- declared_through_seq comes from session.end / delivery.checkpoint metadata.captured_through_seq.
create view public.research_session_delivery with (security_invoker = true) as
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
)
select s.*,
       greatest(s.max_seq_received, coalesce(s.declared_through_seq, 0)) as expected_events,
       greatest(s.max_seq_received, coalesce(s.declared_through_seq, 0)) - s.events_received as events_missing,
       coalesce(m.events_missing_content, 0) as events_missing_content,
       (s.has_end
        and greatest(s.max_seq_received, coalesce(s.declared_through_seq, 0)) = s.events_received
        and coalesce(m.events_missing_content, 0) = 0) as complete
from s
left join m on m.owner_id = s.owner_id and m.research_session_id = s.research_session_id;
comment on view public.research_session_delivery is
  'Per research session: received events, sequence gaps, declared high-water mark and events with missing content. complete = ended, gap-free and all content present.';

revoke all on public.research_missing_content, public.research_session_delivery from anon, authenticated;
grant select on public.research_missing_content, public.research_session_delivery to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Legacy tables stay writable for shipped clients, labelled so they are never read as contract v1.
-- ---------------------------------------------------------------------------------------------
comment on table public.desktop_events is
  'LEGACY (desktop v0, consent_version 1-2, desktop <= 0.6.x). Kept writable for shipped clients; not contract v1. Map with docs/research-data-contract.md "Legacy"; never merge with research_events as if equivalent.';
comment on table public.desktop_replay_chunks is
  'LEGACY rrweb DOM recordings (desktop 0.5.x-0.6.x before 2026-10-15). Inserts disabled; historical rows retained for export only. Prohibited under contract v1.';
comment on table public.studio_events is
  'LEGACY web studio telemetry (pre contract v1). Event type "pointer" is sampled pointer movement, prohibited under contract v1; rows are retained, never presented as contract data.';
comment on table public.studio_research_history is
  'Web studio committed-knowledge snapshots (server-side trigger). Pre contract v1; linked to contract events through project_id = workspace id and artifact_version = revision.';
