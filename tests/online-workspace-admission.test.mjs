import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('the shared admission store protects capacity, cancellation, and stale completions', async () => {
  const db = new PGlite();
  const workspace = i => 'try-12345678-1234-4234-a234-' + String(i).padStart(12, '0');
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(await readFile(new URL('../supabase/migrations/20261112080202_online_workspace_admission.sql', import.meta.url), 'utf8'));
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.online_workspace_leases'), /permission denied/);
    await assert.rejects(db.query('select public.online_claim_workspace($1, 60, false, gen_random_uuid())', [workspace(1)]), /permission denied/);
    await db.exec('set role service_role');
    const claim = async (name, stop = false, attempt = stop ? null : randomUUID()) => (await db.query('select public.online_claim_workspace($1, 60, $2, $3) as value', [name, stop, attempt])).rows[0].value;
    const finish = async (name, id, release = false) => (await db.query('select public.online_finish_workspace($1, $2, $3, null) as value', [name, id, release])).rows[0].value;
    const leases = await Promise.all(Array.from({ length: 7 }, (_, index) => claim(workspace(index))));
    assert.equal(leases.filter(Boolean).length, 6);
    assert.equal(leases[6], null);
    const preview = workspace(0).replace('try-', 'try-preview-123456789abc-');
    assert.ok(await claim(preview));
    assert.equal(await claim(workspace(0)), null);
    assert.equal(await claim(workspace(0), true), 'cancelling');
    assert.equal(await finish(workspace(0), leases[0]), false);
    assert.equal(await finish(workspace(0), leases[0], true), true);
    const next = await claim(workspace(6));
    assert.ok(next);
    assert.equal(await finish(workspace(6), leases[0], true), false);
    assert.equal(await finish(workspace(6), next), true);
    const stop = await claim(workspace(6), true);
    assert.ok(stop);
    assert.equal(await finish(workspace(6), stop, true), true);
    const attempt = randomUUID();
    assert.equal(await claim(workspace(8), true, attempt), 'ignored');
    assert.equal(await claim(workspace(8), false, attempt), 'cancelled');
    const first = randomUUID(), second = randomUUID();
    const firstLease = await claim(workspace(8), false, first);
    assert.equal(await finish(workspace(8), firstLease), true);
    const secondLease = await claim(workspace(8), false, second);
    assert.equal(await finish(workspace(8), secondLease), true);
    assert.equal(await claim(workspace(8), true, first), 'ignored');
    assert.equal((await db.query('select attempt from public.online_workspace_leases where workspace = $1', [workspace(8)])).rows[0].attempt, second);
    assert.ok(await claim(workspace(8), true));
  } finally {
    await db.close();
  }
});

test('a configured 50-person cohort reserves 45-minute sessions and rejects excess claims', async () => {
  const db = new PGlite();
  const workspace = i => 'try-aaaaaaaa-aaaa-4aaa-aaaa-' + String(i).padStart(12, '0');
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(await readFile(new URL('../supabase/migrations/20261112080202_online_workspace_admission.sql', import.meta.url), 'utf8'));
    // A deployment operator changes compute capacity; application credentials cannot do so.
    await db.exec("update public.online_workspace_capacity set max_running=50 where scope='production'; set role service_role;");
    await assert.rejects(db.exec("update public.online_workspace_capacity set max_running=100"), /permission denied/);
    const claim = async name => (await db.query('select public.online_claim_workspace($1, 2700, false, $2) as value', [name, randomUUID()])).rows[0].value;
    const finish = async (name, id, release) => (await db.query('select public.online_finish_workspace($1, $2, $3, null) as value', [name, id, release])).rows[0].value;
    // PGlite queues these calls; this verifies SQL admission semantics, not a multi-connection load test.
    const attempts = await Promise.all(Array.from({ length: 100 }, (_, i) => claim(workspace(i))));
    assert.equal(attempts.filter(Boolean).length, 50);
    assert.equal((await db.query('select count(*)::integer as n from public.online_workspace_leases')).rows[0].n, 50);
    const timing = (await db.query('select min(extract(epoch from reserved_until-clock_timestamp())) as seconds from public.online_workspace_leases')).rows[0];
    assert.ok(Number(timing.seconds) > 2700 && Number(timing.seconds) <= 2880);
    assert.equal(await claim(workspace(0)), null, 'duplicate in-flight launch cannot create another operation');
    assert.equal(await finish(workspace(0), attempts[0], false), true);
    const reopened = await claim(workspace(0));
    assert.ok(reopened, 'existing admitted account can reopen at full capacity');
    assert.equal(await finish(workspace(0), attempts[0], true), false, 'stale completion cannot release newer ownership');
    assert.equal(await finish(workspace(0), reopened, true), true);
    const refill = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(workspace(100+i))));
    assert.equal(refill.filter(Boolean).length, 1, 'one released slot admits only one replacement');
    const preview = workspace(0).replace('try-', 'try-preview-123456789abc-');
    assert.ok(await claim(preview), 'preview uses its separate six-person scope');
  } finally { await db.close(); }
});
