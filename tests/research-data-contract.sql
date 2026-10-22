-- Research-data contract v1: RLS, idempotency, offline capture, prohibitions, sanitization,
-- content presence and delivery completeness. Run on a BRANCH database after applying
-- supabase/migrations/20261022120000_research_data_contract_v1.sql (and optionally
-- 20261022120100_desktop_events_allow_offline_capture.sql). Everything is rolled back.
--
--   psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -f tests/research-data-contract.sql
begin;
select set_config('rdc.owner', gen_random_uuid()::text, true),
       set_config('rdc.other', gen_random_uuid()::text, true),
       set_config('rdc.session', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('rdc.owner')::uuid), (current_setting('rdc.other')::uuid);

create function pg_temp.as_user(u text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', u, true),
         set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
$$;
-- Minimal valid contract row; fields not given take their defaults.
create function pg_temp.ev(p_id uuid, p_seq bigint, p_type text, p_data text,
                           p_at timestamptz default now(), p_meta jsonb default '{}',
                           p_refs jsonb default '[]', p_action uuid default null) returns void
language sql as $$
  insert into public.research_events(id, contract_version, surface, install_id, research_session_id,
    client_seq, data_type, event_type, occurred_at, received_at, metadata, content_refs, action_id,
    app_version, collector_version, consent_version, platform)
  values (p_id, '1.0.0', 'desktop', 'install-test-0001', current_setting('rdc.session')::uuid,
    p_seq, p_data, p_type, p_at, timestamptz '2000-01-01', p_meta, p_refs, p_action,
    '0.7.0', 'desktop-collector/1.0.0', 3, 'darwin')
  on conflict (id) do nothing;
$$;

select pg_temp.as_user(current_setting('rdc.owner'));
set local role authenticated;

do $$
declare
  a uuid := gen_random_uuid();
  sha_whole text := repeat('a', 64);
  sha_part1 text := repeat('b', 64);
  sha_part2 text := repeat('c', 64);
  sha_big text := repeat('d', 64);
  n bigint;
  d record;
begin
  -- 1. Insert, server receipt time, idempotent retry.
  perform pg_temp.ev(gen_random_uuid(), 1, 'session.start', 'session');
  perform pg_temp.ev(a, 2, 'action.invoke', 'interaction', p_action => a);
  perform pg_temp.ev(a, 2, 'action.invoke', 'interaction', p_action => a);  -- retry: same id
  select count(*) into n from public.research_events where id = a;
  if n <> 1 then raise exception 'retry duplicated an event (% rows)', n; end if;
  if (select received_at from public.research_events where id = a) < now() - interval '1 minute' then
    raise exception 'client-supplied received_at was kept';
  end if;

  -- 2. A different event claiming an existing sequence number is a client bug and fails loudly.
  begin
    perform pg_temp.ev(gen_random_uuid(), 2, 'view.dwell', 'navigation');
    raise exception 'duplicate client_seq accepted';
  exception when unique_violation then null; end;

  -- 3. Offline capture: 90 days old accepted; far-future clock rejected.
  perform pg_temp.ev(gen_random_uuid(), 3, 'view.dwell', 'navigation', now() - interval '90 days');
  begin
    perform pg_temp.ev(gen_random_uuid(), 99, 'view.dwell', 'navigation', now() + interval '1 hour');
    raise exception 'future timestamp accepted';
  exception when insufficient_privilege then null; end;

  -- 4. Prohibited streams and unsanitized payloads are rejected.
  begin
    perform pg_temp.ev(gen_random_uuid(), 98, 'pointer.move', 'interaction');
    raise exception 'pointer movement accepted';
  exception when check_violation then null; end;
  begin
    perform pg_temp.ev(gen_random_uuid(), 98, 'input.keystroke', 'interaction');
    raise exception 'keystroke accepted';
  exception when check_violation then null; end;
  begin
    perform pg_temp.ev(gen_random_uuid(), 98, 'conversation.message', 'conversation',
      p_meta => '{"text":"my key is sk-or-v1-abcdefghijklmnopqrstuvwxyz0123"}');
    raise exception 'API key accepted';
  exception when check_violation then null; end;
  begin
    perform pg_temp.ev(gen_random_uuid(), 98, 'tool.end', 'agent_execution',
      p_meta => '{"output":"wrote /Users/alice/Documents/study/program.json"}');
    raise exception 'absolute home path accepted';
  exception when check_violation then null; end;
  begin
    perform pg_temp.ev(gen_random_uuid(), 98, 'tool.end', 'agent_execution',
      p_meta => jsonb_build_object('output', 'C:\Users\alice\study\program.json'));
    raise exception 'absolute Windows path accepted';
  exception when check_violation then null; end;
  begin  -- the primary action event must be its own action
    perform pg_temp.ev(gen_random_uuid(), 98, 'action.invoke', 'interaction', p_action => a);
    raise exception 'action.invoke with foreign action_id accepted';
  exception when check_violation then null; end;
  begin
    perform pg_temp.ev(gen_random_uuid(), 98, 'view.dwell', 'navigation',
      p_refs => '[{"role":"text","sha256":"not-a-hash","bytes":1}]');
    raise exception 'malformed content ref accepted';
  exception when check_violation then null; end;

  -- 5. Cannot write as someone else; cannot update or delete own rows.
  begin
    insert into public.research_events(id, owner_id, contract_version, surface, install_id, research_session_id,
      client_seq, data_type, event_type, occurred_at, app_version, collector_version, consent_version)
    values (gen_random_uuid(), current_setting('rdc.other')::uuid, '1.0.0', 'web', 'install-test-0001',
      gen_random_uuid(), 1, 'interaction', 'action.invoke', now(), '1', 'web-collector/1.0.0', 1);
    raise exception 'insert for another owner accepted';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    update public.research_events set target = 'x' where id = a;
    raise exception 'update allowed';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.research_events where id = a;
    raise exception 'delete allowed';
  exception when insufficient_privilege then null; end;

  -- 6. Content: row only after the object exists; objects only under the caller's prefix.
  perform pg_temp.ev(gen_random_uuid(), 4, 'program.version', 'knowledge_artifact',
    p_refs => jsonb_build_array(jsonb_build_object('role', 'program', 'sha256', sha_whole, 'bytes', 10, 'mime', 'application/json')));
  perform pg_temp.ev(gen_random_uuid(), 5, 'source.import', 'source_input',
    p_refs => jsonb_build_array(jsonb_build_object('role', 'source', 'sha256', sha_big, 'bytes', 9000000, 'mime', 'application/pdf')));
  if (select count(*) from public.research_missing_content where research_session_id = current_setting('rdc.session')::uuid) <> 2 then
    raise exception 'missing content not reported';
  end if;
  begin
    insert into public.research_content(sha256, kind, bytes, stored_bytes, mime, encoding, surface)
    values (sha_whole, 'whole', 10, 30, 'application/json', 'gzip', 'desktop');
    raise exception 'content row accepted before the object was uploaded';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects(bucket_id, name) values ('research-content', current_setting('rdc.other') || '/' || sha_whole);
    raise exception 'upload into another owner prefix accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects(bucket_id, name) values ('research-content', auth.uid()::text || '/notes.txt');
    raise exception 'non content-addressed object name accepted';
  exception when insufficient_privilege then null; end;
  insert into storage.objects(bucket_id, name) values ('research-content', auth.uid()::text || '/' || sha_whole);
  insert into public.research_content(sha256, kind, bytes, stored_bytes, mime, encoding, surface)
  values (sha_whole, 'whole', 10, 30, 'application/json', 'gzip', 'desktop');
  -- Re-recording the same content (another event, another retry) is a no-op.
  insert into public.research_content(sha256, kind, bytes, stored_bytes, mime, encoding, surface)
  values (sha_whole, 'whole', 10, 30, 'application/json', 'gzip', 'desktop')
  on conflict (owner_id, sha256) do nothing;
  -- Objects cannot be overwritten or removed by the user.
  update storage.objects set name = name where bucket_id = 'research-content';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'object update allowed'; end if;
  delete from storage.objects where bucket_id = 'research-content';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'object delete allowed'; end if;

  -- Large content: manifest present but one part missing -> still incomplete.
  insert into storage.objects(bucket_id, name) values ('research-content', auth.uid()::text || '/' || sha_part1),
                                                     ('research-content', auth.uid()::text || '/' || sha_big);
  insert into public.research_content(sha256, kind, bytes, stored_bytes, encoding, surface)
  values (sha_part1, 'part', 4194304, 4000000, 'gzip', 'desktop');
  insert into public.research_content(sha256, kind, bytes, stored_bytes, mime, encoding, parts, surface)
  values (sha_big, 'manifest', 9000000, 300, 'application/pdf', 'gzip', array[sha_part1, sha_part2], 'desktop');
  if (select problem from public.research_missing_content where sha256 = sha_big) is distinct from 'parts_missing' then
    raise exception 'manifest with a missing part reported as complete';
  end if;
  insert into storage.objects(bucket_id, name) values ('research-content', auth.uid()::text || '/' || sha_part2);
  insert into public.research_content(sha256, kind, bytes, stored_bytes, encoding, surface)
  values (sha_part2, 'part', 805696, 700000, 'gzip', 'desktop');
  if exists (select 1 from public.research_missing_content where research_session_id = current_setting('rdc.session')::uuid) then
    raise exception 'content still reported missing after upload';
  end if;

  -- 7. Completeness: seq 1-5 received, client declares 7 captured -> 2 missing, not complete.
  perform pg_temp.ev(gen_random_uuid(), 8, 'session.end', 'session', p_meta => '{"captured_through_seq":7}');
  select * into d from public.research_session_delivery where research_session_id = current_setting('rdc.session')::uuid;
  if d.events_received <> 6 or d.expected_events <> 8 or d.events_missing <> 2 or d.complete then
    raise exception 'delivery view wrong: %', row_to_json(d);
  end if;
  perform pg_temp.ev(gen_random_uuid(), 6, 'view.dwell', 'navigation');
  perform pg_temp.ev(gen_random_uuid(), 7, 'view.dwell', 'navigation');
  select * into d from public.research_session_delivery where research_session_id = current_setting('rdc.session')::uuid;
  if d.events_missing <> 0 or not d.complete then raise exception 'complete session not reported complete: %', row_to_json(d); end if;

  -- 8. Legacy desktop 0.6.6 row shape still accepted.
  insert into public.desktop_events(id, install_id, session_id, project_id, event_type, occurred_at, target,
    duration_ms, metadata, app_version, platform, consent_version)
  values (gen_random_uuid(), 'install-test-0001', gen_random_uuid()::text, null, 'tab.switch', now(), 'program',
    1200, '{}', '0.6.6', 'darwin', 2)
  on conflict (id) do nothing;

  -- 9. Another user sees nothing.
  perform pg_temp.as_user(current_setting('rdc.other'));
  if exists (select 1 from public.research_events) or exists (select 1 from public.research_content)
     or exists (select 1 from public.research_session_delivery) or exists (select 1 from public.research_missing_content)
     or exists (select 1 from storage.objects where bucket_id = 'research-content') then
    raise exception 'another user can read research data';
  end if;
  -- ...and cannot record a content row pointing at the first user's object.
  begin
    insert into public.research_content(sha256, kind, bytes, stored_bytes, encoding, surface)
    values (sha_whole, 'whole', 10, 30, 'gzip', 'web');
    raise exception 'content row for another owner object accepted';
  exception when insufficient_privilege then null; end;
end $$;

rollback;
select 'passed: idempotent retry, server receipt time, seq collision, offline capture, future clock, pointer/keystroke prohibition, credential and path rejection, owner isolation, no update/delete, content-after-object, owner-prefixed content addressing, manifest parts, delivery completeness, legacy desktop rows; all rolled back' as verification;
