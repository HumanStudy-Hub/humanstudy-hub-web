import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Project sync storage (supabase/migrations/*_project_sync.sql): owner-only rows and objects, revisions that move
// forward by exactly one, server-owned soft-delete time, and rows removable only after 30 days.
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const digest = c => c.repeat(64);

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema auth, storage to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    grant select, insert, update, delete on storage.objects to authenticated;
    alter table storage.objects enable row level security;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20261116120000_project_sync.sql', import.meta.url), 'utf8'));
  await db.query('insert into auth.users values ($1), ($2)', [alice, bob]);
  return db;
}
const as = async (db, user) => db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ''}', false); set role ${user ? 'authenticated' : 'anon'};`);
const insert = (db, user, project, revision = 1) => db.query(
  'insert into public.project_sync (user_id, project_id, name, revision, manifest_sha256, size_bytes, file_count, updated_by_device) values ($1, $2, $3, $4, $5, 10, 1, $6)',
  [user, project, 'Anchoring', revision, digest('a'), 'Laptop']);

test('only the owner reads and writes a project row; revisions move forward by exactly one', async () => {
  const db = await database();
  try {
    const bucket = (await db.query("select public, file_size_limit from storage.buckets where id = 'projects'")).rows[0];
    assert.equal(bucket.public, false, 'a private bucket');
    await as(db, alice);
    await assert.rejects(insert(db, alice, 'proj-00000001', 2), /revision 1/);
    await insert(db, alice, 'proj-00000001');
    await assert.rejects(insert(db, alice, 'proj-00000001'), /duplicate key/, 'a second device creating the same project loses: the app keeps both');
    await assert.rejects(insert(db, bob, 'proj-00000002'), /row-level security/, 'nobody writes rows for someone else');
    await assert.rejects(db.query("update public.project_sync set revision = 3, manifest_sha256 = $1 where project_id = 'proj-00000001'", [digest('b')]), /exactly one/);
    await assert.rejects(db.query("update public.project_sync set manifest_sha256 = $1 where project_id = 'proj-00000001'", [digest('b')]), /new revision/);
    // Compare-and-set: the push based on revision 1 wins, a second push based on revision 1 updates nothing.
    const win = await db.query("update public.project_sync set revision = 2, manifest_sha256 = $1 where project_id = 'proj-00000001' and revision = 1 returning revision", [digest('b')]);
    assert.equal(Number(win.rows[0].revision), 2);
    const lose = await db.query("update public.project_sync set revision = 2, manifest_sha256 = $1 where project_id = 'proj-00000001' and revision = 1 returning revision", [digest('c')]);
    assert.equal(lose.rows.length, 0);
    await assert.rejects(db.query("update public.project_sync set user_id = $1 where project_id = 'proj-00000001'", [bob]), /permission denied|row-level security/);
    await as(db, bob);
    assert.equal((await db.query('select * from public.project_sync')).rows.length, 0, 'another account sees nothing');
    const u = await db.query("update public.project_sync set name = 'mine now' where project_id = 'proj-00000001' returning 1");
    assert.equal(u.rows.length, 0);
    await as(db, null);
    await assert.rejects(db.query('select * from public.project_sync'), /permission denied/);
  } finally {
    await db.close();
  }
});

test('soft delete: the server sets the time, a deleted project takes no revisions, and only 30-day-old deletions are removed', async () => {
  const db = await database();
  try {
    await as(db, alice);
    await insert(db, alice, 'proj-00000003');
    await db.query("update public.project_sync set deleted_at = '2001-01-01T00:00:00Z' where project_id = 'proj-00000003'");
    const row = (await db.query("select deleted_at from public.project_sync where project_id = 'proj-00000003'")).rows[0];
    assert.ok(Date.now() - new Date(row.deleted_at).getTime() < 60_000, 'a device clock cannot backdate a deletion');
    await assert.rejects(db.query("update public.project_sync set revision = 2, manifest_sha256 = $1 where project_id = 'proj-00000003'", [digest('d')]), /restore it first/);
    const early = await db.query("delete from public.project_sync where project_id = 'proj-00000003' returning 1");
    assert.equal(early.rows.length, 0, 'restorable for 30 days');
    await db.query("update public.project_sync set deleted_at = null where project_id = 'proj-00000003'");
    await db.query("update public.project_sync set revision = 2, manifest_sha256 = $1 where project_id = 'proj-00000003'", [digest('d')]);
    // An operator ages the deletion (the trigger would otherwise stamp now()).
    await db.exec(`reset role; alter table public.project_sync disable trigger project_sync_guard;
      update public.project_sync set deleted_at = now() - interval '31 days' where project_id = 'proj-00000003';
      alter table public.project_sync enable trigger project_sync_guard;`);
    await as(db, alice);
    const late = await db.query("delete from public.project_sync where project_id = 'proj-00000003' returning 1");
    assert.equal(late.rows.length, 1);
  } finally {
    await db.close();
  }
});

test('project files: each account reaches only its own folder in the private bucket', async () => {
  const db = await database();
  try {
    await as(db, alice);
    await db.query("insert into storage.objects (bucket_id, name) values ('projects', $1)", [`${alice}/proj-00000001/blobs/${digest('a')}`]);
    await assert.rejects(db.query("insert into storage.objects (bucket_id, name) values ('projects', $1)", [`${bob}/proj-00000001/blobs/${digest('a')}`]), /row-level security/);
    await as(db, bob);
    assert.equal((await db.query("select * from storage.objects where bucket_id = 'projects'")).rows.length, 0);
    assert.equal((await db.query("delete from storage.objects where bucket_id = 'projects' returning 1")).rows.length, 0);
    await as(db, alice);
    assert.equal((await db.query("select * from storage.objects where bucket_id = 'projects'")).rows.length, 1);
    assert.equal((await db.query("delete from storage.objects where bucket_id = 'projects' returning 1")).rows.length, 1);
  } finally {
    await db.close();
  }
});
