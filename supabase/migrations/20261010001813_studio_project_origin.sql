-- Keep seeded and forked knowledge distinguishable from independent researcher input.
-- Layout-only project settings do not create scientific snapshots.
-- Scientific content is append-only; drafts and extracted source text remain
-- in the live document instead of duplicating on every autosave.
create or replace function public.studio_research_snapshot(p_document jsonb) returns jsonb
language sql immutable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'formatVersion', 1,
    'origin', jsonb_strip_nulls(jsonb_build_object(
      'sampleId', p_document#>'{project,sampleId}',
      'forkedFrom', p_document#>'{project,forkedFrom}'
    )),
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

