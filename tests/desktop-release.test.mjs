import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)((n) => deps[n] ?? require(n), m, m.exports); return m.exports;
}
const lib = load('lib/desktop-release.ts');
const asset = (name) => ({ name, size: 182_000_000, browser_download_url: `https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/download/v0.3.0/${name}` });
const release = (tag, at, extra = {}) => ({ tag_name: tag, published_at: at, draft: false, prerelease: false, html_url: `https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/tag/${tag}`, assets: [], ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the newest non-draft release wins, prereleases included', () => {
  const picked = lib.pickDesktopRelease([
    release('v0.2.0', '2026-10-01T00:00:00Z', { assets: [asset('HumanStudy-Hub-0.2.0-mac-arm64.dmg')] }),
    release('v0.4.0', '2026-10-14T00:00:00Z', { draft: true, assets: [asset('HumanStudy-Hub-0.4.0-mac-arm64.dmg')] }),
    release('v0.3.0-beta.1', '2026-10-10T00:00:00Z', { prerelease: true, assets: [asset('HumanStudy-Hub-0.3.0-mac-arm64.dmg'), asset('HumanStudy-Hub-0.3.0-mac-x64.dmg'), asset('HumanStudy-Hub-0.3.0-mac-arm64.dmg.blockmap')] }),
  ]);
  assert.equal(picked.version, 'v0.3.0-beta.1');
  assert.equal(picked.prerelease, true);
  assert.equal(picked.publishedAt, '2026-10-10T00:00:00Z');
  assert.match(picked.macArm64.url, /0\.3\.0-mac-arm64\.dmg$/);
  assert.match(picked.macX64.url, /0\.3\.0-mac-x64\.dmg$/);
  assert.match(picked.pageUrl, /releases\/tag\/v0\.3\.0-beta\.1$/);
});

test('a release without matching assets keeps the version but links nothing broken', () => {
  const picked = lib.pickDesktopRelease([release('v0.1.0', '2026-10-01T00:00:00Z', { assets: [asset('HumanStudy-Hub-0.1.0-mac-universal.zip'), asset('notes-mac-arm64.dmg.sig')] })]);
  assert.equal(picked.version, 'v0.1.0');
  assert.equal(picked.macArm64, null);
  assert.equal(picked.macX64, null);
});

test('empty, draft-only or malformed payloads fall back to the releases page', () => {
  for (const payload of [[], [release('v1', '2026-10-01T00:00:00Z', { draft: true })], { message: 'Not Found' }, null, 'x']) {
    const picked = lib.pickDesktopRelease(payload);
    assert.equal(picked.version, null);
    assert.equal(picked.pageUrl, 'https://github.com/HumanStudy-Hub/humanstudy-desktop/releases');
    assert.equal(picked.macArm64, null);
  }
});

test('fetching sends the token when present, retries without it on 401, and never throws', async () => {
  const calls = [];
  const ok = await lib.getDesktopRelease(async (url, init) => { calls.push(init.headers.Authorization); return json([release('v0.3.0', '2026-10-10T00:00:00Z', { assets: [asset('a-mac-arm64.dmg')] })]); }, 'tok');
  assert.equal(ok.version, 'v0.3.0');
  assert.deepEqual(calls, ['Bearer tok']);

  calls.length = 0;
  const retried = await lib.getDesktopRelease(async (url, init) => { calls.push(init.headers.Authorization); return init.headers.Authorization ? json({ message: 'Bad credentials' }, 401) : json([release('v0.3.0', '2026-10-10T00:00:00Z')]); }, 'stale');
  assert.equal(retried.version, 'v0.3.0');
  assert.deepEqual(calls, ['Bearer stale', undefined]);

  assert.equal((await lib.getDesktopRelease(async () => json({ message: 'rate limited' }, 403), undefined)).version, null);
  assert.equal((await lib.getDesktopRelease(async () => { throw new Error('offline'); }, undefined)).version, null);
  assert.equal((await lib.getDesktopRelease(async () => new Response('not json'), undefined)).version, null);
});

test('sizes read as whole megabytes', () => {
  assert.equal(lib.formatSize(182_400_000), '182 MB');
  assert.equal(lib.formatSize(0), '');
});
