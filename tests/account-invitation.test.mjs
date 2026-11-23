import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)((n) => deps[n] ?? require(n), m, m.exports); return m.exports;
}
const user = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', model = 'anthropic/claude-haiku-5.5';
const promoMatches = code => typeof code === 'string' && code.trim().toLowerCase() === 'humanstudy';
const lib = load('lib/account-invitation.ts', { 'server-only': {}, './desktop-access': { promoMatches }, './try-online-config': { tryServiceKey: () => 'service-fixture' } });

function withSupabase(t) {
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'https://db.test';
  t.after(() => { if (saved === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved; });
}

test('an account is invited by its sign-up code or by an existing production grant row', async t => {
  withSupabase(t);
  const requests = [];
  let rows = [], metadata = {};
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET', auth: init.headers.Authorization });
    if (String(url).includes('/auth/v1/admin/users/')) return Response.json({ id: user, user_metadata: metadata });
    return Response.json(rows);
  });
  assert.equal(await lib.accountInvited({ id: user, user_metadata: { invitation_code: 'HumanStudy' } }), true);
  assert.equal(requests.length, 0, 'signup metadata from the verified session needs no service call');
  assert.equal(await lib.accountInvited({ id: user, user_metadata: { invitation_code: 'retired' } }), false);
  assert.match(requests.at(-1).url, /\/rest\/v1\/online_dev_model_budget\?select=budget_key&budget_key=eq\.production%3Aaccount%3A11111111-1111-4111-8111-111111111111&revoked=is\.false$/, 'a revoked grant does not count as an invitation');
  assert.equal(requests.at(-1).auth, 'Bearer service-fixture');
  rows = [{ budget_key: `production:account:${user}` }];
  assert.equal(await lib.accountInvited({ id: user, user_metadata: {} }), true, 'an earlier redemption is durable');
  rows = []; metadata = { invitation_code: 'humanstudy' };
  assert.equal(await lib.accountInvited({ id: user }), true, 'without session metadata the admin record is read');
  assert.equal(await lib.accountInvited({ id: 'not-a-uuid', user_metadata: { invitation_code: 'humanstudy' } }), false);
});

test('service failures fail closed and only valid codes are remembered', async t => {
  withSupabase(t);
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'PUT') { writes.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({}); }
    return new Response('nope', { status: 500 });
  });
  assert.equal(await lib.accountInvited({ id: user }), false);
  await lib.rememberInvitation(user, 'wrong');
  await lib.rememberInvitation(user, ' HumanStudy ');
  assert.deepEqual(writes, [{ url: `https://db.test/auth/v1/admin/users/${user}`, body: { user_metadata: { invitation_code: 'HumanStudy' } } }]);
});

