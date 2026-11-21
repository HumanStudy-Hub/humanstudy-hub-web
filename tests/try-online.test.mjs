import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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
    TRY_APP_PACK_SHA256: build.packhash, TRY_SESSION_MINUTES: options.sessionMinutes ?? '45', TRY_MAX_RUNNING: options.maxRunning ?? '6' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls = [], scripts = [];
  class APIError extends Error {
    constructor(status) {
      super('sandbox not found');
      this.response = { status };
    }
  }
  let exists = !options.fresh;
  let stopFailed = false;
  let activeTimeout = (options.activeMinutes ?? options.providerMinutes ?? Number(env.TRY_SESSION_MINUTES)) * 60_000;
  const sandbox = {
    status: options.stopped ? 'stopped' : 'running',
    timeout: (options.providerMinutes ?? Number(env.TRY_SESSION_MINUTES)) * 60_000,
    currentSnapshotId: 'snap_previous',
    expiresAt: new Date('2030-01-01T01:00:00Z'),
    domain: () => 'https://workspace.vercel.run',
    async runCommand(input) {
      calls.push([input.cmd === 'node' ? 'probe' : 'start', input.env]);
      this.status = 'running';
      return { exitCode: options.startFails && input.cmd !== 'node' ? 1 : 0 };
    },
    currentSession() {
      return { sessionId: 'fixture-session', timeout: activeTimeout, runCommand: async input => {
        scripts.push(input.args);
        if (input.args[1].includes('process.stdout.write(VISIT.test')) {
          calls.push(['visit-probe']);
          return { exitCode: 0, stdout: async () => options.serverVisit ?? '' };
        }
        if (input.args[1].includes('"SIGTERM"')) {
          calls.push(['signal-stop', ...input.args.slice(2)]);
          return { exitCode: 0, stdout: async () => JSON.stringify({ visit: options.serverVisit ?? null, servers: 1, exited: true }) };
        }
        calls.push(['inspect-runtime', input.args.at(-1)]);
        return { exitCode: options.runtimeMatches ? 0 : 1 };
      } };
    },
    async update({ timeout }) {
      calls.push(['timeout', timeout, this.status]);
      this.timeout = timeout;
      if (this.status === 'running') activeTimeout = Math.max(activeTimeout, timeout);
    },
    async updateNetworkPolicy(policy) { calls.push(['policy', policy]); this.status = 'running'; },
    async stop() {
      calls.push('stop');
      if (options.stopReadback) { stopFailed = true; throw new Error('fixture provider stop timed out'); }
      this.status = 'stopped';
    },
  };
  const Sandbox = {
    async get(input) {
      calls.push(['get', input.name, input.resume]);
      if (!exists) throw new APIError(404);
      if (stopFailed) {
        if (options.stopReadback === 'unreachable') throw new Error('fixture provider readback failed');
        if (options.stopReadback === 'missing') throw new APIError(404);
        return { ...sandbox, status: options.stopReadback === 'running' ? 'running' : 'stopped',
          currentSnapshotId: options.stopReadback === 'old-snapshot' ? 'snap_previous' : 'snap_saved',
          currentSession: () => ({ sessionId: options.stopReadback === 'different-session' ? 'another-session' : 'fixture-session' }),
          listSnapshots: async () => {
            calls.push('list-snapshots');
            if (options.stopReadback === 'snapshot-unreachable') throw new Error('fixture snapshot list unavailable');
            return { snapshots: [{
              id: options.stopReadback === 'snapshot-missing' ? 'snap_different' : 'snap_saved',
              sourceSessionId: options.stopReadback === 'snapshot-other-source' ? 'another-session' : 'fixture-session',
              status: options.stopReadback === 'snapshot-failed' ? 'failed' : 'created',
            }] };
          },
        };
      }
      return sandbox;
    },
    async create(input) { calls.push(['create', input.networkPolicy]); exists = true; return sandbox; },
    async list() {
      calls.push('list');
      if (options.listFails) throw new Error('provider unavailable');
      return { toArray: async () => options.providerSessions ?? [] };
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const endpoint = new URL(url);
    const path = endpoint.pathname;
    const data = init?.body ? JSON.parse(init.body) : undefined;
    calls.push([path, data]);
    if (path.endsWith('online_claim_workspace')) {
      return options.admissionFails ? new Response(null, { status: 503 }) : Response.json(Object.hasOwn(options, 'claim') ? options.claim : lease);
    }
    if (path.endsWith('online_visit_begin') || path.endsWith('online_visit_end')) {
      return options.visitsFail ? new Response(null, { status: 503 }) : Response.json(true);
    }
    if (path.endsWith('online_finish_workspace')) {
      return Response.json(options.cancelled ? Boolean(data.release_slot) : true);
    }
    if (path === '/healthz') return Response.json({ ready: true, build: options.build ?? build });
    if (path === '/ipc/account:status') return Response.json({ value: { signedIn: true, email: options.storedEmail ?? user.email } });
    if (path === '/auth/v1/admin/generate_link') {
      assert.equal(endpoint.origin, 'https://database.example.test');
      assert.deepEqual(data, { type: 'magiclink', email: user.email });
      return Response.json({ hashed_token: 'fixture-hash' });
    }
    if (path === '/auth/v1/verify') {
      assert.equal(endpoint.origin, 'https://database.example.test');
      assert.deepEqual(data, { type: 'magiclink', token_hash: 'fixture-hash' });
      return Response.json({ access_token: 'workspace-access', refresh_token: 'workspace-refresh', user: { id: options.seedUser ?? user.id } });
    }
    if (path === '/__seed') return options.seedConflict ? Response.json({ ok: false }, { status: 409 }) : Response.json({ ok: !options.seedFails });
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
  return { calls, config, lib, sandbox, scripts };
}

test('a stopped persistent workspace adopts the configured hour before managed policy resumes it', async t => {
  const { calls, lib } = fixture(t, { stopped: true, providerMinutes: 10, sessionMinutes: '60',
    managedDev: true, hubOrigin: 'https://example-dev.vercel.app', networkPolicy: 'allow-all' });
  assert.equal((await lib.launchTryOnline(user, attempt)).resumed, true);
  assert.deepEqual(calls.filter(([name]) => ['timeout', 'policy', 'start'].includes(name)).map(([name, value, state]) =>
    name === 'timeout' ? [name, value, state] : [name]), [['timeout', 3_600_000, 'stopped'], ['policy'], ['start']]);
  assert.ok(!calls.some(([name]) => name === 'create'));
});

test('reconnecting extends a shorter active session to the configured total only once', async t => {
  const { calls, lib, sandbox } = fixture(t, { providerMinutes: 60, activeMinutes: 10, sessionMinutes: '60' });
  await lib.launchTryOnline(user, attempt);
  await lib.launchTryOnline(user, attempt);
  assert.deepEqual(calls.filter(([name]) => name === 'timeout'), [['timeout', 3_600_000, 'running']]);
  assert.equal(sandbox.currentSession().timeout, 3_600_000);
  assert.ok(!calls.some(call => call === 'stop' || call[0] === 'start'));
});

test('a lower configured timeout applies to future sessions without shortening the active hour', async t => {
  const { calls, lib, sandbox } = fixture(t, { providerMinutes: 60, sessionMinutes: '30' });
  await lib.launchTryOnline(user, attempt);
  assert.equal(sandbox.timeout, 1_800_000);
  assert.equal(sandbox.currentSession().timeout, 3_600_000);
  assert.ok(!calls.some(call => call === 'stop' || call[0] === 'start'));
});

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
  assert.match(result.url, /^https:\/\/workspace\.vercel\.run\/\?t=[a-f0-9]{64}&hs_visit=[0-9a-f-]{36}$/);
  assert.ok(!calls.some(([name]) => name === 'start'));
  const seed = calls.find(([name]) => name === '/__seed')[1];
  assert.equal(seed.session.accessToken, 'workspace-access');
  assert.equal(seed.session.refreshToken, 'workspace-refresh');
  assert.equal(seed.session.email, user.email);
  assert.deepEqual(await lib.stopTryOnline(user.id), { pending: false });
  assert.ok(calls.includes('stop'));
  assert.equal(calls.at(-1)[1].release_slot, true);
});

