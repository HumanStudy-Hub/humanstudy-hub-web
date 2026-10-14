import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => deps[name] || require(name), loaded, loaded.exports);
  return loaded.exports;
}
const NextResponse = { json: (value, options = {}) => new Response(JSON.stringify(value), { ...options, headers: { 'content-type': 'application/json', ...options.headers } }) };
const http = load('lib/studio/http.ts', { 'next/server': { NextResponse } });
const uid = '11111111-1111-4111-8111-111111111111';
const jwt = method => `header.${Buffer.from(JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600, amr: [{ method, timestamp: Math.floor(Date.now() / 1000) }] })).toString('base64url')}.signature`;
function fixture() {
  const jar = new Map(), calls = [], sets = [];
  const token = jwt('otp'), passwordToken = jwt('password');
  const cookie = { get: key => jar.has(key) ? { value: jar.get(key) } : undefined, set: (key, value, options) => { sets.push({ key, value, options }); jar.set(key, value); }, delete: key => jar.delete(key) };
  let badPassword = false, badEmail = false;
  const auth = {
    clearStudioSession: async () => { jar.delete('studio_access'); },
    establishStudioSession: async session => { jar.set('studio_access', session.access_token); return { id: uid, email: 'owner@test.org' }; },
    requireStudioUser: async () => { if (!jar.get('studio_access')) throw new http.StudioError(401, 'unauthorized'); return { user: { id: uid, email: 'owner@test.org' } }; },
    studioConfirmationUrl: (_req, type = 'confirm') => `https://hub.test/auth/${type}`,
  };
  const deps = {
    'next/server': { NextResponse }, 'next/headers': { cookies: async () => cookie }, '@/lib/studio/auth': auth,
    '@/lib/studio/http': { ...http, studioConfig: () => ({}), studioFetch: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/auth/v1/verify') return NextResponse.json({ access_token: token });
      if (path === '/auth/v1/user' && options.method !== 'PUT') return NextResponse.json({ id: uid, email: 'owner@test.org' });
      if (path === '/auth/v1/user') return NextResponse.json({ id: uid });
      if (path.includes('grant_type=password')) return badPassword ? NextResponse.json({ error_code: 'invalid_credentials' }, { status: 400 }) : NextResponse.json({ access_token: passwordToken, refresh_token: 'refresh', expires_in: 3600 });
      if (/recover|resend/.test(path)) return badEmail ? NextResponse.json({ error_code: 'over_email_send_rate_limit' }, { status: 429 }) : NextResponse.json({});
      throw new Error('Unexpected request: ' + path);
    } },
  };
  const route = load('app/api/studio/password/route.ts', deps), authRoute = load('app/api/studio/auth/route.ts', deps);
  const post = body => route.POST(new Request('https://hub.test/api/studio/password', { method: 'POST', headers: { origin: 'https://hub.test', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { route, authRoute, post, jar, calls, sets, token, passwordToken, failPassword: () => { badPassword = true; }, failEmail: () => { badEmail = true; } };
}
test('recovery verification is isolated, scoped, resumable, and cleared after reset', async () => {
  const f = fixture();
  const begin = await f.post({ action: 'begin', tokenHash: 'a'.repeat(64) });
  assert.equal(begin.status, 200);
  assert.deepEqual(await begin.json(), { ready: true, email: 'owner@test.org' });
  assert.equal(f.jar.has('studio_access'), false, 'verification must not grant normal web sign-in');
  assert.deepEqual(f.calls[0].options.body, { token_hash: 'a'.repeat(64), type: 'recovery' });
  assert.equal(f.sets[0].options.httpOnly, true);
  assert.equal(f.sets[0].options.sameSite, 'strict');
  assert.equal(f.sets[0].options.path, '/api/studio/password');
  assert.equal((await f.route.GET()).status, 200);
  const update = await f.post({ action: 'reset', password: 'new-long-password' });
  assert.equal(update.status, 200);
  assert.equal(f.calls.find(c => c.options.method === 'PUT').options.token, f.token);
  assert.equal(f.jar.get('studio_password_recovery'), '');
  assert.equal((await f.post({ action: 'reset', password: 'new-long-password' })).status, 401, 'recovery is no longer reusable after reset');
});
test('ordinary login cannot be relabelled as recovery or used instead of its cookie', async () => {
  const f = fixture(); f.jar.set('studio_access', f.passwordToken);
  assert.equal((await f.post({ action: 'reset', password: 'new-password' })).status, 401);
  assert.equal((await f.post({ action: 'begin', accessToken: f.passwordToken, type: 'recovery' })).status, 400);
  assert.equal(f.calls.some(c => c.options.method === 'PUT'), false);
});
test('expired and untyped implicit recovery credentials are rejected', async () => {
  const f = fixture();
  const claims = { exp: Math.floor(Date.now() / 1000) - 1, amr: [{ method: 'otp', timestamp: 1 }] };
  const expired = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
  assert.equal((await f.post({ action: 'begin', accessToken: expired, type: 'recovery' })).status, 400);
  assert.equal((await f.post({ action: 'begin', accessToken: f.token, type: 'email' })).status, 400);
  assert.equal(f.jar.has('studio_password_recovery'), false);
});
test('changing password verifies the current password and retains the user identity', async () => {
  const f = fixture(); f.jar.set('studio_access', f.passwordToken);
  assert.equal((await f.post({ action: 'change', currentPassword: 'old-password', password: 'new-password' })).status, 200);
  assert.deepEqual(f.calls.find(c => c.path.includes('grant_type=password')).options.body, { email: 'owner@test.org', password: 'old-password' });
  assert.equal(f.jar.get('studio_access'), f.passwordToken);
  const denied = fixture(); denied.jar.set('studio_access', denied.passwordToken); denied.failPassword();
  const response = await denied.post({ action: 'change', currentPassword: 'wrong', password: 'new-password' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_current_password');
  assert.equal(denied.calls.some(c => c.options.method === 'PUT'), false);
});
test('invalid origins, short passwords and anonymous changes cannot mutate an account', async () => {
  const f = fixture();
  assert.equal((await f.post({ action: 'reset', password: 'short' })).status, 400);
  assert.equal((await f.post({ action: 'change', currentPassword: 'old-password', password: 'new-password' })).status, 401);
  const evil = new Request('https://hub.test/api/studio/password', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'begin', accessToken: f.token, type: 'recovery' }) });
  assert.equal((await f.route.POST(evil)).status, 403);
  assert.equal(f.calls.length, 0);
});
test('reset email uses the reset callback and real delivery failures stay failures', async () => {
  const f = fixture();
  const send = () => f.authRoute.POST(new Request('https://hub.test/api/studio/auth', { method: 'POST', headers: { origin: 'https://hub.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'forgot-password', email: 'owner@test.org' }) }));
  assert.deepEqual(await (await send()).json(), { sent: true });
  assert.equal(new URL('https://sb.test' + f.calls[0].path).searchParams.get('redirect_to'), 'https://hub.test/auth/reset');
  f.failEmail();
  assert.equal((await send()).status, 429);
});
test('password reset URLs and page credentials never enter website analytics', () => {
  const metrics = load('components/SiteMetrics.tsx', { 'next/navigation': { usePathname: () => '/auth/reset' }, '@vercel/speed-insights/next': { SpeedInsights: 'speed' }, '@vercel/analytics/react': { Analytics: 'analytics' } });
  assert.equal(metrics.default(), null);
  assert.equal(metrics.filterAuthMetrics({ url: 'https://hub.test/auth/reset?token_hash=secret' }), null);
  assert.equal(metrics.filterAuthMetrics({ url: 'https://hub.test/build' }).url, 'https://hub.test/build');
});
