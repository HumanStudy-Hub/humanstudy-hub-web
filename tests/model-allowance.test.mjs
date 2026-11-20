import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)((n) => deps[n] ?? require(n), m, m.exports); return m.exports;
}
const user = '11111111-1111-4111-8111-111111111111';
let quotaEnvironment = 'production';
const lib = load('lib/model-allowance.ts', { 'server-only': {}, './hosted-model-quota': { hostedQuotaEnvironment: () => quotaEnvironment }, './try-online-config': { tryServiceKey: () => 'service-fixture' } });
const now = Date.parse('2026-11-20T00:00:00Z'), future = '2027-01-01T00:00:00Z', past = '2026-11-01T00:00:00Z';
const row = (microusd, requests, extra = {}) => ({ remaining_microusd: microusd, remaining_requests: requests, expires_at: future, revoked: false, ...extra });

test('percent left is the smaller of dollar and request share, floored', () => {
  assert.equal(lib.ALLOWANCE_TOTAL_MICROUSD, 10_000_000); assert.equal(lib.ALLOWANCE_TOTAL_REQUESTS, 500);
  assert.deepEqual(lib.summarizeAllowance(row(10_000_000, 500), now), { available: true, percentLeft: 100, requestsLeft: 500, revoked: false, expired: false });
  assert.equal(lib.summarizeAllowance(row(8_700_000, 490), now).percentLeft, 87);
  assert.equal(lib.summarizeAllowance(row(9_900_000, 250), now).percentLeft, 50);
  assert.equal(lib.summarizeAllowance(row(9_999, 500), now).percentLeft, 1); // still usable: never show 0%
  assert.equal(lib.summarizeAllowance(row(10_000_000, 1), now).percentLeft, 1);
  assert.equal(lib.summarizeAllowance(row(0, 500), now).percentLeft, 0);
  assert.equal(lib.summarizeAllowance(row(10_000_000, 0), now).percentLeft, 0);
  assert.equal(lib.summarizeAllowance(row('5000000', '400'), now).percentLeft, 50); // bigint columns may arrive as strings
});

test('percent is clamped to 0-100', () => {
  assert.equal(lib.summarizeAllowance(row(25_000_000, 900), now).percentLeft, 100);
  assert.deepEqual(lib.summarizeAllowance(row(-5, -1), now), { available: true, percentLeft: 0, requestsLeft: 0, revoked: false, expired: false });
  assert.equal(lib.summarizeAllowance(row(null, 'x'), now).percentLeft, 0);
});

test('revoked or expired grants show 0, missing row is unavailable', () => {
  assert.deepEqual(lib.summarizeAllowance(row(10_000_000, 500, { revoked: true }), now), { available: true, percentLeft: 0, requestsLeft: 0, revoked: true, expired: false });
  assert.deepEqual(lib.summarizeAllowance(row(10_000_000, 500, { expires_at: past }), now), { available: true, percentLeft: 0, requestsLeft: 0, revoked: false, expired: true });
  assert.equal(lib.summarizeAllowance(row(10_000_000, 500, { expires_at: null }), now).percentLeft, 0);
  assert.deepEqual(lib.summarizeAllowance(null, now), { available: false, percentLeft: 0, requestsLeft: 0, revoked: false, expired: false });
});

test('accountAllowance reads only this account production row with the service role and never returns dollars', async t => {
  const saved = process.env.SUPABASE_URL; process.env.SUPABASE_URL = 'https://db.test';
  t.after(() => { if (saved === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved; });
  const urls = []; let rows = [row(5_000_000, 450)];
  t.mock.method(globalThis, 'fetch', async (url, init) => { urls.push(String(url)); assert.equal(init.headers.Authorization, 'Bearer service-fixture'); return Response.json(rows); });
  const result = await lib.accountAllowance(user);
  assert.deepEqual(result, { available: true, percentLeft: 50, requestsLeft: 450, revoked: false, expired: false });
  assert.ok(!('remaining_microusd' in result));
  assert.match(urls[0], new RegExp(`budget_key=eq\\.${encodeURIComponent(`production:account:${user}`)}`));
  rows = []; assert.equal((await lib.accountAllowance(user)).available, false);
  assert.equal((await lib.accountAllowance('not-a-uuid')).available, false); assert.equal(urls.length, 2);
  quotaEnvironment = 'dev'; rows = [row(10_000_000, 500)];
  assert.equal((await lib.accountAllowance(user)).percentLeft, 100);
  assert.match(urls[2], new RegExp(`budget_key=eq\\.${encodeURIComponent(`dev:account:${user}`)}`));
  quotaEnvironment = null;
  assert.deepEqual(await lib.accountAllowance(user), { available: false, percentLeft: 0, requestsLeft: 0, revoked: false, expired: false });
  assert.equal(urls.length, 3); quotaEnvironment = 'production';
});

function route({ desktopUser = null, sessionUser = null, sessionError = null } = {}) {
  class StudioError extends Error { constructor(status, code) { super(code); this.status = status; } }
  const calls = [];
  const mod = load('app/api/desktop/allowance/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/desktop-access': { bearer: r => { const v = r.headers.get('authorization') || ''; return v.toLowerCase().startsWith('bearer ') ? v.slice(7).trim() : null; }, verifyDesktopKey: key => key === 'hsd_v1.valid' ? desktopUser : null },
    '@/lib/model-allowance': { accountAllowance: async id => { calls.push(id); return { available: true, percentLeft: 87, requestsLeft: 400, revoked: false, expired: false }; } },
    '@/lib/studio/auth': { requireStudioUser: async () => { if (sessionError) throw sessionError(StudioError); if (!sessionUser) throw new StudioError(401, 'unauthorized'); return { user: { id: sessionUser } }; } },
    '@/lib/studio/http': { StudioError },
  });
  return { GET: mod.GET, calls };
}
const req = auth => new Request('https://hub.test/api/desktop/allowance', { headers: auth ? { authorization: auth } : {} });

test('allowance route: 401 without a valid desktop key or session, no-store always', async () => {
  let r = route();
  let res = await r.GET(req()); assert.equal(res.status, 401); assert.equal(res.headers.get('cache-control'), 'no-store');
  res = await route({ desktopUser: user, sessionUser: user }).GET(req('Bearer hsd_v1.forged')); assert.equal(res.status, 401); // a bad key never falls back to cookies
  r = route({ sessionError: E => new E(503, 'setup_required') });
  assert.equal((await r.GET(req())).status, 503); assert.equal(r.calls.length, 0);
});

test('allowance route: desktop key or web session returns the percent summary for that account', async () => {
  let r = route({ desktopUser: user });
  let res = await r.GET(req('Bearer hsd_v1.valid'));
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { available: true, percentLeft: 87, requestsLeft: 400, revoked: false, expired: false }); assert.deepEqual(r.calls, [user]);
  r = route({ sessionUser: user });
  res = await r.GET(req()); assert.equal(res.status, 200); assert.deepEqual(r.calls, [user]);
});
