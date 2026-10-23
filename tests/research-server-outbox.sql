-- T08 server outbox: atomic commit + capture, never-blocking outbox failure, delivery bookkeeping
-- guard, owner isolation and the delivery view. Run on a BRANCH database (or a rolled-back session)
-- after applying supabase/migrations/20261023120000_research_server_outbox.sql. Everything is rolled back.
--
--   psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -f tests/research-server-outbox.sql
begin;
select set_config('rso.owner', gen_random_uuid()::text, true),
       set_config('rso.other', gen_random_uuid()::text, true),
       set_config('rso.ws', gen_random_uuid()::text, true),
       set_config('rso.batch', gen_random_uuid()::text, true),
       set_config('rso.batch2', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('rso.owner')::uuid), (current_setting('rso.other')::uuid);
insert into public.research_consents(owner_id, surface, version, usage, content, sources)
values (current_setting('rso.owner')::uuid, 'web', 3, true, true, true);
insert into public.studio_workspaces(id, owner_id, title, document)
values (current_setting('rso.ws')::uuid, current_setting('rso.owner')::uuid, 'Study',
        '{"version":1,"title":"Study","model":{},"sources":[],"annotations":[],"conversations":[],"reviewResponses":{}}');

create function pg_temp.as_user(u text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', u, true),
         set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.batch(p_id text, p_events integer, p_payload jsonb default '{"events":[],"content":[]}') returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('id', p_id, 'producer', 'chat.submit', 'project_id', current_setting('rso.ws'),
    'event_count', p_events, 'content_count', 0, 'payload', p_payload));
$$;

select pg_temp.as_user(current_setting('rso.owner'));
set local role authenticated;

do $$
declare
  ws uuid := current_setting('rso.ws')::uuid;
  b1 uuid := current_setting('rso.batch')::uuid;
  b2 uuid := current_setting('rso.batch2')::uuid;
  r jsonb;
  n bigint;
  st text;
