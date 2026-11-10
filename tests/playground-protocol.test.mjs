import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, deps = {}) {
  const js = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)(id => deps[id] ?? require(id), m, m.exports); return m.exports;
}
const research = load('lib/research.ts');
const protocols = load('lib/protocols.ts', { '@/lib/research': research, 'server-only': {} });
const runs = load('lib/playground-runs.ts', { '@/lib/research': research, '@/lib/protocols': protocols, '@/lib/persona-groups': { normaliseGroup: x => x } });
const [full] = JSON.parse(readFileSync(new URL('./fixtures/research-protocol.json', import.meta.url), 'utf8')).papers;
const protocol = research.readProtocol(full);

test('protocol options default to the paper n, one seed and all runnable arms', () => {
  assert.deepEqual(runs.validateProtocolOptions({}, protocol, 10), { rendering: 'screen', n: 'paper', seeds: [42], arms: null, maxRetries: 2 });
});

test('protocol options cap n, dedupe seeds and refuse non-runnable arms or renderings', () => {
  const o = runs.validateProtocolOptions({ n: 500, seeds: [1, 1, 2, -3], arms: ['control'], rendering: 'chat' }, protocol, 10);
  assert.equal(o.n, 10); assert.deepEqual(o.seeds, [1, 2]); assert.deepEqual(o.arms, ['control']); assert.equal(o.rendering, 'chat');
  assert.throws(() => runs.validateProtocolOptions({ arms: ['lab'] }, protocol, 10), /Not runnable/);
  assert.throws(() => runs.validateProtocolOptions({ rendering: 'voice' }, protocol, 10), /screen, screen\+seen or chat/);
  assert.throws(() => runs.validateProtocolOptions({}, { ...protocol, schemaRunnable: false }, 10), /Only protocol v1/);
  assert.throws(() => runs.validateProtocolOptions({}, { ...protocol, arms: [{ id: 'a', runnable: false }] }, 10), /No arm/);
});

test('both protocol flags are off by default', () => {
  delete process.env.PROTOCOL_RUNS_ENABLED; delete process.env.PRIVATE_PROTOCOLS_ENABLED;
  assert.equal(runs.protocolRunsEnabled(), false);
  assert.equal(protocols.privateProtocolsEnabled(), false);
  process.env.PRIVATE_PROTOCOLS_ENABLED = '1'; process.env.HUMANSTUDY_PROTOCOLS_TOKEN = 'x';
  assert.equal(protocols.privateProtocolsEnabled(), false, 'no repo name, no private reads');
  delete process.env.PRIVATE_PROTOCOLS_ENABLED; delete process.env.HUMANSTUDY_PROTOCOLS_TOKEN;
});

test('createRun refuses a protocol run while PROTOCOL_RUNS_ENABLED is off', async () => {
  delete process.env.PROTOCOL_RUNS_ENABLED;
  const input = { studyId: full.id, model: 'example/model', preset: 'v1_empty' };
  await assert.rejects(runs.createRun(input), /not enabled/);
  await assert.rejects(runs.createRun({ ...input, studyId: 'study_001', kind: 'protocol' }), /not enabled/);
});

test('private index projection keeps metadata only', () => {
  const canary = 'CANARY-PROTOCOL-TEXT';
  const entry = protocols.projectPrivateEntry({
    slug: 'example2001fixture', schema_version: '1', paper: { title: 'Example private study', authors: ['A. Example'], year: 2001 },
    fidelity: { verdict: 'high fidelity', signed_by: ['maintainer'], review: canary },
    arms: [{ id: 'control', runnable: true, text: canary }], protocol: { stages: [canary] }, notes: canary,
  });
  assert.equal(entry.title, 'Example private study');
  assert.deepEqual(entry.protocol.arms, [{ id: 'control', label: 'control', runnable: true, nPaper: null }]);
  assert.ok(!JSON.stringify(entry).includes(canary));
  assert.equal(protocols.projectPrivateEntry({ slug: 'x' }), null);
});