test('invitation migrations preserve spending, top up once and admit Flash for existing and new grants', async () => {
  const db = new PGlite();
  const third = '33333333-3333-4333-8333-333333333333', fourth = '44444444-4444-4444-8444-444444444444';
  const migration = suffix => fs.readFileSync(new URL('../supabase/migrations/' + fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).find(name => name.endsWith(suffix)), import.meta.url), 'utf8');
  const read = () => db.query(`select budget_key,remaining_microusd,remaining_requests,models from public.online_dev_model_budget order by budget_key`).then(r => r.rows);
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key, email_confirmed_at timestamptz, deleted_at timestamptz, is_anonymous boolean);`);
    for (const suffix of ['_online_dev_model_budget.sql', '_hosted_account_model_allowances.sql', '_production_invitation_model_allowance.sql']) await db.exec(migration(suffix));
    await db.query('insert into auth.users values($1,now(),null,false),($2,now(),null,false),($3,now(),null,false),($4,now(),null,false)', [user, other, third, fourth]);
    await db.query(`insert into public.online_dev_model_budget
      (budget_key,environment,scope,singleton,user_id,models,expires_at,remaining_microusd,remaining_requests)
      values ('production:pool','production','pool',null,null,array[$1],now()+interval '7 days',50000000,1000)`, [model]);
    const grant = id => db.query('select public.online_grant_production_invitation($1) as ok', [id]).then(r => r.rows[0].ok);
    await db.exec('set role service_role');
    for (const id of [user, other, third]) assert.equal(await grant(id), true);
    await db.exec('reset role');
    // user: partly spent; other: revoked; third: expired.
    await db.query(`update public.online_dev_model_budget set remaining_microusd=1200000,remaining_requests=37 where budget_key=$1`, [`production:account:${user}`]);
    await db.query(`update public.online_dev_model_budget set revoked=true where budget_key=$1`, [`production:account:${other}`]);
    await db.query(`update public.online_dev_model_budget set expires_at=now()-interval '1 second' where budget_key=$1`, [`production:account:${third}`]);
    const v2 = migration('_invitation_allowance_v2.sql');
    await db.exec(v2);
    await db.exec(v2.slice(v2.indexOf('with topped as'))); // a repeated top-up is a no-op
    await db.exec('set role service_role');
    assert.equal(await grant(fourth), true);
    assert.equal(await grant(user), true, 'an existing grant is never renewed');
    await db.exec('reset role');
    assert.deepEqual(await read(), [
      { budget_key: `production:account:${user}`, remaining_microusd: 6200000, remaining_requests: 437, models: [model] },
      { budget_key: `production:account:${other}`, remaining_microusd: 5000000, remaining_requests: 100, models: [model] },
      { budget_key: `production:account:${third}`, remaining_microusd: 5000000, remaining_requests: 100, models: [model] },
      { budget_key: `production:account:${fourth}`, remaining_microusd: 10000000, remaining_requests: 500, models: [model] },
      { budget_key: 'production:pool', remaining_microusd: 50000000, remaining_requests: 1000, models: [model] },
    ]);
    // A spent v2 grant is recorded in the ledger and is not topped up by a repeated run.
    await db.query(`update public.online_dev_model_budget set remaining_microusd=100,remaining_requests=3 where budget_key=$1`, [`production:account:${fourth}`]);
    await db.exec(v2.slice(v2.indexOf('with topped as')));
    assert.deepEqual((await read()).find(row => row.budget_key.endsWith(fourth)), { budget_key: `production:account:${fourth}`, remaining_microusd: 100, remaining_requests: 3, models: [model] });
    await db.exec('set role service_role');
    await assert.rejects(db.query('select * from hosted_quota_private.invitation_allowance_v2'), /permission denied/);
    await db.exec('reset role');

    const flash = 'deepseek/deepseek-v4.1-flash';
    const v3 = migration('_invitation_allowance_v3.sql');
    const fresh = '55555555-5555-4555-8555-555555555555';
    await db.exec(v3);
    await db.query('insert into auth.users values($1,now(),null,false)', [fresh]);
    await db.exec('set role service_role');
    assert.equal(await grant(fresh), true);
    const balances = await read();
    assert.deepEqual(balances.map(b => [b.remaining_microusd, b.remaining_requests]), [
      [6200000, 2937], [5000000, 100], [5000000, 2600], [100, 2503], [10000000, 3000], [50000000, 150000],
    ]);
    for (const b of balances) assert.deepEqual(b.models, [model, flash]);
    const reserve = id => db.query(
      "select public.online_reserve_account_model_budget(gen_random_uuid(),'production',$1,$2,1) as ok", [id, flash],
    ).then(r => r.rows[0].ok);
    assert.equal(await reserve(user), true);
    assert.equal(await reserve(fresh), true);
    assert.equal(await reserve(other), false);
    assert.equal(await reserve(third), false);
    await assert.rejects(db.query('select * from hosted_quota_private.invitation_allowance_v3'), /permission denied/);
    await db.exec('reset role');
    const spent = await read();
    await db.exec(v3);
    assert.deepEqual(await read(), spent);
  } finally { await db.close(); }
});
