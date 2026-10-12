import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const js = ts.transpileModule(fs.readFileSync(new URL('../lib/studio/web-access.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = { exports: {} }; new Function('require', 'module', 'exports', 'process', js)(require, m, m.exports, process); const web = m.exports;
const at = (status) => ({ pipeline: { status } });

test('the web runs only the first build, and runs it again only after a failure', () => {
  assert.equal(web.webAgentAllowed({}, 'build'), true);
  assert.equal(web.webAgentAllowed(at('failed'), 'build'), true);
  for (const s of ['preparing', 'queued', 'running', 'review', 'complete']) assert.equal(web.webAgentAllowed(at(s), 'build'), false, s);
  assert.equal(web.webAgentAllowed({}, 'discuss'), false);
});

test('the page offers the app once the first build has produced a package', () => {
  assert.equal(web.continueInApp({}), false);
  assert.equal(web.continueInApp(at('running')), false);
  assert.equal(web.continueInApp(at('failed')), false);
  assert.equal(web.continueInApp(at('review')), true);
  assert.equal(web.continueInApp(at('complete')), true);
  assert.match(web.DESKTOP_DOWNLOAD_URL, /humanstudy-desktop\/releases/);
});
