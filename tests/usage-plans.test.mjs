import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)((n) => { if (n in deps) return deps[n]; return require(n); }, m, m.exports); return m.exports;
}
const config = load('lib/plans-config.ts');
const plans = load('lib/plans.ts', { './plans-config': config });
const meter = load('lib/usage-meter.ts', { './plans': plans, './plans-config': config });
const store = load('lib/usage-store.ts', { './plans': plans });
const NOV = Date.UTC(2026, 10, 9, 15, 30);
const USER = '11111111-1111-4111-8111-111111111111';
const MODELS = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash'];
const FREE = config.PLANS.free;

test('the month is the UTC calendar month and renews at 00:00 UTC on the 1st', () => {
  assert.equal(plans.periodStart(NOV), '2026-11-01');
  assert.equal(plans.renewsAt(NOV).toISOString(), '2026-12-01T00:00:00.000Z');
  const dec31 = Date.UTC(2026, 11, 31, 23, 59, 59);
  assert.equal(plans.periodStart(dec31), '2026-12-01');
  assert.equal(plans.renewsAt(dec31).toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(plans.periodStart(Date.UTC(2027, 0, 1)), '2027-01-01', 'a new month starts a new allowance');
});

test('plan limits come from the config, and unknown plans fall back to free', () => {
  const free = plans.allowanceStatus({ plan: 'free', usedUsd: 1.25, now: NOV });
  assert.deepEqual({ ...free }, { plan: 'free', label: 'Free', usedUsd: 1.25, limitUsd: FREE.monthlyBudgetUsd, remainingUsd: FREE.monthlyBudgetUsd - 1.25, period: '2026-11-01', renewsAt: '2026-12-01T00:00:00.000Z', exhausted: false });
  assert.equal(plans.allowanceStatus({ plan: 'pro', usedUsd: 5, now: NOV }).limitUsd, config.PLANS.pro.monthlyBudgetUsd);
  assert.ok(config.PLANS.pro.monthlyBudgetUsd > FREE.monthlyBudgetUsd);
  assert.equal(plans.allowanceStatus({ plan: 'enterprise', usedUsd: 0 }).plan, 'free');
  assert.equal(plans.allowanceStatus({ plan: null, usedUsd: 'junk' }).usedUsd, 0);
  const limit = FREE.monthlyBudgetUsd, r = FREE.reservePerCallUsd;
  assert.equal(plans.allowanceStatus({ plan: 'free', usedUsd: limit - r }).exhausted, false, 'one more call still fits');
  assert.equal(plans.allowanceStatus({ plan: 'free', usedUsd: limit - r + 0.001 }).exhausted, true, 'not even one reservation fits');
  assert.equal(plans.allowanceStatus({ plan: 'free', usedUsd: limit + 2 }).remainingUsd, 0);
  assert.equal(plans.allowanceStatus({ plan: 'free', usedUsd: 0.1 + 0.2 }).usedUsd, 0.3, 'float sums are rounded');
});

test('free gets its listed models within what the proxy forwards; pro gets them all', () => {
  assert.deepEqual({ ...plans.planModels('free', MODELS, MODELS[0]) }, { models: ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash'], defaultModel: 'anthropic/claude-haiku-5.5' });
  assert.deepEqual({ ...plans.planModels('pro', MODELS, MODELS[0]) }, { models: MODELS, defaultModel: MODELS[0] });
  assert.equal(plans.planModels('free', ['deepseek/deepseek-v4.1-flash'], 'x').defaultModel, 'deepseek/deepseek-v4.1-flash', 'default falls back inside the plan');
  assert.deepEqual(plans.planModels('free', ['other/model'], 'other/model').models, []);
});

test('the exhaustion message is plain English with the renewal date, and has a zh translation', () => {
  const s = plans.allowanceStatus({ plan: 'free', usedUsd: 99, now: NOV });
  assert.equal(plans.exhaustedMessage(s), "You've used this month's free allowance. It renews on December 1, 2026.");
  assert.equal(plans.exhaustedMessage(s, 'zh'), '本月的免费额度已用完，将于 2026年12月1日 恢复。');
  assert.match(plans.exhaustedMessage({ ...s, plan: 'pro' }), /Pro allowance\. It renews on December 1, 2026\./);
  assert.equal(plans.usageLine(plans.allowanceStatus({ plan: 'free', usedUsd: 0.42, now: NOV })), `Free plan: $0.42 of $${config.PLANS.free.monthlyBudgetUsd.toFixed(2)} used this month. Renews December 1, 2026.`);
  assert.match(plans.usageLine(s, 'zh'), /^Free 方案：本月已用 \$99\.00 \//);
});

test('usage is read from OpenRouter replies and from SSE streams split anywhere', () => {
  assert.deepEqual({ ...plans.usageFrom({ id: 'gen-1', usage: { cost: 0.0123, prompt_tokens: 10, completion_tokens: 5 } }) }, { id: 'gen-1', costUsd: 0.0123, promptTokens: 10, completionTokens: 5 });
  assert.equal(plans.usageFrom({ id: 'gen-2' }).costUsd, undefined);
  assert.equal(plans.usageFrom({ usage: { cost: -1 } }), null);
  assert.equal(plans.usageFrom('nope'), null);
  const sse = 'data: {"id":"gen-9","choices":[{"delta":{"content":"hi"}}]}\n\n: OPENROUTER PROCESSING\n\ndata: {"id":"gen-9","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.0042}}\n\ndata: [DONE]\n\n';
  for (const cut of [1, 7, 40, 90, sse.length - 3]) {
    const s = new plans.SseUsageScanner();
    s.push(new TextEncoder().encode(sse.slice(0, cut))); s.push(sse.slice(cut));
    assert.deepEqual({ ...s.end() }, { id: 'gen-9', costUsd: 0.0042, promptTokens: 100, completionTokens: 20 });
  }
  const partial = new plans.SseUsageScanner(); partial.push('data: {"id":"gen-3","choices":[]}\n\n');
  assert.deepEqual({ ...partial.end() }, { id: 'gen-3', promptTokens: 0, completionTokens: 0 }, 'a cut-off stream still yields its id');
});

// An in-memory stand-in for begin_model_call / end_model_call with the same rules.
function fakeDeps({ plan = 'free', used = 0, fail = false, cost = null } = {}) {
  const state = { used, inflight: new Map(), seq: 0 }, ended = [], logs = [];
  return {
    state, ended, logs,
    getAllowance: async () => { if (fail) throw new Error('db down'); return plans.allowanceStatus({ plan, usedUsd: state.used, now: NOV }); },
    beginCall: async (_u, { limitUsd, reserveUsd, maxInflight }) => {
      const reserved = [...state.inflight.values()].reduce((a, b) => a + b, 0);
      if (state.inflight.size >= maxInflight) return { ok: false, reason: 'busy', usedUsd: state.used };
      if (state.used + reserved + reserveUsd > limitUsd) return { ok: false, reason: 'exhausted', usedUsd: state.used };
      const call = `c${++state.seq}`; state.inflight.set(call, reserveUsd);
      return { ok: true, ticket: { call, period: '2026-11-01', reserveUsd } };
    },
    endCall: async (_u, ticket, usage) => { state.inflight.delete(ticket.call); state.used += usage.costUsd; ended.push({ call: ticket.call, ...usage }); },
    generationCost: async (id) => (cost === null ? null : { id, costUsd: cost, promptTokens: 1, completionTokens: 1 }),
    available: MODELS, serverDefault: MODELS[0], log: (e) => logs.push(e),
  };
}

test('admission: fails closed, refuses models outside the plan, and refuses an exhausted month with the message', async () => {
  const ok = await meter.admit(USER, MODELS[1], fakeDeps());
  assert.equal(ok.refusal, null); assert.equal(ok.ticket.reserveUsd, FREE.reservePerCallUsd);
  const down = (await meter.admit(USER, MODELS[1], fakeDeps({ fail: true }))).refusal;
  assert.equal(down.status, 503); assert.equal(down.body.error.code, 'usage_unavailable');
  const pro = (await meter.admit(USER, MODELS[0], fakeDeps())).refusal;
  assert.equal(pro.status, 403); assert.equal(pro.body.error.code, 'model_not_in_plan');
  assert.match(pro.body.error.message, /anthropic\/claude-sonnet-5\.5 is not included in the Free plan/);
  assert.equal((await meter.admit(USER, MODELS[0], fakeDeps({ plan: 'pro' }))).refusal, null, 'pro may use stronger models');
  const out = (await meter.admit(USER, MODELS[1], fakeDeps({ used: FREE.monthlyBudgetUsd }))).refusal;
  assert.equal(out.status, 402, 'not 429, so clients do not retry');
  assert.equal(out.body.error.code, 'allowance_exhausted');
  assert.equal(out.body.error.message, "You've used this month's free allowance. It renews on December 1, 2026.");
  assert.equal(out.body.error.message_zh, '本月的免费额度已用完，将于 2026年12月1日 恢复。');
  assert.equal(out.body.error.renews_at, '2026-12-01T00:00:00.000Z');
  assert.equal((await meter.admit(USER, MODELS[0], fakeDeps({ plan: 'pro', used: FREE.monthlyBudgetUsd }))).refusal, null, 'pro has a larger budget');
  const broken = fakeDeps(); broken.beginCall = async () => { throw new Error('rpc down'); };
  assert.equal((await meter.admit(USER, MODELS[1], broken)).refusal.status, 503);
});

test('parallel calls: reservations bound the overrun, and too many in flight get a retryable 429', async () => {
  const deps = fakeDeps({ used: FREE.monthlyBudgetUsd - 3 * FREE.reservePerCallUsd });
  const results = await Promise.all(Array.from({ length: 50 }, () => meter.admit(USER, MODELS[1], deps)));
  const admitted = results.filter((r) => r.refusal === null);
  assert.equal(admitted.length, 3, 'only as many calls as reservations fit');
  assert.ok(results.filter((r) => r.refusal).every((r) => r.refusal.body.error.code === 'allowance_exhausted'));
  const busy = fakeDeps();
  const many = await Promise.all(Array.from({ length: FREE.maxConcurrentCalls + 5 }, () => meter.admit(USER, MODELS[1], busy)));
  const refused = many.filter((r) => r.refusal);
  assert.equal(refused.length, 5);
  assert.equal(refused[0].refusal.status, 429); assert.equal(refused[0].refusal.body.error.code, 'too_many_in_flight');
});

test('the upstream body asks for usage, keeps the client fields and drops routing to other models', () => {
  assert.deepEqual(meter.meteredBody({ model: 'm', messages: [], usage: { include: false }, models: ['x/pro'], route: 'fallback', preset: '@p' }, USER), { model: 'm', messages: [], user: `hsd:${USER}`, usage: { include: true } });
  assert.deepEqual(meter.meteredBody({ model: 'm', stream: true, stream_options: { foo: 1 } }, USER).stream_options, { foo: 1, include_usage: true });
});

const text = (body) => new Response(body).text();
const TICKET = { call: 'c0', period: '2026-11-01', reserveUsd: FREE.reservePerCallUsd };
const enc = new TextEncoder();

test('metering: a non-streamed reply is passed unchanged and its cost replaces the reservation', async () => {
  const deps = fakeDeps();
  const reply = JSON.stringify({ id: 'gen-a', choices: [{ message: { content: 'x' } }], usage: { cost: 0.5, prompt_tokens: 3, completion_tokens: 4 } });
  const { body, done } = meter.meterResponse(new Response(reply, { status: 200 }), USER, false, TICKET, deps);
  assert.equal(await text(body), reply);
  await done;
  assert.deepEqual(deps.ended.map((u) => ({ ...u })), [{ call: 'c0', id: 'gen-a', costUsd: 0.5, promptTokens: 3, completionTokens: 4 }]);
});

test('metering: a non-streamed reply is charged even if the client never reads it', async () => {
  const deps = fakeDeps();
  const { done } = meter.meterResponse(new Response(JSON.stringify({ id: 'g', usage: { cost: 0.2 } })), USER, false, TICKET, deps);
  await done;
  assert.equal(deps.ended[0].costUsd, 0.2);
});

test('metering: a stream is passed byte for byte and charged from its usage chunk', async () => {
  const deps = fakeDeps();
  const sse = 'data: {"id":"gen-s","choices":[{"delta":{"content":"a"}}]}\n\ndata: {"id":"gen-s","choices":[],"usage":{"cost":0.25,"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  const { body, done } = meter.meterResponse(new Response(sse, { status: 200 }), USER, true, TICKET, deps);
  assert.equal(await text(body), sse);
  await done;
  assert.equal(deps.ended[0].costUsd, 0.25);
});

test('metering: a stream the client closes early is still read to its usage chunk', async () => {
  for (const firstChunk of [': OPENROUTER PROCESSING\n\n', 'data: {"id":"gen-c","choices":[{"delta":{"content":"a"}}]}\n\n']) {
    const deps = fakeDeps();
    let push;
    const upstream = new ReadableStream({ start(c) { push = c; c.enqueue(enc.encode(firstChunk)); } });
    const { body, done } = meter.meterResponse(new Response(upstream, { status: 200 }), USER, true, TICKET, deps);
    const reader = body.getReader(); await reader.read(); await reader.cancel();
    // Upstream carries on after the client left: the cost arrives at the end.
    push.enqueue(enc.encode('data: {"id":"gen-c","choices":[],"usage":{"cost":0.07}}\n\ndata: [DONE]\n\n')); push.close();
    await done;
    assert.deepEqual(deps.ended.map((u) => u.costUsd), [0.07], `charged after cancel (first chunk ${JSON.stringify(firstChunk.slice(0, 12))})`);
  }
});

test('metering: an unpriced reply is looked up, else charged its reservation; failed calls release it at no cost', async () => {
  const looked = fakeDeps({ cost: 0.03 });
  const r1 = meter.meterResponse(new Response('{"id":"gen-x"}'), USER, false, TICKET, looked);
  await text(r1.body); await r1.done;
  assert.equal(looked.ended[0].costUsd, 0.03);
  const none = fakeDeps();
  const r2 = meter.meterResponse(new Response('{"choices":[]}'), USER, false, TICKET, none);
  await text(r2.body); await r2.done;
  assert.equal(none.ended[0].costUsd, FREE.reservePerCallUsd, 'never free');
  assert.equal(none.logs[0].event, 'usage_unpriced_charged_reserve');
  const failed = fakeDeps();
  await meter.meterResponse(new Response('{"error":{}}', { status: 429 }), USER, false, TICKET, failed).done;
  assert.deepEqual(failed.ended.map((u) => u.costUsd), [0]);
});

test('spend accumulates until the allowance is used up, then calls are refused', async () => {
  const deps = fakeDeps();
  let calls = 0;
  for (;;) {
    const { refusal, ticket } = await meter.admit(USER, MODELS[1], deps);
    if (refusal) { assert.equal(refusal.body.error.code, 'allowance_exhausted'); break; }
    const r = meter.meterResponse(new Response(JSON.stringify({ id: `g${calls}`, usage: { cost: 0.6 } })), USER, false, ticket, deps);
    await text(r.body); await r.done; calls++;
    assert.ok(calls < 100);
  }
  assert.equal(calls, Math.floor((FREE.monthlyBudgetUsd - FREE.reservePerCallUsd) / 0.6) + 1);
  assert.ok(deps.state.used <= FREE.monthlyBudgetUsd + 0.6, 'overrun bounded by one call');
});

test('store: the RPCs carry the user, the month, the limits and the cost', async () => {
  process.env.SUPABASE_URL = 'https://db.example'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
  const calls = [];
  const replies = { model_allowance: '{"plan":"pro","used_usd":"1.5"}', begin_model_call: '{"ok":true,"call":"abc","used_usd":1.5}', end_model_call: '2' };
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(replies[url.split('/').pop()]); };
  const a = await store.getAllowance(USER, NOV, f);
  assert.equal(a.plan, 'pro'); assert.equal(a.usedUsd, 1.5);
  const begun = await store.beginCall(USER, { limitUsd: 30, reserveUsd: 0.25, maxInflight: 32 }, NOV, f);
  assert.deepEqual(begun, { ok: true, ticket: { call: 'abc', period: '2026-11-01', reserveUsd: 0.25 } });
  await store.endCall(USER, begun.ticket, { costUsd: 0.1, promptTokens: 5, completionTokens: 6 }, f);
  assert.deepEqual(calls.map((c) => [c.url, c.body]), [
    ['https://db.example/rest/v1/rpc/model_allowance', { p_user: USER, p_period: '2026-11-01' }],
    ['https://db.example/rest/v1/rpc/begin_model_call', { p_user: USER, p_period: '2026-11-01', p_limit: 30, p_reserve: 0.25, p_max_inflight: 32, p_stale_seconds: 600 }],
    ['https://db.example/rest/v1/rpc/end_model_call', { p_call: 'abc', p_user: USER, p_period: '2026-11-01', p_cost: 0.1, p_prompt: 5, p_completion: 6 }],
  ]);
  await assert.rejects(store.getAllowance(USER, NOV, async () => new Response('', { status: 500 })), /failed \(500\)/);
  await assert.rejects(store.beginCall(USER, { limitUsd: 1, reserveUsd: 0, maxInflight: 1 }, NOV, async () => new Response('{}')), /Unexpected/);
});

// The hosted route itself, with its imports stubbed: enforcement happens at the server.
function loadRoute({ enabled, used }) {
  const afterCalls = [];
  const NextResponse = { json: (b, init = {}) => new Response(JSON.stringify(b), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }) };
  const deps = fakeDeps({ used });
  const route = load('app/api/desktop/v1/chat/completions/route.ts', {
    'next/server': { NextResponse, after: (p) => afterCalls.push(p) },
    '@/lib/desktop-access': { bearer: () => 'k', verifyDesktopKey: () => USER, DESKTOP_MODELS: MODELS, DESKTOP_DEFAULT_MODEL: MODELS[0] },
    '@/lib/plans': { ...plans, usagePlansEnabled: () => enabled },
    '@/lib/usage-meter': meter,
    '@/lib/usage-store': { getAllowance: deps.getAllowance, beginCall: deps.beginCall, endCall: deps.endCall, generationCost: async () => null },
  });
  return { route, afterCalls, deps };
}

test('hosted route: an exhausted account is refused before anything reaches OpenRouter; the client abort is not forwarded', async () => {
  process.env.OPENROUTER_API_KEY = 'or-test';
  const realFetch = globalThis.fetch; const upstream = [];
  globalThis.fetch = async (url, init) => { upstream.push({ body: JSON.parse(init.body), signal: init.signal }); return new Response(JSON.stringify({ id: 'gen-r', usage: { cost: 0.01 } })); };
  try {
    const req = () => new Request('http://x/api/desktop/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODELS[1], messages: [{ role: 'user', content: 'hi' }], models: [MODELS[0]] }) });
    const out = loadRoute({ enabled: true, used: 50 });
    const refused = await out.route.POST(req());
    assert.equal(refused.status, 402);
    assert.match((await refused.json()).error.message, /You've used this month's free allowance\. It renews on December 1, 2026\./);
    assert.equal(upstream.length, 0);
    const ok = loadRoute({ enabled: true, used: 0 });
    const res = await ok.route.POST(req());
    assert.equal(res.status, 200); await res.text(); await Promise.all(ok.afterCalls);
    assert.equal(ok.deps.state.used, 0.01);
    assert.equal(ok.deps.state.inflight.size, 0, 'reservation released');
    assert.equal(upstream[0].signal, undefined, 'metered calls are not aborted with the client');
    assert.equal(upstream[0].body.models, undefined, 'routing to other models is dropped');
    const off = loadRoute({ enabled: false, used: 50 });
    assert.equal((await off.route.POST(req())).status, 200, 'flag off: behaviour unchanged');
    assert.equal(off.afterCalls.length, 0);
    assert.ok(upstream[1].signal, 'flag off: the client abort is forwarded as before');
    globalThis.fetch = async () => { throw new Error('network'); };
    const down = loadRoute({ enabled: true, used: 0 });
    assert.equal((await down.route.POST(req())).status, 502);
    await Promise.all(down.afterCalls);
    assert.equal(down.deps.state.inflight.size, 0, 'a call that never reached the provider releases its reservation');
  } finally { globalThis.fetch = realFetch; }
});

test('desktop key: with plans on, a signed-in account needs no invitation code', async () => {
  process.env.SUPABASE_URL = 'https://db.example'; process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: USER, email: 'a@b.c' }));
  try {
    const keyRoute = (enabled) => load('app/api/desktop/key/route.ts', {
      'next/server': { NextResponse: { json: (b, init = {}) => new Response(JSON.stringify(b), { status: init.status ?? 200 }) } },
      '@/lib/desktop-access': { bearer: () => 'session', desktopConfigured: () => true, mintDesktopKey: () => ({ key: 'hsd_v1.x.y', expiresAt: 'z' }), promoMatches: (c) => c === 'CODE' },
      '@/lib/plans': { usagePlansEnabled: () => enabled },
    });
    const post = (route, body) => route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));
    assert.equal((await post(keyRoute(true), {})).status, 200);
    assert.equal((await post(keyRoute(false), {})).status, 403, 'flag off: the code is still required');
    assert.equal((await post(keyRoute(false), { code: 'CODE' })).status, 200);
  } finally { globalThis.fetch = realFetch; }
});

