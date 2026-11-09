import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps = {}) {
  const js = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)(id => deps[id] ?? require(id), m, m.exports); return m.exports;
}
const { readProtocol } = load('lib/research.ts');
const [full, future] = JSON.parse(readFileSync(new URL('./fixtures/research-protocol.json', import.meta.url), 'utf8')).papers;

test('protocol summary reads quality level, arms, exclusions and the participant view', () => {
  const p = readProtocol(full);
  assert.equal(p.slug, 'example2001fixture');
  assert.equal(p.schemaKnown, true);
  assert.equal(p.schemaRunnable, true);
  assert.equal(p.fidelity.verdict, 'high fidelity');
  assert.deepEqual(p.fidelity.signedBy, ['reviewer-agent', 'maintainer']);
  assert.deepEqual(p.arms.map(a => [a.id, a.runnable, a.nPaper]), [['control', true, 40], ['treatment', true, 41], ['lab', false, null]]);
  assert.equal(p.runExcluded[0].what, 'lab');
  assert.equal(p.effects, 3);
  assert.equal(p.preview, 'https://example.org/preview/example2001fixture/');
});

test('Bench B3 block (shared fixture, protocol v1) reads as known and runnable', () => {
  const block = JSON.parse(readFileSync(new URL('./fixtures/research-index-protocol.json', import.meta.url), 'utf8'));
  const p = readProtocol(block);
  assert.equal(p.schemaVersion, '1'); assert.equal(p.schemaKnown, true); assert.equal(p.schemaRunnable, true);
  assert.equal(p.fidelity.verdict, 'high fidelity'); assert.deepEqual(p.fidelity.signedBy, ['fixture-maintainer']);
  assert.deepEqual(p.arms, [{ id: 'main', label: 'main', runnable: true, nPaper: 40 }]); assert.equal(p.effects, 1);
  assert.equal(p.revision, block.protocol.revision);
  assert.equal(p.preview, null);
});

test('a participant view is linked only when the entry marks it public (protocols are private by policy)', () => {
  const { previewPublic, ...rest } = full.protocol;
  assert.equal(previewPublic, true);
  assert.equal(readProtocol({ protocol: rest }).preview, null, 'no flag, no link');
  assert.equal(readProtocol({ protocol: { ...rest, previewPublic: 'true' } }).preview, null, 'only literal true');
  assert.equal(readProtocol({ protocol: { ...rest, preview_public: true } }).preview, rest.preview);
  assert.equal(readProtocol({ protocol: { ...rest, previewPublic: true, preview: 'http://example.org/x' } }).preview, null);
});

test('verdicts normalise, slugs follow hsenv ids, conditions get readable labels', () => {
  for (const v of ['high_fidelity', 'HIGH_FIDELITY', ' High  Fidelity ']) assert.equal(readProtocol({ protocol: { ...full.protocol, fidelity: { verdict: v } } }).fidelity.verdict, 'high fidelity');
  for (const slug of ['example_2001_fixture', '0example', 'ab']) assert.equal(readProtocol({ protocol: { ...full.protocol, slug } }).slug, slug);
  for (const slug of ['Example', '_x', 'a.b', 'a/b', 'x'.repeat(81)]) assert.equal(readProtocol({ protocol: { ...full.protocol, slug } }), null, slug);
  const arms = readProtocol({ protocol: { ...full.protocol, arms: [{ id: 'high_anchor', runnable: true }, { id: 'low', label: 'Low anchor', runnable: true }] } }).arms;
  assert.deepEqual(arms.map(a => [a.id, a.label]), [['high_anchor', 'high anchor'], ['low', 'Low anchor']]);
});

test('legacy 0.8 entries still read, but are not runnable', () => {
  const p = readProtocol({ protocol: { ...full.protocol, schemaVersion: '0.8' } });
  assert.equal(p.schemaKnown, true); assert.equal(p.schemaRunnable, false);
});

test('a newer or malformed protocol block degrades instead of breaking the page', () => {
  const p = readProtocol(future);
  assert.equal(p.schemaKnown, false);
  assert.deepEqual(p.arms, []);
  assert.equal(p.fidelity.verdict, null);
  assert.equal(p.effects, null);
  assert.equal(p.revision, null);
  assert.equal(p.preview, null, 'only https previews are linked');
  assert.equal(readProtocol({}), null);
  assert.equal(readProtocol({ protocol: { slug: '../x' } }), null);
});