test('Stop readback releases only when the exact session stopped and saved a new snapshot', async t => {
  const { calls, lib } = fixture(t, { stopReadback: 'saved' });
  assert.deepEqual(await lib.stopTryOnline(user.id), { pending: false });
  const reads = calls.filter(([name]) => name === 'get');
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0], reads[1], 'readback does not resume the workspace');
  assert.ok(calls.includes('list-snapshots'));
  assert.equal(calls.at(-1)[1].release_slot, true);
});

for (const stopReadback of ['running', 'unreachable', 'missing', 'old-snapshot', 'different-session',
  'snapshot-failed', 'snapshot-missing', 'snapshot-other-source', 'snapshot-unreachable']) {
  test('Stop retains its slot without confirmed saved state: ' + stopReadback, async t => {
    const { calls, lib } = fixture(t, { stopReadback });
    await assert.rejects(lib.stopTryOnline(user.id), { code: 'stop_failed' });
    assert.equal(calls.at(-1)[1].release_slot, false);
    assert.equal(calls.filter(([name]) => name === 'get').length, 2);
  });
}

test('reopen refuses a foreign account and never seeds an unverified owner', async t => {
  const wrong = fixture(t, { storedEmail: 'someone-else@example.test' });
  await assert.rejects(wrong.lib.launchTryOnline(user, attempt), { code: 'workspace_account_mismatch' });
  assert.ok(!wrong.calls.some(([name]) => ['/auth/v1/admin/generate_link', '/__seed'].includes(name)));
  assert.ok(!wrong.calls.includes('stop'));
});

