import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => dependencies[name] || require(name), module, module.exports);
  return module.exports;
}
const policy = load('lib/studio/auth-policy.ts');
const hash = 'a'.repeat(64);
const destination = 'https://forum.humanstudy-hub.com/posts/example?view=all&sort=new';
const nested = path => `https://humanstudy-hub.com/auth/${path}?returnTo=${encodeURIComponent(destination)}`;
function page(path) {
  return load(`app/auth/${path}/page.tsx`, {
    '@/lib/studio/auth-policy': policy,
    '@/components/studio/confirm-email': { default: 'confirm' },
    '@/components/studio/reset-password': { default: 'reset' },
  }).default;
}

test('documented email hrefs carry independent token and encoded callback parameters end to end', async () => {
  const docs = fs.readFileSync(new URL('../docs/shared-forum-account.md', import.meta.url), 'utf8');
  for (const path of ['confirm', 'reset']) {
    const template = docs.match(new RegExp(`<a href="(https://humanstudy-hub\\.com/auth/${path}[^\"]+)"`))[1];
    const href = template.replace('{{ .TokenHash }}', hash).replace('{{ .RedirectTo | urlquery }}', encodeURIComponent(nested(path))).replaceAll('&amp;', '&');
    const url = new URL(href);
    assert.equal(url.searchParams.get('token_hash'), hash);
    assert.equal(url.searchParams.get('callback'), nested(path));
    const tree = await page(path)({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) });
    assert.equal(tree.props.tokenHash, hash);
    assert.equal(tree.props.invalid, false);
    assert.equal(tree.props.returnTo, destination);
  }
});

test('nested callbacks are origin-bound, flow-bound and discard credentials and extra token parameters', () => {
  const invalid = [
    'https://evil.com/auth/confirm?returnTo=' + encodeURIComponent(destination),
    'https://humanstudy-hub.com.evil.com/auth/confirm?returnTo=' + encodeURIComponent(destination),
    'http://humanstudy-hub.com/auth/confirm?returnTo=' + encodeURIComponent(destination),
    'https://user@humanstudy-hub.com/auth/confirm?returnTo=' + encodeURIComponent(destination),
    nested('reset'), nested('confirm') + '#access_token=secret', nested('confirm') + '&access_token=secret',
    nested('confirm') + '&returnTo=' + encodeURIComponent(destination),
    'https://humanstudy-hub.com/auth/confirm?returnTo=' + encodeURIComponent('https://forum.humanstudy-hub.com/?access_token=secret'),
    'https://humanstudy-hub.com/auth/confirm?returnTo=' + encodeURIComponent('https://evil.com/'),
    'https://humanstudy-hub.com/auth/confirm?callback=' + encodeURIComponent(nested('confirm')),
    'x'.repeat(8193), [nested('confirm')], nested('confirm') + String.fromCharCode(10),
  ];
  for (const callback of invalid) assert.equal(policy.emailCallbackReturnTo({ callback }, 'confirm'), undefined, String(callback));
  assert.equal(policy.emailCallbackReturnTo({ callback: nested('confirm') }, 'reset'), undefined);
  assert.equal(policy.emailCallbackReturnTo({ callback: nested('reset') }, 'reset'), destination);
});

test('legacy bare links and explicit allowlisted returnTo remain supported on both pages', async () => {
  for (const path of ['confirm', 'reset']) {
    const params = { token_hash: hash, type: path === 'confirm' ? 'email' : 'recovery' };
    const bare = await page(path)({ searchParams: Promise.resolve(params) });
    assert.equal(bare.props.tokenHash, hash);
    assert.equal(bare.props.invalid, false);
    assert.equal(bare.props.returnTo, undefined);
    const explicit = await page(path)({ searchParams: Promise.resolve({ ...params, returnTo: destination }) });
    assert.equal(explicit.props.returnTo, destination);
  }
});

test('untrusted return URLs reject embedded whitespace and backslashes before URL normalization', () => {
  assert.equal(policy.accountReturnTo('https://forum.humanstudy-hub.com/pa' + String.fromCharCode(10) + 'th'), undefined);
  assert.equal(policy.emailCallbackReturnTo({ callback: nested('confirm') + String.fromCharCode(92) }, 'confirm'), undefined);
});
