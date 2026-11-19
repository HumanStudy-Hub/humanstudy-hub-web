-- Project sync: every HumanStudy Hub project (desktop app and online workspace, which run the same code) stored
-- privately under its owner's account, private files and chats included, like Claude or Codex. Only the owner can
-- read or write it. Privacy and copyright checks apply to publishing to the community, not here.
--
-- The app (humanstudy-desktop app/src/main/project-sync*.ts) talks to Supabase directly with the user's own access
-- token and the publishable key, as research data already does; no service key is involved.
--
-- Storage: private bucket `projects`, objects under <auth user id>/<project id>/
--   blobs/<sha256>            one file's bytes, stored once per content hash (a push uploads only what changed)
--   manifests/<digest>.json   the study-transfer manifest (format humanstudy-study): every file's path, size, SHA-256
-- Table public.project_sync: one row per project, holding the current revision. A push is a compare-and-set
-- (PATCH ... where revision = base) that must raise the revision by exactly one; when both sides changed, the app
-- keeps both by making the incoming version a new project. Deletion is soft (deleted_at, set by the server),
-- restorable for 30 days; after that the owner's app removes the objects and the row.

create table if not exists public.project_sync (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  project_id text not null check (project_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  name text not null default '' check (char_length(name) <= 200),
  revision bigint not null check (revision >= 1),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  -- 500 MB: the app's project cap (MAX_PROJECT_BYTES).
  size_bytes bigint not null default 0 check (size_bytes between 0 and 500000000),
  file_count integer not null default 0 check (file_count between 0 and 20000),
  updated_at timestamptz not null default now(),
  updated_by_device text not null default '' check (char_length(updated_by_device) <= 80),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

-- Revisions only move forward by one, identity never changes, and the server owns the timestamps (a device with a
-- wrong clock can neither shorten the 30 days nor reorder the list).
create or replace function public.project_sync_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then
      raise exception 'a new project starts at revision 1' using errcode = '23514';
    end if;
    new.deleted_at := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if new.user_id <> old.user_id or new.project_id <> old.project_id or new.created_at <> old.created_at then
    raise exception 'a project''s identity cannot change' using errcode = '23514';
  end if;
  if new.revision <> old.revision then
    if new.revision <> old.revision + 1 then
      raise exception 'revision must increase by exactly one' using errcode = '23514';
    end if;
    if old.deleted_at is not null and new.deleted_at is not null then
      raise exception 'a deleted project takes no new revisions; restore it first' using errcode = '23514';
    end if;
  elsif new.manifest_sha256 <> old.manifest_sha256 or new.size_bytes <> old.size_bytes or new.file_count <> old.file_count then
    raise exception 'a new snapshot needs a new revision' using errcode = '23514';
  end if;
  if new.deleted_at is not null then
    new.deleted_at := case when old.deleted_at is null then now() else old.deleted_at end;
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists project_sync_guard on public.project_sync;
create trigger project_sync_guard
  before insert or update on public.project_sync
  for each row execute function public.project_sync_guard();

alter table public.project_sync enable row level security;
revoke all on public.project_sync from public, anon, authenticated;
grant select on public.project_sync to authenticated;
grant insert (user_id, project_id, name, revision, manifest_sha256, size_bytes, file_count, updated_by_device)
  on public.project_sync to authenticated;
grant update (name, revision, manifest_sha256, size_bytes, file_count, updated_by_device, deleted_at)
  on public.project_sync to authenticated;
grant delete on public.project_sync to authenticated;
grant all on public.project_sync to service_role;
revoke all on function public.project_sync_guard() from public, anon, authenticated;

drop policy if exists project_sync_select_own on public.project_sync;
create policy project_sync_select_own on public.project_sync for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists project_sync_insert_own on public.project_sync;
create policy project_sync_insert_own on public.project_sync for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists project_sync_update_own on public.project_sync;
create policy project_sync_update_own on public.project_sync for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
-- A row is removed only after its 30 days as a restorable deletion.
drop policy if exists project_sync_delete_expired on public.project_sync;
create policy project_sync_delete_expired on public.project_sync for delete to authenticated
  using ((select auth.uid()) = user_id and deleted_at is not null and deleted_at < now() - interval '30 days');

create index if not exists project_sync_owner_updated on public.project_sync (user_id, updated_at desc);
comment on table public.project_sync is 'One row per synced HumanStudy Hub project: current revision, manifest digest, size, last device, soft delete. Files live in the private Storage bucket "projects" under <user_id>/<project_id>/. Owner-only.';

-- Private bucket. 500 MiB per object (one file of a project; the project itself is capped at 500 MB by the app).
-- The project's global Storage upload limit must be at least this for large files to sync (Free plan: 50 MB).
insert into storage.buckets (id, name, public, file_size_limit)
values ('projects', 'projects', false, 524288000)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Owners read, write and delete only under their own folder (<user_id>/...).
drop policy if exists projects_owner_insert on storage.objects;
create policy projects_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'projects' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists projects_owner_select on storage.objects;
create policy projects_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'projects' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- Needed for upserts (a manifest written again with the same digest).
drop policy if exists projects_owner_update on storage.objects;
create policy projects_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'projects' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'projects' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- Removing files no revision uses any more, and a project's files after its 30 days as a deletion.
drop policy if exists projects_owner_delete on storage.objects;
create policy projects_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'projects' and (storage.foldername(name))[1] = (select auth.uid())::text);

notify pgrst, 'reload schema';
