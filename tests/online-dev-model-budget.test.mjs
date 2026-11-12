import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, dependencies = {}) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => dependencies[name] ?? require(name), loaded, loaded.exports);
  return loaded.exports;
}

const model = 'anthropic/claude-haiku-5.5';
const user = '11111111-1111-4111-8111-111111111111';
const lib = load('lib/try-dev-model-budget.ts', { './try-online-config': { tryServiceKey: () => 'fixture-service' } });
const prompt = {
  model, messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(415_758), cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
  max_completion_tokens: 16_384, reasoning: { effort: 'medium', max_tokens: 4096 }, temperature: 0.3, top_p: 0.9,
  parallel_tool_calls: false, tool_choice: { type: 'function', function: { name: 'save_file' } },
  tools: [{ type: 'function', function: { name: 'save_file', description: 'Save file', parameters: { type: 'object' }, strict: true } }],
  stream: true,
};

test('dev reservation preserves large text, output and supported generation settings while pinning provider routing', () => {
  const bounded = lib.boundedDevCompletion(prompt, user);
  const sent = JSON.parse(bounded.wire);
  for (const key of ['messages', 'reasoning', 'temperature', 'top_p', 'parallel_tool_calls', 'tool_choice', 'tools', 'stream']) {
    assert.deepEqual(sent[key], prompt[key]);
  }
  assert.equal(sent.max_tokens, prompt.max_completion_tokens);
  assert.equal(sent.provider.allow_fallbacks, false);
  assert.equal(sent.provider.require_parameters, true);
  assert.deepEqual(sent.provider.max_price, { prompt: 1, completion: 2.5, request: 0 });
  for (const key of ['plugins', 'models', 'n']) assert.equal(sent[key], undefined);
  assert.equal(bounded.reservationMicrousd, Math.ceil(2 * (Buffer.byteLength(bounded.wire) + 4096 + 16_384 * 2.5)));
  assert.equal(lib.boundedDevCompletion({ ...prompt, max_completion_tokens: 32_768 }, user).model, model);
});

test('dev reservation rejects oversized input, multimodal content and invalid output without clipping', () => {
  for (const patch of [
    { max_completion_tokens: 32_769 },
    { plugins: [{ id: 'web' }] },
    { models: ['other/model'] },
    { provider: { allow_fallbacks: true } },
    { n: 20 },
    { max_tokens: 100 },
    { reasoning: { max_tokens: 20_000 } },
    { temperature: 3 },
    { tool_choice: 'execute' },
    { model: 'unpriced/model' },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test' } }] }] },
    { messages: [{ role: 'user', content: 'x'.repeat(4_000_001) }] },
  ]) assert.equal(lib.boundedDevCompletion({ ...prompt, ...patch }, user), null);
});

test('dev model route forwards only after reservation; production forwards its existing payload', async t => {
  const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, VERCEL_ENV: process.env.VERCEL_ENV };
  process.env.VERCEL_ENV = 'preview';
  process.env.OPENROUTER_API_KEY = 'fixture-provider';
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let dev = true, allowed = false, reserves = 0, forwards = 0;
  const route = load('app/api/desktop/v1/chat/completions/route.ts', {
    '@/lib/hosted-model-quota': { hostedQuotaEnvironment: () => null },
    '@/lib/provider-usage-settlement': load('lib/provider-usage-settlement.ts'),
    '@/lib/bounded-request': load('lib/bounded-request.ts'),
    'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
    '@/lib/desktop-access': { bearer: () => 'fixture', verifyDesktopKey: () => user, DESKTOP_MODELS: [model] },
    '@/lib/try-dev-models': { devModelAccess: () => true, isDevPreview: () => dev },
    '@/lib/try-dev-model-budget': {
      boundedDevCompletion: lib.boundedDevCompletion,
      reserveDevCompletion: async (account, selected, amount) => {
        assert.equal(account, user);
        assert.equal(selected, model);
        assert.ok(amount > 0);
        reserves++;
        return allowed;
      },
    },
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    forwards++;
    const wire = JSON.parse(init.body);
    assert.equal(wire.provider !== undefined, dev);
    assert.equal(wire.user, 'hsd:' + user);
    return Response.json({ ok: true });
  });
  t.mock.method(console, 'log', () => {});
  const call = () => route.POST(new Request('https://example.test/api/desktop/v1/chat/completions', {
    method: 'POST', body: JSON.stringify(prompt),
  }));
  assert.equal((await call()).status, 429);
  assert.equal(forwards, 0);
  allowed = true;
  assert.equal((await call()).status, 200);
  assert.equal(reserves, 2);
  assert.equal(forwards, 1);
  dev = false;
  assert.equal((await call()).status, 503);
  assert.equal(forwards, 1);
  process.env.VERCEL_ENV = 'production';
  assert.equal((await call()).status, 200);
  assert.equal(reserves, 2);
  assert.equal(forwards, 2);
});

test('database admits one account and only the requests its singleton budget can debit', async () => {
  const db = new PGlite();
  const other = '22222222-2222-4222-8222-222222222222';
  const rpc = (id, selected, amount) => db.query(
    'select public.online_reserve_dev_model_budget($1, $2, $3) as value', [id, selected, amount],
  ).then(result => result.rows[0].value);
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users (id uuid primary key);');
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261112181142_online_dev_model_budget.sql', import.meta.url), 'utf8'));
    await db.query('insert into auth.users values ($1), ($2)', [user, other]);
    await db.exec('set role service_role');
    assert.equal(await rpc(user, model, 10), false);
    await assert.rejects(db.query('insert into public.online_dev_model_budget values (true,$1,array[$2],now(),1,1)', [user, model]), /permission denied/);
    await db.exec('reset role');
    await db.query("insert into public.online_dev_model_budget values (true,$1,array[$2],now()+interval '1 hour',125,3)", [user, model]);
    await db.exec('set role authenticated');
    await assert.rejects(rpc(user, model, 10), /permission denied/);
    await assert.rejects(db.query('select * from public.online_dev_model_budget'), /permission denied/);
    await db.exec('set role service_role');
    assert.equal(await rpc(other, model, 10), false);
    assert.equal(await rpc(user, 'other/model', 10), false);
    assert.equal(await rpc(user, model, 0), false);
    const allocations = await Promise.all(Array.from({ length: 5 }, () => rpc(user, model, 50)));
    assert.equal(allocations.filter(Boolean).length, 2);
    assert.equal(await rpc(user, model, 20), true);
    assert.equal(await rpc(user, model, 1), false);
    assert.deepEqual((await db.query('select remaining_microusd, remaining_requests from public.online_dev_model_budget')).rows[0], {
      remaining_microusd: 5, remaining_requests: 0,
    });
    await db.exec("reset role; update public.online_dev_model_budget set expires_at=now()-interval '1 second', remaining_requests=1; set role service_role");
    assert.equal(await rpc(user, model, 1), false);
  } finally {
    await db.close();
  }
});
