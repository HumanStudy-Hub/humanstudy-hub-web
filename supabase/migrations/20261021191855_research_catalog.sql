-- Research catalog: public, immutable source snapshots; privileged, atomic publication.
-- Local/preview first. This migration does not import data or change existing user tables.
create table public.research_catalog_state (
  id boolean primary key default true check (id),
  snapshot text,
  taxonomy_version text not null default '',
  paper_count integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.research_catalog_state (id) values (true);

create table public.research_papers (
  id text primary key,
  aliases text[] not null default '{}',
  current_revision text,
  indexed_snapshot text not null,
  title text not null,
  concept_ids text[] not null default '{}',
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  search_text text not null,
  fts tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, title), 'A') ||
    setweight(to_tsvector('english'::regconfig, search_text), 'B') ||
    setweight(to_tsvector('simple'::regconfig, search_text), 'C')
  ) stored,
  updated_at timestamptz not null default now()
);
create index research_papers_fts_idx on public.research_papers using gin (fts);
create index research_papers_aliases_idx on public.research_papers using gin (aliases);
create index research_papers_concepts_idx on public.research_papers using gin (concept_ids);
create index research_papers_snapshot_idx on public.research_papers (indexed_snapshot);

create table public.research_revisions (
  paper_id text not null references public.research_papers(id),
  revision text not null check (revision ~ '^[0-9a-f]{64}$'),
  document jsonb not null,
  created_at timestamptz not null default now(),
  primary key (paper_id, revision)
);
create table public.research_concepts (
  id text primary key,
  taxonomy_version text not null,
  status text not null check (status in ('proposed', 'reviewed', 'retired')),
  label text not null,
  aliases text[] not null default '{}',
  definition text not null,
  reviewed_by text,
  document jsonb not null,
  check (status <> 'reviewed' or nullif(reviewed_by, '') is not null)
);
create index research_concepts_aliases_idx on public.research_concepts using gin (aliases);

-- Explicit analysis units prevent conflating original results, reanalysis, and simulation.
-- No parser infers these rows from prose. An approved analysis adapter must supply them.
create table public.research_effect_estimates (
  id text primary key,
  paper_id text not null references public.research_papers(id),
  revision text not null,
  study_id text not null,
  comparison_id text not null,
  outcome_id text not null,
  result_kind text not null check (result_kind in ('reported_human', 'human_reanalysis', 'ai_simulation')),
  metric text not null,
  value double precision not null check (value not in ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)),
  standard_error double precision check (standard_error >= 0 and standard_error < 'Infinity'::float8),
  sample_ids text[] not null default '{}',
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0),
  document jsonb not null,
  foreign key (paper_id, revision) references public.research_revisions(paper_id, revision)
);
create index research_effects_revision_idx on public.research_effect_estimates (paper_id, revision);
create index research_effects_samples_idx on public.research_effect_estimates using gin (sample_ids);

create table public.research_ingestion_batches (
  snapshot text primary key,
  payload_hash text not null,
  source_versions jsonb not null,
  paper_count integer not null,
  created_at timestamptz not null default now()
);

alter table public.research_catalog_state enable row level security;
alter table public.research_papers enable row level security;
alter table public.research_revisions enable row level security;
alter table public.research_concepts enable row level security;
alter table public.research_effect_estimates enable row level security;
alter table public.research_ingestion_batches enable row level security;

create policy research_state_public_read on public.research_catalog_state for select to anon, authenticated using (true);
create policy research_papers_public_read on public.research_papers for select to anon, authenticated
  using (indexed_snapshot = (select snapshot from public.research_catalog_state where id));
create policy research_revisions_public_read on public.research_revisions for select to anon, authenticated
  using (exists (select 1 from public.research_papers p where p.id = paper_id));
create policy research_concepts_public_read on public.research_concepts for select to anon, authenticated
  using (status = 'reviewed' and taxonomy_version = (select taxonomy_version from public.research_catalog_state where id));