test('auth verification failure leaves an existing workspace running without issuing browser access', async t => {
  const { calls, lib } = fixture(t, { seedUser: attempt });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'sign_in_failed' });
  assert.ok(calls.some(([name]) => name === '/auth/v1/verify'));
  assert.ok(!calls.some(([name]) => name === '/__seed'));
  assert.ok(!calls.includes('stop'));
});

test('an account switch during mint is refused by the workspace and returns no browser access', async t => {
  const { calls, lib } = fixture(t, { seedConflict: true });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'workspace_account_mismatch' });
  assert.ok(calls.some(([name]) => name === '/__seed'));
  assert.ok(!calls.includes('stop'));
});

test('ordinary Hub logout revokes only the current browser session', async () => {
  const calls = [];
  const route = load('app/api/studio/auth/route.ts', {
    'next/server': { NextResponse: { json: body => Response.json(body) } },
    '@/lib/desktop-access': { promoMatches: () => false },
    '@/lib/studio/auth': {
      requireStudioUser: async () => ({ accessToken: 'browser-access' }),
      clearStudioSession: async () => { calls.push('clear-browser-cookies'); },
    },
    '@/lib/studio/http': {
      studioConfig: () => ({}),
      assertSameOrigin: () => undefined,
      readJsonBody: request => request.json(),
      studioFetch: async (...args) => { calls.push(args); return new Response(null, { status: 204 }); },
      routeError: error => { throw error; },
    },
  });
  const response = await route.POST(new Request('https://hub.example.test/api/studio/auth', {
    method: 'POST', body: JSON.stringify({ action: 'signout' }),
  }));
  assert.deepEqual(await response.json(), { user: null });
  assert.deepEqual(calls, [['/auth/v1/logout?scope=local', { method: 'POST', token: 'browser-access' }], 'clear-browser-cookies']);
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
  assert.equal(startEnv.HUMANSTUDY_COMMUNITY_BRANCH, 'dev');
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
    '@/lib/hosted-model-quota': {},
    '@/lib/account-invitation': {},
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

test('ordinary dev workspace retains public account configuration without a hosted key', async t => {
  const { calls, lib } = fixture(t, { fresh: true, hubOrigin: 'https://example-dev.vercel.app' });
  await lib.launchTryOnline(user, attempt);
  assert.equal(calls.find(([name]) => name === 'start')[1].HUMANSTUDY_SERVER, undefined);
  assert.equal(calls.find(([name]) => name === '/__seed')[1].desktopKey, undefined);
});

test('Online invitation grants only after verified code and before workspace launch', async () => {
  const calls = [];
  let allow = false, existingInvite = false;
  const route = load('app/api/try/route.ts', {
    'next/server': { NextResponse: { json: Response.json } },
    'next/headers': { cookies: async () => ({ get: () => existingInvite ? { value: 'verified-owner-cookie' } : undefined, set: () => calls.push(['cookie']) }) },
    '@/lib/desktop-access': { promoMatches: code => code === 'valid-code' },
    '@/lib/hosted-model-quota': { grantHostedInvitation: async id => { calls.push(['grant', id]); return allow; } },
    '@/lib/account-invitation': { accountInvited: async () => false, rememberInvitation: async () => {} },
    '@/lib/studio/auth': { requireStudioUser: async () => ({ user }) },
    '@/lib/studio/http': { assertSameOrigin() {}, readJsonBody: request => request.json(), isUuid: value => value === attempt },
    '@/lib/try-online': {
      hasAccess: (id, cookie) => id === user.id && cookie === 'verified-owner-cookie', accessCookieFor: () => 'fixture-cookie',
      launchTryOnline: async (account, id) => { calls.push(['launch', account.id, id]); return { url: 'https://workspace.test' }; },
    },
    '@/lib/try-online-config': { tryConfigured: () => true },
  });
  const request = code => new Request('https://hub.test/api/try', { method: 'POST', body: JSON.stringify({ code, attempt, user_id: 'other' }) });
  assert.equal((await route.POST(request('wrong-code'))).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await route.POST(request('valid-code'))).status, 503);
  assert.deepEqual(calls, [['grant', user.id]]);
  allow = true;
  assert.equal((await route.POST(request('valid-code'))).status, 200);
  assert.deepEqual(calls.slice(1), [['grant', user.id], ['cookie'], ['launch', user.id, attempt]]);
  existingInvite = true;
  assert.equal((await route.POST(request(undefined))).status, 200);
  assert.deepEqual(calls.slice(-2), [['grant', user.id], ['launch', user.id, attempt]], 'a verified existing owner cookie preserves access without redeeming again');
});

test('Online workspace admits an account invited at sign-up without a code or cookie', async () => {
  const calls = [];
  let invited = false;
  const route = load('app/api/try/route.ts', {
    'next/server': { NextResponse: { json: Response.json } },
    'next/headers': { cookies: async () => ({ get: () => undefined, set: () => calls.push(['cookie']) }) },
    '@/lib/desktop-access': { promoMatches: code => code === 'valid-code' },
    '@/lib/hosted-model-quota': { grantHostedInvitation: async id => { calls.push(['grant', id]); return true; } },
    '@/lib/account-invitation': {
      accountInvited: async account => { calls.push(['invited', account.id]); return invited; },
      rememberInvitation: async (id, code) => { calls.push(['remember', id, code]); },
    },
    '@/lib/studio/auth': { requireStudioUser: async () => ({ user }) },
    '@/lib/studio/http': { assertSameOrigin() {}, readJsonBody: request => request.json(), isUuid: value => value === attempt },
    '@/lib/try-online': {
      hasAccess: () => false, accessCookieFor: () => 'fixture-cookie',
      launchTryOnline: async (account, id) => { calls.push(['launch', account.id, id]); return { url: 'https://workspace.test' }; },
    },
    '@/lib/try-online-config': { tryConfigured: () => true },
  });
  const request = code => new Request('https://hub.test/api/try', { method: 'POST', body: JSON.stringify({ code, attempt }) });
  for (const code of [undefined, '   ']) {
    const refused = await route.POST(request(code));
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, 'code_required', 'a whitespace-only code counts as missing');
  }
  const wrong = await route.POST(request('wrong-code'));
  assert.equal((await wrong.json()).error, 'invalid_code');
  assert.deepEqual(calls, [['invited', user.id], ['invited', user.id], ['invited', user.id]]);
  calls.length = 0;
  assert.equal((await route.POST(request('valid-code'))).status, 200);
  assert.deepEqual(calls, [['invited', user.id], ['grant', user.id], ['remember', user.id, 'valid-code'], ['cookie'], ['launch', user.id, attempt]]);
  calls.length = 0;
  invited = true;
  assert.equal((await route.POST(request(undefined))).status, 200);
  assert.deepEqual(calls, [['invited', user.id], ['grant', user.id], ['cookie'], ['launch', user.id, attempt]]);
});


