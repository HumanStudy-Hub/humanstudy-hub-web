import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// supabase/migrations/20261120120000_online_visit_id.sql on top of the research contract it extends.
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const visit = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const workspace = 'try-' + alice;
const migrations = new URL('../supabase/migrations/', import.meta.url);

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema auth, storage to authenticated, anon, service_role;
    grant execute on function auth.uid() to authenticated, anon;
  `);
  const files = (await readdir(migrations)).filter(name => name < '20261024' || name.endsWith('_online_visit_id.sql')).sort();
  for (const file of files) await db.exec(await readFile(new URL(file, migrations), 'utf8'));
  await db.query('insert into auth.users values ($1), ($2)', [alice, bob]);
  return db;
}
const as = (db, user) => db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ''}', false); set role ${user ? 'authenticated' : 'service_role'};`);
const value = async (db, sql, params) => (await db.query(sql, params)).rows[0]?.value;

test('runtime rows carry visit_id and the delivery view exposes it per session', async () => {
  const db = await database();
  try {
    const session = '44444444-4444-4444-8444-444444444444';
    await db.query(`insert into public.research_events (id, owner_id, contract_version, surface, install_id, research_session_id,
        client_seq, data_type, event_type, occurred_at, app_version, collector_version, consent_version, visit_id)
      values (gen_random_uuid(), $1, '1.1.0', 'web', 'browser-0001', $2, 1, 'session', 'session.start', now(), '0.8.4', 'web/1', 3, $3),
             (gen_random_uuid(), $1, '1.1.0', 'web', 'browser-0001', $2, 2, 'session', 'session.end', now(), '0.8.4', 'web/1', 3, null)`,
    [alice, session, visit(1)]);
    const row = (await db.query('select visit_id, events_received, complete from public.research_session_delivery')).rows[0];
    assert.equal(row.visit_id, visit(1));
    assert.equal(Number(row.events_received), 2);
    const columns = (await db.query(`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'research_session_delivery' order by ordinal_position`)).rows.map(r => r.column_name);
    assert.equal(columns.at(-1), 'visit_id', 'appended, so the replaced view keeps its existing columns');
    assert.ok(columns.includes('complete'));
    assert.ok((await db.query(`select 1 from pg_indexes where indexname = 'research_events_owner_visit_idx'`)).rows.length);
  } finally {
    await db.close();
  }
});

test('Hub visits: service role writes, owners read only their own, terminal reason recorded once', async () => {
  const db = await database();
  try {
    await as(db, alice);
    await assert.rejects(db.query('select public.online_visit_begin($1, $2, $3, null)', [visit(1), alice, workspace]), /permission denied/);
    await assert.rejects(db.query(`insert into public.online_workspace_visits (id, owner_id, workspace) values ($1, $2, $3)`,
      [visit(1), alice, workspace]), /permission denied/);

    await as(db, null);
    const past = new Date(Date.now() - 60_000).toISOString(), future = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal(await value(db, 'select public.online_visit_begin($1, $2, $3, $4) as value', [visit(1), alice, workspace, past]), true);
    // A reconnect to the same visit is idempotent and keeps the later provider expiry.
    assert.equal(await value(db, 'select public.online_visit_begin($1, $2, $3, $4) as value', [visit(1), alice, workspace, null]), true);
    assert.equal(await value(db, 'select count(*)::int as value from public.online_workspace_visits'), 1);
    // A different account cannot claim an existing visit id.
    assert.equal(await value(db, 'select public.online_visit_begin($1, $2, $3, null) as value', [visit(1), bob, 'try-' + bob]), false);
    // A fresh visit closes the earlier one that never ended: its provider limit passed, so timeout.
    assert.equal(await value(db, 'select public.online_visit_begin($1, $2, $3, $4) as value', [visit(2), alice, workspace, future]), true);
    let first = (await db.query('select end_reason, ended_at from public.online_workspace_visits where id = $1', [visit(1)])).rows[0];
    assert.equal(first.end_reason, 'timeout');
    assert.equal(first.ended_at.toISOString(), past);
    // Another fresh visit before the limit: the earlier end is unknown.
    await db.query('select public.online_visit_begin($1, $2, $3, $4)', [visit(3), alice, workspace, future]);
    assert.equal(await value(db, 'select end_reason as value from public.online_workspace_visits where id = $1', [visit(2)]), 'unknown');

    assert.equal(await value(db, `select public.online_visit_end($1, null, 'user_stop') as value`, [workspace]), true);
    assert.equal(await value(db, `select public.online_visit_end($1, null, 'timeout') as value`, [workspace]), false, 'recorded once');
    assert.equal(await value(db, 'select end_reason as value from public.online_workspace_visits where id = $1', [visit(3)]), 'user_stop');
    await db.query('select public.online_visit_begin($1, $2, $3, null)', [visit(4), alice, workspace]);
    await assert.rejects(db.query(`select public.online_visit_end($1, $2, 'closed')`, [workspace, visit(4)]), /check constraint/);
    assert.equal(await value(db, `select public.online_visit_end($1, $2, 'crash') as value`, [workspace, visit(4)]), true);
    await db.query('select public.online_visit_begin($1, $2, $3, null)', [visit(5), bob, 'try-' + bob]);

    await as(db, alice);
    assert.deepEqual((await db.query('select id from public.online_workspace_visits order by id')).rows.map(r => r.id), [1, 2, 3, 4].map(visit));
    assert.equal((await db.query(`update public.online_workspace_visits set end_reason = 'timeout' returning 1`).catch(e => e)).message?.includes('permission denied'), true);
    await as(db, bob);
    assert.deepEqual((await db.query('select id from public.online_workspace_visits')).rows.map(r => r.id), [visit(5)]);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.online_workspace_visits'), /permission denied/);
  } finally {
    await db.close();
  }
});