create policy research_effects_public_read on public.research_effect_estimates for select to anon, authenticated
  using (exists (select 1 from public.research_papers p where p.id = paper_id and p.current_revision = revision));
-- No write policies, and no public ingestion-batch policy.
revoke all on public.research_catalog_state, public.research_papers, public.research_revisions,
  public.research_concepts, public.research_effect_estimates, public.research_ingestion_batches from anon, authenticated;
grant select on public.research_catalog_state, public.research_papers, public.research_revisions,
  public.research_concepts, public.research_effect_estimates to anon, authenticated;
grant all on public.research_catalog_state, public.research_papers, public.research_revisions,
  public.research_concepts, public.research_effect_estimates, public.research_ingestion_batches to service_role;

create function public.search_research_catalog(
  query_text text default '', concept_filter text[] default '{}',
  capability_filter text default null, page_offset integer default 0, page_size integer default 30
)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  with concept_matches as (
    select c.id,c.label from public.research_concepts c
      where c.status='reviewed'
        and c.taxonomy_version=(select taxonomy_version from public.research_catalog_state where id)
        and (lower(c.label)=lower(trim(query_text))
             or exists(select 1 from unnest(c.aliases) a where lower(a)=lower(trim(query_text))))
  ), q as (
    select websearch_to_tsquery('english', coalesce(query_text,'')) ||
           websearch_to_tsquery('simple', coalesce(query_text,'')) as query,
      array(select id from concept_matches) as query_concepts,
      websearch_to_tsquery('english',coalesce((select string_agg(label,' OR ') from concept_matches),'')) as alias_query
  ), matches as (
    select p.document || jsonb_build_object('matchedBy',
        case when p.id=query_text or p.aliases @> array[query_text] then 'identity'
             when p.concept_ids && q.query_concepts then 'reviewed-concept'
             when p.fts @@ q.alias_query then 'concept-alias-content' else 'indexed-content' end) as document,
      ts_rank(p.fts,q.query) + case when p.concept_ids && q.query_concepts then 20 else 0 end as rank
    from public.research_papers p cross join q
    join public.research_catalog_state s on s.id
    where p.indexed_snapshot=s.snapshot
      and (nullif(trim(query_text),'') is null or p.fts @@ q.query
           or p.concept_ids && q.query_concepts or p.fts @@ q.alias_query or p.aliases @> array[query_text] or p.id=query_text)
      and (cardinality(concept_filter)=0 or p.concept_ids && concept_filter)
      and (capability_filter is null or p.document->'capabilities'->>capability_filter='true')
  ), page as (
    select * from matches order by rank desc,document->>'id'
    limit least(greatest(page_size,1),100) offset greatest(page_offset,0)
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(document order by rank desc,document->>'id') from page),'[]'::jsonb),
    'total',(select count(*) from matches),
    'snapshot',(select snapshot from public.research_catalog_state where id),
    'taxonomyVersion',(select taxonomy_version from public.research_catalog_state where id));
$$;
revoke all on function public.search_research_catalog(text,text[],text,integer,integer) from public;
grant execute on function public.search_research_catalog(text,text[],text,integer,integer) to anon, authenticated, service_role;