test('a denied 51st database reservation never reaches the provider', async t => {
  const { calls, lib } = fixture(t, { fresh: true, maxRunning: '50', claim: null });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'busy' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].endsWith('online_claim_workspace'));
  assert.equal(calls[0][1].session_seconds, 2700);
});

for (const count of [49, 50]) {
  test(`provider reconciliation at ${count} existing sessions respects configured capacity50`, async t => {
    const sessions = Array.from({ length: count }, (_, i) => ({ name: `try-preview-123456789abc-existing-${i}`, status: 'running' }));
    const { calls, lib } = fixture(t, { fresh: true, maxRunning: '50', providerSessions: sessions });
    if (count === 49) {
      await lib.launchTryOnline(user, attempt);
      assert.ok(calls.some(([name]) => name === 'create'));
    } else {
      await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'busy' });
      assert.ok(!calls.some(([name]) => name === 'create'));
      assert.ok(calls.some(([name, body]) => name.endsWith?.('online_finish_workspace') && body.release_slot === true));
    }
    assert.ok(calls.findIndex(([name]) => name.endsWith?.('online_claim_workspace')) < calls.indexOf('list'));
  });
}

const visitId = '44444444-4444-4444-8444-444444444444';
const rpc = (calls, name) => calls.filter(([path]) => path.endsWith?.(name)).map(([, body]) => body);

