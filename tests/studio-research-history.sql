-- Run against the configured development project. All rows are rolled back.
begin;
select set_config('studio.test_owner',gen_random_uuid()::text,true),
       set_config('studio.test_other',gen_random_uuid()::text,true);
insert into auth.users(id) values(current_setting('studio.test_owner')::uuid),
                                (current_setting('studio.test_other')::uuid);
select set_config('request.jwt.claim.sub',current_setting('studio.test_owner'),true);
set local role authenticated;
do $$
declare w uuid := gen_random_uuid();
  d jsonb := '{"version":1,"title":"Rollback collection test","model":{"title":"Original"},"sources":[],"annotations":[],"reviewResponses":{},"conversations":[{"id":"chat","draft":"","updatedAt":"before","messages":[]}]}'::jsonb;
begin
  insert into public.studio_workspaces(id,owner_id,title,document) values(w,auth.uid(),'Rollback collection test',d);
  if (select count(*) from public.studio_research_history where workspace_id=w) <> 1 then raise exception 'initial snapshot missing'; end if;
  d:=jsonb_set(jsonb_set(d,'{conversations,0,draft}','"Unsaved drafting"'),'{conversations,0,updatedAt}','"after"');
  perform public.studio_cas_workspace(w,1,d);
  if (select count(*) from public.studio_research_history where workspace_id=w) <> 1 then raise exception 'draft-only save duplicated scientific data'; end if;
  d:=jsonb_set(d,'{model,title}','"Revised hypothesis"');
  perform public.studio_cas_workspace(w,2,d);
  if not exists(select 1 from public.studio_research_history where workspace_id=w and revision=3 and knowledge#>>'{model,title}'='Revised hypothesis') then raise exception 'model change missing'; end if;
  if not exists(select 1 from public.studio_research_history where workspace_id=w and revision=1 and knowledge#>>'{model,title}'='Original') then raise exception 'old model overwritten'; end if;
  d:=jsonb_set(d,'{conversations,0,messages}','[{"id":"message","role":"user","text":"Use repeated measures","modelAnchor":{"entityIds":["design"],"fieldId":"assignment"}}]');
  perform public.studio_cas_workspace(w,3,d);
  d:=jsonb_set(d,'{reviewResponses}','{"assignment-rule":{"answer":"Within participant","respondedAt":"2026-10-07T00:00:00Z"}}');
  d:=jsonb_set(d,'{annotations}','[{"id":"note","comment":"The source specifies paired observations","page":2,"entity":"design"}]');
  perform public.studio_cas_workspace(w,4,d);
  if not exists(select 1 from public.studio_research_history where workspace_id=w and revision=4 and knowledge#>>'{conversations,0,messages,0,text}'='Use repeated measures') then raise exception 'conversation missing'; end if;
  if not exists(select 1 from public.studio_research_history where workspace_id=w and revision=5 and knowledge#>>'{reviewResponses,assignment-rule,answer}'='Within participant' and knowledge#>>'{annotations,0,entity}'='design') then raise exception 'review or annotation missing'; end if;
  if exists(select 1 from public.studio_research_history where workspace_id=w and knowledge#>'{conversations,0,draft}' is not null) then raise exception 'draft text entered research snapshots'; end if;
  d:=jsonb_set(d,'{project}','{"sampleId":"intentional-action","copyState":"preparing"}');
  perform public.studio_cas_workspace(w,5,d);
  if not exists(select 1 from public.studio_research_history where workspace_id=w and revision=6 and knowledge#>>'{origin,sampleId}'='intentional-action') then raise exception 'sample origin missing'; end if;
  d:=jsonb_set(d,'{project,copyState}','"ready"');
  d:=jsonb_set(d,'{project,archived}','true');
  perform public.studio_cas_workspace(w,6,d);
  if exists(select 1 from public.studio_research_history where workspace_id=w and revision=7) then raise exception 'project UI state duplicated scientific data'; end if;
  insert into public.studio_events(id,workspace_id,owner_id,session_id,event_type,occurred_at,workspace_revision,display_revision,metadata)
  values(gen_random_uuid(),w,auth.uid(),'rollback-test','pointer',now(),5,3,'{}');
  begin update public.studio_research_history set knowledge='{}' where workspace_id=w; raise exception 'history update allowed'; exception when insufficient_privilege then null; end;
  begin delete from public.studio_research_history where workspace_id=w; raise exception 'history delete allowed'; exception when insufficient_privilege then null; end;
  begin insert into public.studio_research_history(workspace_id,revision,owner_id,recorded_at,capture_kind,knowledge)
      values(w,100,auth.uid(),now(),'change','{}'); raise exception 'forged revision allowed'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',current_setting('studio.test_other'),true);
  if exists(select 1 from public.studio_research_history where workspace_id=w) then raise exception 'other user can read history'; end if;
  if exists(select 1 from public.studio_events where workspace_id=w) then raise exception 'other user can read events'; end if;
end $$;
rollback;
select 'passed: authenticated CAS, immutable history, old model, chat, review, annotations, draft exclusion, display revision, forgery rejection and user isolation; all test rows rolled back' as verification;