begin
  -- 1. Commit and capture in one transaction.
  r := public.studio_cas_workspace_research(ws, 1,
    '{"version":1,"title":"Study v2","model":{"id":"m"},"sources":[],"annotations":[],"conversations":[],"reviewResponses":{}}',
    pg_temp.batch(b1::text, 3));
  if (r->'workspace'->>'revision')::int <> 2 or (r->>'outbox_stored')::boolean is not true then
    raise exception 'commit+capture failed: %', r;
  end if;
  select count(*) into n from public.research_server_outbox where id = b1 and owner_id = current_setting('rso.owner')::uuid;
  if n <> 1 then raise exception 'outbox row missing'; end if;
  select count(*) into n from public.studio_research_history where workspace_id = ws and revision = 2;
  if n <> 1 then raise exception 'legacy history trigger did not run'; end if;
  if (select attempts from public.research_server_outbox where id = b1) <> 0 then raise exception 'client attempts accepted on insert'; end if;

  -- 2. A CAS conflict stores nothing.
  r := public.studio_cas_workspace_research(ws, 1, '{"version":1,"title":"Stale","sources":[],"annotations":[],"conversations":[],"reviewResponses":{}}',
    pg_temp.batch(b2::text, 3));
  if r->'workspace' <> 'null'::jsonb or exists (select 1 from public.research_server_outbox where id = b2) then
    raise exception 'conflicting commit captured research: %', r;
  end if;

  -- 3. A broken outbox payload never blocks or rolls back the user's save.
  r := public.studio_cas_workspace_research(ws, 2, '{"version":1,"title":"Study v3","sources":[],"annotations":[],"conversations":[],"reviewResponses":{}}',
    pg_temp.batch(b2::text, 3, '{"events":"not-an-array"}'));
  if (r->'workspace'->>'revision')::int <> 3 or (r->>'outbox_stored')::boolean is not false then
    raise exception 'outbox failure changed the commit: %', r;
  end if;
  if exists (select 1 from public.research_server_outbox where id = b2) then raise exception 'invalid payload stored'; end if;

  -- 4. Replaying the same batch id is idempotent.
  r := public.studio_cas_workspace_research(ws, 3, '{"version":1,"title":"Study v4","sources":[],"annotations":[],"conversations":[],"reviewResponses":{}}',
    pg_temp.batch(b1::text, 3));
  if (r->>'outbox_stored')::boolean is not true then raise exception 'idempotent replay failed'; end if;
  select count(*) into n from public.research_server_outbox where id = b1;
  if n <> 1 then raise exception 'replay duplicated an outbox row'; end if;

  -- 5. Delivery bookkeeping only: payload is released once, after delivery.
  begin
    update public.research_server_outbox set payload = '{"events":[],"content":[{"text":"rewritten"}]}' where id = b1;
    raise exception 'payload rewrite accepted';
  exception when check_violation then null; end;
  begin
    update public.research_server_outbox set payload = null where id = b1;
    raise exception 'payload released before delivery';
  exception when check_violation then null; end;
  begin
    update public.research_server_outbox set producer = 'forged' where id = b1;
    raise exception 'producer update accepted';
  exception when insufficient_privilege then null; end;
  update public.research_server_outbox set attempts = 1, last_attempt_at = now(), last_error = 'network' where id = b1;
  select state into st from public.research_server_outbox_delivery where id = b1;
  if st <> 'failing' then raise exception 'failing batch shown as %', st; end if;
  begin
    update public.research_server_outbox set attempts = 0 where id = b1;
    raise exception 'attempt counter decreased';
  exception when check_violation then null; end;

  -- 6. Marked delivered but rows absent is not reported as delivered.
  update public.research_server_outbox set attempts = 2, delivered_at = now(), payload = null, last_error = null where id = b1;
  select state into st from public.research_server_outbox_delivery where id = b1;
  if st <> 'delivered_unconfirmed' then raise exception 'unconfirmed delivery shown as %', st; end if;
  begin
    update public.research_server_outbox set delivered_at = now() + interval '1 second' where id = b1;
    raise exception 'delivery time rewritten';
  exception when check_violation then null; end;

  -- 7. With the batch's events present it is delivered.
  insert into public.research_events(id, contract_version, surface, install_id, research_session_id, client_seq, data_type, event_type,
    occurred_at, metadata, app_version, collector_version, consent_version)
  select gen_random_uuid(), '1.0.0', 'web', 'web-server', b1, s, 'session', case s when 1 then 'session.start' when 3 then 'session.end' else 'delivery.checkpoint' end,
    now(), case s when 1 then '{"collection_mode":"server-producer"}'::jsonb when 3 then '{"captured_through_seq":3,"reason":"producer-committed"}'::jsonb
    else '{"captured_through_seq":2,"pending_events":0,"pending_content":0}'::jsonb end, 'web', 'web-server-producer/1.0.0', 3
  from generate_series(1, 3) s;
  select state into st from public.research_server_outbox_delivery where id = b1;
  if st <> 'delivered' then raise exception 'delivered batch shown as %', st; end if;

  -- 8. Rejected batches are visible and kept.
  insert into public.research_server_outbox(id, producer, project_id, event_count, content_count, payload)
  values (b2, 'workspace.save', ws::text, 2, 0, '{"events":[],"content":[]}');
  update public.research_server_outbox set attempts = 1, last_attempt_at = now(), last_error = 'rejected:rejected_400' where id = b2;
  select state into st from public.research_server_outbox_delivery where id = b2;
  if st <> 'rejected' then raise exception 'rejected batch shown as %', st; end if;
end $$;

-- 9. Another account cannot read, mark or forge the owner's outbox.
select pg_temp.as_user(current_setting('rso.other'));
do $$
declare n bigint;
begin
  if exists (select 1 from public.research_server_outbox) or exists (select 1 from public.research_server_outbox_delivery) then
    raise exception 'another user can read the outbox';
  end if;
  update public.research_server_outbox set attempts = 99 where id = current_setting('rso.batch2')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'another user marked the outbox'; end if;
  begin
    insert into public.research_server_outbox(id, owner_id, producer, event_count, content_count, payload)
    values (gen_random_uuid(), current_setting('rso.owner')::uuid, 'forged', 1, 0, '{"events":[],"content":[]}');
    raise exception 'forged owner accepted';
  exception when insufficient_privilege then null; end;
  if (public.studio_cas_workspace_research(current_setting('rso.ws')::uuid, 4, '{"version":1,"title":"Hijack","sources":[],"annotations":[],"conversations":[],"reviewResponses":{}}', '[]'))->'workspace' <> 'null'::jsonb then
    raise exception 'another user committed the workspace';
  end if;
end $$;

-- 10. Anonymous callers cannot use the RPC.
reset role;
set local role anon;
do $$ begin
  perform public.studio_cas_workspace_research(current_setting('rso.ws')::uuid, 4, '{}', '[]');
  raise exception 'anon executed the commit RPC';
exception when insufficient_privilege then null; end $$;

reset role;
rollback;
select 'passed: atomic commit+capture, conflict stores nothing, outbox failure never blocks the save, idempotent replay, payload released only after delivery, monotonic attempts, delivery recorded once, unconfirmed/failing/rejected/delivered states, owner isolation, anon denied; all rolled back' as verification;
