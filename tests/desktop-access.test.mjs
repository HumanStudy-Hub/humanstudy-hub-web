import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)((n) => deps[n] ?? require(n), m, m.exports); return m.exports;
}
const access = { ACCESS_SECRET: 'test-secret', PROMO_CODE: 'OPEN-SESAME' };
const lib = load('lib/desktop-access.ts', { './access': access });

test('a minted key verifies to its user until it expires', () => {
  const now = Date.UTC(2026, 9, 11);
  const { key, expiresAt } = lib.mintDesktopKey('user-1', now);
  assert.match(key, /^hsd_v1\.[\w-]+\.[\w-]+$/);
  assert.equal(lib.verifyDesktopKey(key, now + 1000), 'user-1');
  assert.equal(Date.parse(expiresAt), now + 30 * 86_400_000);
  assert.equal(lib.verifyDesktopKey(key, now + 31 * 86_400_000), null);
});

test('tampered, foreign or malformed keys are rejected', () => {
  const { key } = lib.mintDesktopKey('user-1');
  const [p, payload, sig] = key.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', e: Date.now() + 1e9 })).toString('base64url');
  assert.equal(lib.verifyDesktopKey(`${p}.${forged}.${sig}`), null);
  assert.equal(lib.verifyDesktopKey(`${p}.${payload}.${sig.slice(0, -2)}xx`), null);
  assert.equal(lib.verifyDesktopKey('sk-or-v1-anything'), null);
  assert.equal(lib.verifyDesktopKey(undefined), null);
  const other = load('lib/desktop-access.ts', { './access': { ...access, ACCESS_SECRET: 'other' } });
  assert.equal(other.verifyDesktopKey(key), null);
});

test('the promo code must match exactly, and bearer tokens are read case-insensitively', () => {
  assert.equal(lib.promoMatches('OPEN-SESAME'), true);
  assert.equal(lib.promoMatches(' OPEN-SESAME '), true);
  assert.equal(lib.promoMatches('open-sesame'), false);
  assert.equal(lib.promoMatches(undefined), false);
  assert.equal(lib.bearer(new Request('http://x', { headers: { Authorization: 'bearer abc' } })), 'abc');
  assert.equal(lib.bearer(new Request('http://x')), null);
});
