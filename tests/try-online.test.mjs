import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, dependencies = {}) {
  const { outputText } = ts.transpileModule(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(name => dependencies[name] ?? require(name), loaded, loaded.exports);
  return loaded.exports;
}

const build = { version: '0.8.0', gitsha: 'a'.repeat(40), packhash: 'b'.repeat(64), dirty: false };
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.test' };
const lease = '22222222-2222-4222-8222-222222222222';
const attempt = '33333333-3333-4333-8333-333333333333';

function fixture(t, options = {}) {
  const env = { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'dev', TRY_SNAPSHOT_ID: 'snap_test',
    TRY_TOKEN_SECRET: 'fake-test-secret'.repeat(3), SUPABASE_SERVICE_ROLE_KEY: 'fake-test-service',
    SUPABASE_URL: 'https://database.example.test', SUPABASE_PUBLISHABLE_KEY: 'fake-test-public',
    PROMO_CODE: 'fake-test-code', TRY_APP_VERSION: build.version, TRY_APP_GIT_SHA: build.gitsha,
    TRY_APP_PACK_SHA256: build.packhash, TRY_SESSION_MINUTES: '45', TRY_MAX_RUNNING: '6' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls = [];
  class APIError extends Error {
    constructor(status) {
      super('sandbox not found');
      this.response = { status };
    }
  }
  let exists = !options.fresh;
  const sandbox = {
    status: options.stopped ? 'stopped' : 'running',
    expiresAt: new Date('2030-01-01T01:00:00Z'),
    domain: () => 'https://workspace.vercel.run',
    async runCommand(input) { calls.push([input.cmd === 'node' ? 'probe' : 'start', input.env]); this.status = 'running'; return { exitCode: 0 }; },
    currentSession() {
      return { runCommand: async input => {
        calls.push(['inspect-runtime', input.args.at(-1)]);
        return { exitCode: options.runtimeMatches ? 0 : 1 };
      } };
    },
    async updateNetworkPolicy(policy) { calls.push(['policy', policy]); this.status = 'running'; },
    async stop() { calls.push('stop'); this.status = 'stopped'; },
  };
  const Sandbox = {
    async get(input) {
      calls.push(['get', input.name, input.resume]);
      if (!exists) throw new APIError(404);
      return sandbox;
    },
    async create(input) { calls.push(['create', input.networkPolicy]); exists = true; return sandbox; },
    async list() {
      calls.push('list');
      if (options.listFails) throw new Error('provider unavailable');
      return { toArray: async () => [] };
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    const data = init?.body ? JSON.parse(init.body) : undefined;
    calls.push([path, data]);
    if (path.endsWith('online_claim_workspace')) {
      return options.admissionFails ? new Response(null, { status: 503 }) : Response.json(options.claim ?? lease);
    }
    if (path.endsWith('online_finish_workspace')) {
      return Response.json(options.cancelled ? Boolean(data.release_slot) : true);
    }
    if (path === '/healthz') return Response.json({ ready: true, build: options.build ?? build });
    if (path === '/ipc/account:status') return Response.json({ value: { signedIn: true, email: user.email } });
    if (path === '/__seed') return Response.json({ ok: !options.seedFails });
    throw Error('Unexpected fetch path ' + path);
  });
  const config = load('lib/try-online-config.ts');
  const lib = load('lib/try-online.ts', {
    '@vercel/sandbox': { Sandbox, APIError }, './try-online-config': config,
    './desktop-access': { mintDesktopKey: id => ({ key: 'fixture-desktop-key-' + id }) },
    './try-dev-models': {
      devHubOrigin: () => options.hubOrigin ?? '', devModelAccess: () => options.managedDev ?? false,
      devModelNetwork: async () => options.networkPolicy ?? null, isDevPreview: () => process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF === 'dev',
    },
  });
  return { calls, config, lib };
}

test('production and preview use distinct workspace identities and status never resumes', async t => {
  const { calls, lib } = fixture(t);
  const previewInvite = lib.accessCookieFor(user.id);
  assert.equal(await lib.tryWorkspaceStatus(user.id), 'running');
  assert.match(calls[0][1], /^try-preview-[a-f0-9]{12}-11111111/);
  assert.equal(calls[0][2], false);
  process.env.VERCEL_ENV = 'production';
  assert.equal(lib.hasAccess(user.id, previewInvite), false);
  assert.equal(await lib.tryWorkspaceStatus(user.id), 'running');
  assert.deepEqual(calls[1], ['get', 'try-' + user.id, false]);
});

test('missing config and unavailable admission do not start compute', async t => {
  const { calls, lib } = fixture(t, { admissionFails: true });
  const version = process.env.TRY_APP_VERSION;
  delete process.env.TRY_APP_VERSION;
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'not_configured' });
  assert.deepEqual(calls, []);
  process.env.TRY_APP_VERSION = version;
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'admission_unavailable' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].attempt_id, attempt);
});

