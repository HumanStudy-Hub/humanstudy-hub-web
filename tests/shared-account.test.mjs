import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => dependencies[name] || require(name), module, module.exports);
  return module.exports;
}
function environment(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => value === undefined ? delete process.env[key] : process.env[key] = value);
  return Promise.resolve().then(fn).finally(() => Object.entries(previous).forEach(([key, value]) => value === undefined ? delete process.env[key] : process.env[key] = value));
}
const policy = load('lib/studio/auth-policy.ts');
class StudioError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
function authHarness(replies = [], initial = {}) {
  const written = [], calls = [], jar = { get: name => initial[name] ? { value: initial[name] } : undefined, set: (...args) => { written.push(args); initial[args[0]] = args[1]; } };
  const auth = load('lib/studio/auth.ts', {
    './auth-policy': policy,
    'next/headers': { cookies: async () => jar },
    './http': { StudioError, studioConfig: () => {}, isUuid: value => value === 'user-id', studioFetch: async (...args) => { calls.push(args); const next = replies.shift(); if (next instanceof Error) throw next; return next; }, upstreamJson: async response => { if (!response.ok) throw new StudioError(502, 'service_unavailable'); return response.json(); } },
  });
  return { auth, jar, written, calls };
}
const shared = { NODE_ENV: 'production', HUB_AUTH_COOKIE_DOMAIN: '.humanstudy-hub.com', HUB_AUTH_ORIGIN: 'https://humanstudy-hub.com' };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('returnTo is explicit, bounded, credential-free and cannot loop through account routes', async () => {
  await environment({ NODE_ENV: 'production', HUB_AUTH_ALLOW_LOCAL_RETURN: 'true' }, () => {
    assert.equal(policy.accountReturnTo('https://forum.humanstudy-hub.com/posts/example?view=all'), 'https://forum.humanstudy-hub.com/posts/example?view=all');
    for (const value of ['//evil.com', '/forum', 'https://forum.humanstudy-hub.com.evil.com/', 'https://evil.com/', 'http://forum.humanstudy-hub.com/', 'https://user@forum.humanstudy-hub.com/', 'https://forum.humanstudy-hub.com/#access_token=x', 'https://forum.humanstudy-hub.com/?refresh_token=x', 'https://humanstudy-hub.com/auth/refresh', 'https://humanstudy-hub.com/account', 'http://localhost:3120/', 'https://forum.humanstudy-hub.com/\\evil']) assert.equal(policy.accountReturnTo(value), undefined, value);
  });
  await environment({ NODE_ENV: 'development', HUB_AUTH_ALLOW_LOCAL_RETURN: 'true' }, () => assert.equal(policy.accountReturnTo('http://localhost:3120/posts/a'), 'http://localhost:3120/posts/a'));
});

test('parent cookie scope is fail closed and never enabled for preview or arbitrary domains', async () => {
  await environment(shared, () => assert.equal(policy.sharedCookieDomain(), '.humanstudy-hub.com'));
  for (const override of [{ HUB_AUTH_COOKIE_DOMAIN: '.com' }, { NODE_ENV: 'development' }, { HUB_AUTH_ORIGIN: 'https://preview.vercel.app' }]) await environment({ ...shared, ...override }, () => assert.throws(() => policy.sharedCookieDomain()));
});

test('new shared names migrate old host cookies without same-name scope ambiguity', async () => {
  await environment(shared, async () => {
    const h = authHarness([], { studio_access: 'legacy-access', studio_refresh: 'legacy-refresh' });
    await h.auth.migrateStudioSession();
    assert.equal(h.written[0][0], 'hub_access');
    assert.equal(h.written[0][2].domain, '.humanstudy-hub.com');
    assert.equal(h.written[0][2].httpOnly, true);
    assert.equal(h.written[0][2].secure, true);
    assert.equal(h.written[1][0], 'hub_refresh');
    for (const entry of h.written.slice(2)) { assert.equal(entry[2].maxAge, 0); assert.equal(entry[2].domain, undefined); }
    assert.equal(h.auth.studioSessionToken(h.jar, 'access'), 'legacy-access');
    await h.auth.clearStudioSession();
    assert.ok(h.written.some(([key, value, options]) => key === 'hub_access' && value === '' && options.domain === '.humanstudy-hub.com'));
  });
});