test('a fresh launch issues one visit, starts the server with it and puts it on the URL', async t => {
  const { calls, lib } = fixture(t, { stopped: true });
  const { url } = await lib.launchTryOnline(user, attempt);
  const visit = new URL(url).searchParams.get('hs_visit');
  assert.match(visit, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(new URL(url).searchParams.get('t'), /^[a-f0-9]{64}$/);
  assert.equal(calls.find(([name]) => name === 'start')[1].HS_VISIT_ID, visit);
  const begins = rpc(calls, 'online_visit_begin');
  assert.equal(begins.length, 2, 'recorded before the server starts and again with the final provider expiry');
  for (const begin of begins) {
    assert.deepEqual(begin, { visit, owner: user.id, workspace_name: begin.workspace_name, provider_expiry: '2030-01-01T01:00:00.000Z' });
    assert.match(begin.workspace_name, /^try-preview-[a-f0-9]{12}-11111111/);
  }
  assert.ok(calls.findIndex(([path]) => path.endsWith?.('online_visit_begin')) < calls.findIndex(([name]) => name === 'start'));

  const again = fixture(t, { stopped: true });
  const next = new URL((await again.lib.launchTryOnline(user, attempt)).url).searchParams.get('hs_visit');
  assert.notEqual(next, visit, 'a fresh launch is a new visit');
});

test('a reconnect to the running server keeps the visit it was started with', async t => {
  const { calls, lib } = fixture(t, { serverVisit: visitId });
  const { url } = await lib.launchTryOnline(user, attempt);
  assert.equal(new URL(url).searchParams.get('hs_visit'), visitId);
  assert.ok(!calls.some(([name]) => name === 'start'));
  assert.ok(calls.some(([name]) => name === 'visit-probe'));
  assert.deepEqual(rpc(calls, 'online_visit_begin').map(body => body.visit), [visitId]);
});

test('a running server without a visit gets one on the URL and is not restarted', async t => {
  const { calls, lib } = fixture(t);
  const visit = new URL((await lib.launchTryOnline(user, attempt)).url).searchParams.get('hs_visit');
  assert.match(visit, /^[0-9a-f-]{36}$/);
  assert.ok(!calls.some(([name]) => name === 'start'));
  assert.deepEqual(rpc(calls, 'online_visit_begin').map(body => body.visit), [visit]);
});

test('an unavailable visit store never blocks the workspace', async t => {
  const { lib } = fixture(t, { stopped: true, visitsFail: true });
  t.mock.method(console, 'warn', () => {});
  assert.match((await lib.launchTryOnline(user, attempt)).url, /hs_visit=/);
  assert.deepEqual(await lib.stopTryOnline(user.id), { pending: false });
});

test('a server that fails to start ends its visit as a crash and releases compute', async t => {
  const { calls, lib } = fixture(t, { stopped: true, startFails: true });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'start_failed' });
  const visit = calls.find(([name]) => name === 'start')[1].HS_VISIT_ID;
  assert.deepEqual(rpc(calls, 'online_visit_end').map(({ visit: id, reason }) => [id, reason]), [[visit, 'crash']]);
  assert.equal(calls.at(-1)[1].release_slot, true);
});