test('an existing matching workspace reopens without restarting', async t => {
  const { calls, lib } = fixture(t);
  const result = await lib.launchTryOnline(user, attempt);
  assert.equal(result.resumed, true);
  assert.match(result.url, /^https:\/\/workspace\.vercel\.run\/\?t=[a-f0-9]{64}$/);
  assert.ok(!calls.some(([name]) => name === 'start'));
  assert.deepEqual(await lib.stopTryOnline(user.id), { pending: false });
  assert.ok(calls.includes('stop'));
  assert.equal(calls.at(-1)[1].release_slot, true);
});

test('startup seed failure stops new compute and releases its reservation', async t => {
  const { calls, lib } = fixture(t, { fresh: true, seedFails: true });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'start_failed' });
  assert.ok(calls.includes('stop'));
  assert.equal(calls.at(-1)[1].release_slot, true);
});

test('a cancelled launch never returns a browser URL', async t => {
  const { calls, lib } = fixture(t, { fresh: true, cancelled: true });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'workspace_cancelled' });
  assert.ok(calls.includes('stop'));
  assert.equal(calls.at(-1)[1].release_slot, true);
});

test('a delayed cancellation for a superseded attempt never calls the provider', async t => {
  const { calls, lib } = fixture(t, { claim: 'ignored' });
  assert.deepEqual(await lib.stopTryOnline(user.id, attempt), { pending: false, ignored: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].attempt_id, attempt);
});

test('a stale build on a running workspace is not advertised or restarted', async t => {
  const { calls, lib } = fixture(t, { build: { ...build, version: 'stale' } });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'build_mismatch' });
  assert.ok(!calls.some(([name]) => name === 'start'));
  assert.ok(!calls.includes('stop'));
});

test('managed dev firewall credential never goes into guest environment', async t => {
  const hubOrigin = 'https://example-dev.vercel.app';
  const networkPolicy = { allow: { 'example-dev.vercel.app': [{ transform: [{ headers: { 'x-vercel-trusted-oidc-idp-token': 'fixture-server-secret' } }] }] } };
  const { calls, lib } = fixture(t, { fresh: true, managedDev: true, hubOrigin, networkPolicy });
  await lib.launchTryOnline(user, attempt);
  assert.deepEqual(calls.find(([name]) => name === 'create'), ['create', networkPolicy]);
  const startEnv = calls.find(([name]) => name === 'start')[1];
  assert.equal(startEnv.HUMANSTUDY_SERVER, hubOrigin);
  assert.equal(startEnv.NODE_USE_SYSTEM_CA, '1');
  assert.ok(!JSON.stringify(startEnv).includes('fixture-server-secret'));
  assert.ok(calls.some(([name]) => name === 'probe'));
  assert.ok(calls.find(([name]) => name === '/__seed')[1].desktopKey);
});

test('missing managed dev authentication fails before reservation and compute', async t => {
  const { calls, lib } = fixture(t, { managedDev: true });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'model_auth_unavailable' });
  assert.deepEqual(calls, []);
});