-- Expected snapshot + row lock prevents two imports from silently replacing each other.
-- Only the server/explicit sync command can call this; normal users cannot self-approve assets.
create function public.publish_research_catalog(payload jsonb, expected_snapshot text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  previous text;
  next_snapshot text := payload->>'snapshot';
  item jsonb;
  concept jsonb;
  revision_value text;
begin
  if next_snapshot is null or next_snapshot !~ '^[0-9a-f]{64}$' or payload->>'schemaVersion' <> '1'
     or jsonb_typeof(payload->'papers') is distinct from 'array'
     or jsonb_typeof(payload->'taxonomy'->'concepts') is distinct from 'array' then
    raise exception 'invalid research catalog';
  end if;
  select snapshot into previous from public.research_catalog_state where id for update;
  if exists(select 1 from public.research_ingestion_batches b where b.snapshot=next_snapshot
            and b.payload_hash<>md5(payload::text)) then
    raise exception 'catalog snapshot identity was reused for different content';
  end if;
  if previous = next_snapshot then return next_snapshot; end if;
  if previous is distinct from expected_snapshot then
    raise exception 'catalog changed; reload and retry' using errcode = '40001';
  end if;
  if (select count(*) from jsonb_array_elements(payload->'papers')) <>
     (select count(distinct p->>'id') from jsonb_array_elements(payload->'papers') p) then
    raise exception 'duplicate paper identity';
  end if;
  for concept in select * from jsonb_array_elements(payload->'taxonomy'->'concepts') loop
    insert into public.research_concepts(id,taxonomy_version,status,label,aliases,definition,reviewed_by,document)
    values(concept->>'id', payload->>'taxonomyVersion', concept->>'status', concept->>'label',
           array(select jsonb_array_elements_text(coalesce(concept->'aliases','[]'))),
           concept->>'definition', concept->>'reviewedBy', concept)
    on conflict(id) do update set taxonomy_version=excluded.taxonomy_version,status=excluded.status,
      label=excluded.label,aliases=excluded.aliases,definition=excluded.definition,
      reviewed_by=excluded.reviewed_by,document=excluded.document;
  end loop;
  for item in select * from jsonb_array_elements(payload->'papers') loop
    if item->>'id' !~ '^paper_[0-9a-f]{24}$' or nullif(item->>'title','') is null then
      raise exception 'invalid paper identity/title';
    end if;
    revision_value := item->>'currentRevision';
    if revision_value is not null and revision_value !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid immutable revision';
    end if;
    insert into public.research_papers(id,aliases,current_revision,indexed_snapshot,title,concept_ids,document,search_text)
    values(item->>'id',array(select jsonb_array_elements_text(coalesce(item->'aliases','[]'))),revision_value,
      next_snapshot,item->>'title',array(select jsonb_array_elements_text(coalesce(item->'conceptIds','[]'))),
      item,concat_ws(E'\n',item->>'title',item->>'description',item->>'searchText'))
    on conflict(id) do update set aliases=excluded.aliases,current_revision=excluded.current_revision,
      indexed_snapshot=excluded.indexed_snapshot,title=excluded.title,concept_ids=excluded.concept_ids,
      document=excluded.document,search_text=excluded.search_text,updated_at=now();
    if revision_value is not null then
      if exists(select 1 from public.research_revisions r where r.paper_id=item->>'id' and r.revision=revision_value and r.document<>item) then
        -- Taxonomy/search projections may evolve; immutable asset content may not.
        if exists(select 1 from public.research_revisions r where r.paper_id=item->>'id' and r.revision=revision_value
                  and r.document->'assetFiles' is distinct from item->'assetFiles') then
          raise exception 'immutable revision manifest changed';
        end if;
      end if;
      insert into public.research_revisions(paper_id,revision,document)
      values(item->>'id',revision_value,item) on conflict do nothing;
    end if;
  end loop;
  insert into public.research_ingestion_batches(snapshot,payload_hash,source_versions,paper_count)
    values(next_snapshot,md5(payload::text),coalesce(payload->'sourceVersions','{}'),jsonb_array_length(payload->'papers'))
    on conflict do nothing;
  update public.research_catalog_state set snapshot=next_snapshot,taxonomy_version=payload->>'taxonomyVersion',
    paper_count=jsonb_array_length(payload->'papers'),updated_at=now() where id;
  return next_snapshot;
end;
$$;
revoke all on function public.publish_research_catalog(jsonb,text) from public, anon, authenticated;
grant execute on function public.publish_research_catalog(jsonb,text) to service_role;
