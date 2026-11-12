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