test('real PostgreSQL: usage accumulates per month, plans default to free, and users can only read their own rows', async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
      insert into auth.users values ('${USER}'), ('22222222-2222-4222-8222-222222222222');`);
    const sql = await readFile(new URL('../supabase/migrations/20261109120000_usage_plans.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // idempotent re-apply
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const allowance = async (u, p) => (await db.query('select public.model_allowance($1, $2) as a', [u, p])).rows[0].a;
    const add = (u, p, c) => db.query('select public.add_model_usage($1, $2, $3, 10, 5) as t', [u, p, c]);
    await db.exec('set role service_role');
    assert.deepEqual(await allowance(USER, '2026-11-01'), { plan: 'free', used_usd: 0 });
    await add(USER, '2026-11-01', 0.75); await add(USER, '2026-11-01', 1.5); await add(USER, '2026-11-01', -3);
    assert.equal(Number((await allowance(USER, '2026-11-01')).used_usd), 2.25, 'negative costs are ignored');
    assert.equal(Number((await allowance(USER, '2026-12-01')).used_usd), 0, 'December starts from zero');
    const row = (await db.query(`select requests, prompt_tokens from public.model_usage_monthly where user_id = $1 and period = '2026-11-01'`, [USER])).rows[0];
    assert.deepEqual({ requests: row.requests, prompt_tokens: Number(row.prompt_tokens) }, { requests: 3, prompt_tokens: 30 });
    await assert.rejects(add(USER, '2026-11-15', 1), /check/, 'a period is the 1st of a month');
    await db.query(`insert into public.account_plans (user_id, plan) values ($1, 'pro')`, [USER]);
    assert.equal((await allowance(USER, '2026-11-01')).plan, 'pro');
    await assert.rejects(db.query(`insert into public.account_plans (user_id, plan) values ($1, 'gold')`, [OTHER]), /check/);
    // Reservations: serialised admission, the in-flight cap, stale rows, and end_model_call.
    const begin = async (u, limit, reserve, max) => (await db.query('select public.begin_model_call($1, $2, $3, $4, $5, 600) as r', [u, '2026-11-01', limit, reserve, max])).rows[0].r;
    const used = Number((await allowance(USER, '2026-11-01')).used_usd);
    const first = await begin(USER, used + 0.11, 0.05, 5);
    assert.equal(first.ok, true);
    assert.equal((await begin(USER, used + 0.11, 0.05, 5)).ok, true);
    assert.deepEqual({ ...(await begin(USER, used + 0.11, 0.05, 5)), used_usd: 0 }, { ok: false, reason: 'exhausted', used_usd: 0 }, 'a third reservation does not fit');
    assert.equal((await begin(USER, 1000, 0.05, 2)).reason, 'busy');
    await db.query(`select public.end_model_call($1, $2, '2026-11-01', 0.01, 1, 1)`, [first.call, USER]);
    assert.equal((await begin(USER, used + 0.11, 0.05, 5)).ok, true, 'ending a call frees its reservation');
    await db.exec(`update public.model_calls_inflight set started_at = now() - interval '11 minutes'`);
    assert.equal((await begin(USER, 1000, 0.05, 1)).ok, true, 'stale reservations stop counting');
    assert.equal(Number((await allowance(USER, '2026-11-01')).used_usd), used + 0.01);
    await assert.rejects(begin('33333333-3333-4333-8333-333333333333', 10, 0.05, 5), /foreign key/, 'a deleted account cannot start a call');
    await add(OTHER, '2026-11-01', 9);
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${USER}'`);
    assert.equal((await db.query('select * from public.model_usage_monthly')).rows.length, 1, 'only my own usage');
    assert.equal((await db.query('select plan from public.account_plans')).rows[0].plan, 'pro');
    await assert.rejects(db.query(`update public.account_plans set plan = 'pro'`), /permission denied/);
    await assert.rejects(db.query(`insert into public.account_plans (user_id, plan) values ($1, 'pro')`, [OTHER]), /permission denied/);
    await assert.rejects(db.query(`update public.model_usage_monthly set cost_usd = 0`), /permission denied/);
    await assert.rejects(add(USER, '2026-11-01', 0), /permission denied/);
    await assert.rejects(allowance(USER, '2026-11-01'), /permission denied/);
    await assert.rejects(db.query(`select public.begin_model_call($1, '2026-11-01', 100, 0, 9, 600)`, [USER]), /permission denied/);
    await assert.rejects(db.query('select * from public.model_calls_inflight'), /permission denied/);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.model_usage_monthly'), /permission denied/);
  } finally { await db.close(); }
});