test('Stop records the Hub reason, signals the server and waits before stopping the sandbox', async t => {
  const { calls, lib, scripts } = fixture(t, { serverVisit: visitId });
  assert.deepEqual(await lib.stopTryOnline(user.id), { pending: false });
  const end = calls.findIndex(([path]) => path.endsWith?.('online_visit_end'));
  const signal = calls.findIndex(([name]) => name === 'signal-stop');
  assert.ok(end >= 0 && end < signal && signal < calls.indexOf('stop'), 'decision recorded, then SIGTERM, then provider stop');
  assert.deepEqual(rpc(calls, 'online_visit_end')[0], { workspace_name: calls[1][1], visit: null, reason: 'user_stop' });
  assert.deepEqual(calls[signal].slice(1), ['/vercel/sandbox/hs/app/server.cjs', '/vercel/sandbox/hs/userData/web-stop-reason.json', 'user_stop', '10000']);
  assert.equal(scripts.length, 1);
});

test('a stopped workspace is not signalled', async t => {
  const { calls, lib } = fixture(t, { stopped: true });
  assert.deepEqual(await lib.stopTryOnline(user.id), { pending: false });
  assert.ok(!calls.some(([name]) => name === 'signal-stop'));
  assert.deepEqual(rpc(calls, 'online_visit_end'), []);
});

test('the deadline sweep stops only sessions near the provider limit, with reason timeout', async t => {
  const prefix = 'try-preview-' + createHash('sha256').update('dev').digest('hex').slice(0, 12) + '-';
  const providerSessions = [
    { name: prefix + user.id, status: 'running' },
    { name: 'try-' + attempt, status: 'running' }, // production workspace: another deployment's
    { name: prefix + lease, status: 'stopped' },
  ];
  const later = fixture(t, { providerSessions });
  assert.deepEqual(await later.lib.stopDueTryOnline(Date.parse('2030-01-01T00:50:00Z')), { due: 0, stopped: 0 });
  assert.ok(!later.calls.includes('stop'));

  const { calls, lib } = fixture(t, { providerSessions, serverVisit: visitId });
  assert.deepEqual(await lib.stopDueTryOnline(Date.parse('2030-01-01T00:59:00Z')), { due: 1, stopped: 1 });
  assert.deepEqual(calls.filter(([name]) => name === 'get').map(([, name]) => name), [prefix + user.id, prefix + user.id]);
  assert.equal(rpc(calls, 'online_visit_end')[0].reason, 'timeout');
  assert.equal(calls.find(([name]) => name === 'signal-stop')[3], 'timeout');
  assert.ok(calls.includes('stop'));
});

