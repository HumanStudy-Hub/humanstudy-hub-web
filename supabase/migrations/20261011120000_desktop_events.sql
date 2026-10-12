-- Research telemetry from HumanStudy Desktop. Desktop projects are local folders, so events
-- are keyed by an anonymous per-install id and a project id the app generates, not by a
-- studio workspace. Rows are written by the signed-in user with their own token (RLS), only
-- after they consent in the app; consent changes are recorded as events too.
create table if not exists public.desktop_events (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  install_id text not null check (char_length(install_id) between 8 and 80),
  session_id text not null check (char_length(session_id) between 8 and 80),
  project_id text check (project_id is null or char_length(project_id) between 8 and 80),
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  occurred_at timestamptz not null,
  target text check (target is null or char_length(target) <= 160),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 86400000),
  metadata jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 16384),
  app_version text not null check (char_length(app_version) <= 40),
  platform text not null check (platform in ('darwin', 'win32', 'linux')),
  consent_version integer not null check (consent_version > 0),
  created_at timestamptz not null default now()
);
create index if not exists desktop_events_owner_at_idx on public.desktop_events(owner_id, occurred_at);
create index if not exists desktop_events_type_at_idx on public.desktop_events(event_type, occurred_at);
alter table public.desktop_events enable row level security;
create policy desktop_events_insert on public.desktop_events for insert to authenticated
  with check (owner_id = auth.uid() and occurred_at <= now() + interval '5 minutes' and occurred_at >= now() - interval '30 days');
create policy desktop_events_select on public.desktop_events for select to authenticated
  using (owner_id = auth.uid());
-- Lets a user withdraw: delete everything they contributed.
create policy desktop_events_delete on public.desktop_events for delete to authenticated
  using (owner_id = auth.uid());
grant select, insert, delete on public.desktop_events to authenticated;
