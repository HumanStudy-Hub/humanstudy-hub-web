-- Full session replay for HumanStudy Desktop research data (opt-in: usage events AND conversation
-- content consent). The app records the DOM with rrweb, gzips it in chunks and uploads each chunk
-- to the private Storage bucket `desktop-replays` as <owner_id>/<session_id>/<seq>.json.gz, then
-- inserts one row here. Large payloads that do not fit a desktop_events row (program.json versions,
-- written files, long tool output) are stored as <owner_id>/<session_id>/blobs/<uuid>.gz and
-- referenced from the event's metadata. Everything is written and read with the user's own token.
create table if not exists public.desktop_replay_chunks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- Same value as desktop_events.session_id and the replay_session_id of app.session_start.
  session_id text not null check (char_length(session_id) between 8 and 80),
  seq integer not null check (seq >= 0),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  bytes integer not null check (bytes between 1 and 20000000),
  path text not null check (char_length(path) <= 300),
  -- Electron webContents id: chunks of different windows interleave in one session.
  window_id integer,
  app_version text not null check (char_length(app_version) <= 40),
  created_at timestamptz not null default now(),
  unique (owner_id, session_id, seq)
);
create index if not exists desktop_replay_chunks_owner_session_idx
  on public.desktop_replay_chunks(owner_id, session_id, started_at);
alter table public.desktop_replay_chunks enable row level security;
create policy desktop_replay_chunks_insert on public.desktop_replay_chunks for insert to authenticated
  with check (owner_id = auth.uid() and path like auth.uid()::text || '/%');
create policy desktop_replay_chunks_select on public.desktop_replay_chunks for select to authenticated
  using (owner_id = auth.uid());
-- Lets a user withdraw: delete everything they contributed.
create policy desktop_replay_chunks_delete on public.desktop_replay_chunks for delete to authenticated
  using (owner_id = auth.uid());
grant select, insert, delete on public.desktop_replay_chunks to authenticated;

-- Private bucket; chunks are small (gzip, <= ~500 KB raw), blobs up to ~1 MB.
insert into storage.buckets (id, name, public, file_size_limit)
values ('desktop-replays', 'desktop-replays', false, 8388608)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Owners read/write/delete only their own prefix (<owner_id>/...).
create policy desktop_replays_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'desktop-replays' and (storage.foldername(name))[1] = auth.uid()::text);
create policy desktop_replays_select on storage.objects for select to authenticated
  using (bucket_id = 'desktop-replays' and (storage.foldername(name))[1] = auth.uid()::text);
-- Needed for upserts (a retried upload overwrites the same object).
create policy desktop_replays_update on storage.objects for update to authenticated
  using (bucket_id = 'desktop-replays' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'desktop-replays' and (storage.foldername(name))[1] = auth.uid()::text);
create policy desktop_replays_delete on storage.objects for delete to authenticated
  using (bucket_id = 'desktop-replays' and (storage.foldername(name))[1] = auth.uid()::text);