test('shared access requires both a valid user and a live session RPC', async () => {
  await environment(shared, async () => {
    const h = authHarness([reply({ id: 'user-id' }), reply(true)], { hub_access: 'shared-access' });
    assert.equal((await h.auth.requireStudioUser({ allowRefresh: false })).user.id, 'user-id');
    assert.equal(h.calls[1][0], '/rest/v1/rpc/hub_session_active');
    assert.deepEqual(h.calls[1][1], { method: 'POST', token: 'shared-access', body: {} });
    const revoked = authHarness([reply({ id: 'user-id' }), reply(false)], { hub_access: 'revoked' });
    await assert.rejects(revoked.auth.requireStudioUser({ allowRefresh: false }), error => error.status === 401);
    assert.equal(revoked.calls.length, 2);
  });
});

test('network or upstream outages preserve credentials rather than logging the user out', async () => {
  await environment(shared, async () => {
    for (const response of [reply({ error: 'busy' }, 503), new StudioError(502, 'service_unavailable')]) {
      const h = authHarness([response], { hub_refresh: 'keep-refresh' });
      await assert.rejects(h.auth.requireStudioUser(), error => error.status === 502);
      assert.equal(h.written.length, 0);
    }
    const rpc = authHarness([reply({ id: 'user-id' }), reply({}, 503)], { hub_access: 'keep-access' });
    await assert.rejects(rpc.auth.requireStudioUser(), error => error.status === 502);
    assert.equal(rpc.written.length, 0);
  });
});

test('read-only access never rotates a refresh token', async () => {
  await environment(shared, async () => {
    const h = authHarness([], { hub_refresh: 'refresh' });
    await assert.rejects(h.auth.requireStudioUser({ allowRefresh: false }), error => error.status === 401);
    assert.equal(h.calls.length, 0);
    assert.equal(h.written.length, 0);
  });
});

test('central refresh rejects open redirects before auth and preserves outage state', async () => {
  const http = { StudioError, routeError: () => new Response('{}', { status: 500 }) };
  const responseFactory = { json: (body, init = {}) => new Response(JSON.stringify(body), init), redirect: (url, init = {}) => new Response(null, { ...init, headers: { ...init.headers, location: url.toString() } }) };
  let attempts = 0, cleared = 0;
  const deps = {
    'next/server': { NextResponse: responseFactory },
    '@/lib/studio/auth-policy': policy,
    '@/lib/studio/http': http,
    '@/lib/studio/auth': { requireStudioUser: async () => { attempts++; throw new StudioError(502, 'service_unavailable'); }, migrateStudioSession: async () => {}, clearStudioSession: async () => { cleared++; } },
  };
  const refresh = load('app/auth/refresh/route.ts', deps);
  assert.equal((await refresh.GET(new Request('https://humanstudy-hub.com/auth/refresh?returnTo=https://evil.com/'))).status, 400);
  assert.equal(attempts, 0);
  const valid = new Request('https://humanstudy-hub.com/auth/refresh?returnTo=' + encodeURIComponent('https://forum.humanstudy-hub.com/posts/example'));
  const unavailable = await refresh.GET(valid);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('location'), null);
  assert.equal(cleared, 0);
  deps['@/lib/studio/auth'].requireStudioUser = async () => { throw new StudioError(401, 'unauthorized'); };
  const expired = await refresh.GET(valid);
  assert.equal(expired.status, 307);
  assert.equal(new URL(expired.headers.get('location')).pathname, '/account');
  assert.equal(new URL(expired.headers.get('location')).searchParams.get('returnTo'), 'https://forum.humanstudy-hub.com/posts/example');
  assert.equal(cleared, 1);
});


test('partial shared cookies never borrow a different legacy identity or refresh token', async () => {
  await environment(shared, () => {
    const h = authHarness([], { hub_refresh: 'new-identity', studio_access: 'old-identity', studio_refresh: 'old-refresh' });
    assert.equal(h.auth.studioSessionToken(h.jar, 'access'), undefined);
    assert.equal(h.auth.studioSessionToken(h.jar, 'refresh'), 'new-identity');
  });
});