function guest(script, { processes, files = {}, args }) {
  const written = {}, renamed = [], signals = [], out = [];
  const alive = new Set(processes.map(({ pid }) => pid));
  const fs = {
    readdirSync: dir => (assert.equal(dir, '/proc'), [...processes.map(({ pid }) => String(pid)), 'self']),
    readFileSync(path) {
      const [, , pid, kind] = path.split('/');
      const proc = processes.find(entry => String(entry.pid) === pid);
      if (!proc) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (kind === 'cmdline') return proc.args.join('\0') + '\0';
      if (kind === 'environ') return Object.entries(proc.env).map(([key, value]) => key + '=' + value).join('\0') + '\0';
      if (kind === 'stat') {
        if (!alive.has(proc.pid)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return proc.pid + ' (node) S 1';
      }
      return files[path];
    },
    mkdirSync() {},
    writeFileSync(path, data, options) { written[path] = { data, mode: options?.mode }; },
    renameSync(from, to) { renamed.push([from, to]); written[to] = written[from]; delete written[from]; },
  };
  const proc = {
    argv: ['node', ...args], pid: 77, exitCode: undefined,
    kill(pid, signal) { signals.push([pid, signal]); setTimeout(() => alive.delete(pid), 150); },
    stdout: { write: text => out.push(text) },
  };
  const modules = { 'node:fs': fs, 'node:path': require('node:path') };
  new Function('require', 'process', script)(name => modules[name], proc);
  return { written, renamed, signals, out, proc };
}

test('guest stop script atomically writes the marker for the server visit, signals and waits for exit', async t => {
  const { lib, scripts } = fixture(t, { serverVisit: visitId });
  await lib.stopTryOnline(user.id);
  const [, script, server, marker, reason, wait] = scripts[0];
  const node = ['/usr/bin/node', server];
  const run = guest(script, { args: [server, marker, reason, wait], processes: [
    { pid: 10, args: node, env: { HS_VISIT_ID: visitId.toUpperCase(), HS_USER_DATA: '/data/user' } },
    { pid: 11, args: ['/usr/bin/node', '/other.cjs'], env: { HS_VISIT_ID: attempt } },
  ] });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(run.signals, [[10, 'SIGTERM']]);
  assert.deepEqual(Object.keys(run.written), ['/data/user/web-stop-reason.json']);
  assert.deepEqual(JSON.parse(run.written['/data/user/web-stop-reason.json'].data), { visit_id: visitId, reason: 'user_stop' });
  assert.equal(run.written['/data/user/web-stop-reason.json'].mode, 0o600);
  assert.equal(run.renamed[0][1], '/data/user/web-stop-reason.json');
  assert.notEqual(run.renamed[0][0], run.renamed[0][1]);
  assert.deepEqual(JSON.parse(run.out.join('')), { visit: visitId, servers: 1, exited: true });

  const override = guest(script, { args: [server, marker, 'timeout', wait], processes: [
    { pid: 12, args: node, env: { HS_VISIT_ID: visitId, HS_WEB_STOP_REASON_FILE: '/custom/stop.json' } },
  ] });
  const legacy = guest(script, { args: [server, marker, 'timeout', '200'], processes: [{ pid: 13, args: node, env: {} }] });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(JSON.parse(override.written['/custom/stop.json'].data), { visit_id: visitId, reason: 'timeout' });
  assert.deepEqual(legacy.written, {}, 'no marker without a visit: the runtime records an ordinary close');
  assert.deepEqual(legacy.signals, [[13, 'SIGTERM']]);
});

test('guest visit probe reads HS_VISIT_ID only from the single server process', async t => {
  const { lib, scripts } = fixture(t, { serverVisit: visitId });
  await lib.launchTryOnline(user, attempt);
  const [, script, server] = scripts.find(args => args[1].includes('process.stdout.write(VISIT.test'));
  const node = ['/usr/bin/node', server];
  const one = guest(script, { args: [server], processes: [{ pid: 10, args: node, env: { HS_VISIT_ID: visitId.toUpperCase() } }] });
  assert.equal(one.out.join(''), visitId);
  const two = guest(script, { args: [server], processes: [
    { pid: 10, args: node, env: { HS_VISIT_ID: visitId } }, { pid: 11, args: node, env: { HS_VISIT_ID: visitId } },
  ] });
  assert.equal(two.out.join(''), '');
  const invalid = guest(script, { args: [server], processes: [{ pid: 10, args: node, env: { HS_VISIT_ID: 'not-a-visit' } }] });
  assert.equal(invalid.out.join(''), '');
});