test('dev model authorization matches only configured user, host and desktop methods', async t => {
  const { calls } = fixture(t);
  const host = 'example-dev.vercel.app';
  const origin = 'https://' + host;
  for (const [key, value] of Object.entries({
    TRY_DEV_MANAGED_MODELS: '1', TRY_DEV_MODEL_USER_ID: user.id, VERCEL_BRANCH_URL: host, TRY_DEV_HUB_ORIGIN: origin,
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const token = (environment, exp) => 'header.' + Buffer.from(JSON.stringify({ environment, exp })).toString('base64url') + '.signature';
  const expires = Math.floor(Date.now() / 1000) + 3600;
  let current = token('preview', expires);
  const api = load('lib/try-dev-models.ts', { '@vercel/oidc': { getVercelOidcToken: async () => current } });
  assert.equal(api.devModelAccess(user.id), true);
  assert.equal(api.devModelAccess(attempt), false);
  assert.equal(api.devHubOrigin(), origin);
  assert.equal(await api.devModelNetwork('https://humanstudy-hub.com', 10), null);
  const policy = await api.devModelNetwork(origin, 10);
  assert.deepEqual(policy.allow[host].slice(0, 3).map(rule => rule.match), [
    { path: { exact: '/api/desktop/config' }, method: ['GET'] },
    { path: { exact: '/api/desktop/v1/models' }, method: ['GET'] },
    { path: { exact: '/api/desktop/v1/chat/completions' }, method: ['POST'] },
  ]);
  assert.deepEqual(policy.allow[host].at(-1), { response: { statusCode: 403 } });
  assert.equal(policy.allow[host][0].transform[0].headers['x-vercel-trusted-oidc-idp-token'], current);
  assert.deepEqual(policy.allow['humanstudy-hub.com'], [{ response: { statusCode: 403 } }]);
  assert.deepEqual(policy.allow['*'], []);
  current = token('production', expires);
  assert.equal(await api.devModelNetwork(origin, 10), null);
  current = token('preview', expires - 3599);
  assert.equal(await api.devModelNetwork(origin, 10), null);
  process.env.VERCEL_ENV = 'production';
  assert.equal(api.devModelAccess(user.id), false);
  assert.equal(api.devHubOrigin(), '');
  assert.deepEqual(calls, []);
});

test('hosted bodyless Stop and JSON cancellation both preserve owner-scoped behavior', async () => {
  const calls = [];
  const route = load('app/api/try/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/desktop-access': {},
    '@/lib/studio/auth': { requireStudioUser: async () => ({ user }) },
    '@/lib/studio/http': {
      assertSameOrigin: request => assert.equal(request.headers.get('origin'), 'https://dev.example.test'),
      readJsonBody: async request => {
        assert.equal(request.headers.get('content-type'), 'application/json');
        return request.json();
      },
      isUuid: value => value === attempt,
      routeError: error => { throw error; },
    },
    '@/lib/try-online': { stopTryOnline: async (...args) => { calls.push(args); return { pending: false }; } },
    '@/lib/try-online-config': { tryConfigured: () => true },
  });
  const origin = 'https://dev.example.test';
  const request = new Request(origin + '/api/try', {
    method: 'DELETE', headers: { origin }, body: new ReadableStream({ start(controller) { controller.close(); } }), duplex: 'half',
  });
  assert.notEqual(request.body, null);
  assert.equal((await route.DELETE(request)).status, 200);
  const json = new Request(origin + '/api/try', {
    method: 'DELETE', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ attempt }),
  });
  assert.equal((await route.DELETE(json)).status, 200);
  assert.deepEqual(calls, [[user.id, undefined], [user.id, attempt]]);
});

test('existing managed workspace with an old origin requires explicit stop and resume', async t => {
  const hubOrigin = 'https://example-dev.vercel.app';
  const { calls, lib } = fixture(t, { managedDev: true, hubOrigin, networkPolicy: 'allow-all' });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'workspace_restart_required' });
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'inspect-runtime'));
  assert.ok(!calls.some(call => call === 'stop' || (Array.isArray(call) && ['start', 'policy', '/__seed'].includes(call[0]))));
});

test('existing managed workspace at the correct origin refreshes policy without restarting', async t => {
  const hubOrigin = 'https://example-dev.vercel.app';
  const { calls, lib } = fixture(t, { managedDev: true, hubOrigin, runtimeMatches: true, networkPolicy: 'allow-all' });
  assert.equal((await lib.launchTryOnline(user, attempt)).resumed, true);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'policy'));
  assert.ok(!calls.some(call => call === 'stop' || (Array.isArray(call) && call[0] === 'start')));
});
