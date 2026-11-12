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
    async runCommand() { calls.push('start'); this.status = 'running'; return { exitCode: 0 }; },
    async stop() { calls.push('stop'); this.status = 'stopped'; },
  };
  const Sandbox = {
    async get(input) {
      calls.push(['get', input.name, input.resume]);
      if (!exists) throw new APIError(404);
      return sandbox;
    },
    async create() { calls.push('create'); exists = true; return sandbox; },
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
  assert.ok(!calls.includes('start'));
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

test('a stale build on a running workspace is not advertised or restarted', async t => {
  const { calls, lib } = fixture(t, { build: { ...build, version: 'stale' } });
  await assert.rejects(lib.launchTryOnline(user, attempt), { code: 'build_mismatch' });
  assert.ok(!calls.includes('start'));
  assert.ok(!calls.includes('stop'));
});
