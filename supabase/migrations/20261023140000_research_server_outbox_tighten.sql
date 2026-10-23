-- Research collection T08 follow-up: tighten owner-written outbox rows. NOT APPLIED.
-- Review, validate on a branch database (or a rolled-back session), then apply with owner approval.
--
-- Why: studio_cas_workspace_research runs as the calling user (security invoker), so the
-- authenticated role must keep INSERT on research_server_outbox, and an owner can therefore write
-- an outbox row with any payload. The scheduled drain delivers as service_role, which bypasses the
-- research_events / research_content insert policies. The primary defence is in the drain
-- (lib/research-data/server-outbox.ts validateOutboxPayload: every row is re-checked exactly as the
-- insert policies and table checks would, and a failing batch is rejected whole). This migration
-- adds the cheap structural part of the same rules at insert time, as defence in depth:
--   * the row's project, when set, is a workspace the caller owns;
--   * event_count / content_count match the payload;
--   * every payload event is a web event of this batch's research session and names no other owner.
-- Tightening only: no column, function or grant is added; rows the server producers write today
-- (lib/research-data/server-producer.ts buildServerBatch) satisfy it unchanged.
--
-- Not done here, deliberately: revoking the owner's direct INSERT. It is required by the invoker
-- RPC; making the RPC security definer would move the workspace CAS outside RLS, which is a larger
-- change than this fix needs. An owner who forges a row gains nothing over inserting into
-- research_events directly under RLS, because the drain refuses anything RLS would refuse.

alter policy research_server_outbox_insert on public.research_server_outbox
  with check (
    owner_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from public.studio_workspaces w
      where w.id::text = research_server_outbox.project_id and w.owner_id = (select auth.uid())))
    and jsonb_array_length(payload->'events') = event_count
    and jsonb_array_length(payload->'content') = content_count
    and not exists (
      select 1 from jsonb_array_elements(payload->'events') as e(ev)
      where jsonb_typeof(e.ev) <> 'object'
         or e.ev->>'surface' is distinct from 'web'
         or e.ev->>'research_session_id' is distinct from research_server_outbox.id::text
         or (e.ev ? 'owner_id' and e.ev->>'owner_id' is distinct from (select auth.uid())::text))
  );
