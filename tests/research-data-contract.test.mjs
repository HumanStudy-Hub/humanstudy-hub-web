import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = fs.readFileSync(new URL('../lib/research-data/contract.ts', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20261022223132_research_data_contract_v1.sql', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = { exports: {} }; new Function('require', 'module', 'exports', js)(() => { throw new Error('contract.ts must not import'); }, m, m.exports);
const c = m.exports;

const NOW = Date.parse('2026-10-22T12:00:00Z');
const base = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', contract_version: c.CONTRACT_VERSION, surface: 'desktop',
  install_id: 'install-0001', research_session_id: '22222222-2222-4222-8222-222222222222', client_seq: 1,
  data_type: 'interaction', event_type: 'action.invoke', occurred_at: '2026-10-22T11:59:00Z',
  target: 'artifact.open', view: 'artifacts', action_id: '11111111-1111-4111-8111-111111111111',
  metadata: { via: 'keyboard' }, content_refs: [], app_version: '0.7.0', collector_version: 'desktop-collector/1.0.0',
  consent_version: 3, platform: 'darwin', ...over,
});
const sha = 'a'.repeat(64);

test('contract file is vendorable: no imports, versioned', () => {
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /require\(/);
  assert.equal(c.CONTRACT_VERSION, '1.0.0');
});

test('catalog covers every agreed data type', () => {
  const covered = new Set(Object.values(c.EVENTS).map((s) => s.dataType));
  for (const t of c.DATA_TYPES) assert.ok(covered.has(t), t);
  for (const t of Object.keys(c.EVENTS)) assert.equal(c.isProhibitedEventType(t), false, t);
});

test('database enumerations and prohibition match the contract', () => {
  for (const t of c.DATA_TYPES) assert.match(migration, new RegExp(`'${t}'`));
  for (const s of c.SURFACES) assert.match(migration, new RegExp(`'${s}'`));
  assert.ok(migration.includes(c.PROHIBITED_EVENT_RE.source), 'SQL prohibition regex differs from contract.ts');
  assert.ok(migration.includes(`'${c.CONTENT_BUCKET}'`));
});

test('a mouse and a keyboard route to the same action validate identically', () => {
  assert.deepEqual(c.validateResearchEvent(base(), NOW), []);
  assert.deepEqual(c.validateResearchEvent(base({ metadata: { via: 'pointer' } }), NOW), []);
});

test('primary action must be its own action; follow-ups link to it', () => {
  assert.ok(c.validateResearchEvent(base({ action_id: '33333333-3333-4333-8333-333333333333' }), NOW).some((e) => e.includes('primary')));
  const reply = base({
    id: '44444444-4444-4444-8444-444444444444', client_seq: 2, data_type: 'conversation', event_type: 'conversation.message',
    thread_id: 'ses_1', message_id: 'msg_1', caused_by: base().id, target: null, view: null,
    metadata: { role: 'assistant', part: 0, part_kind: 'text', status: 'interrupted', text: 'Partial answer' },
  });
  assert.deepEqual(c.validateResearchEvent(reply, NOW), []);
});

test('offline events of any age are valid; future clocks are not', () => {
  assert.deepEqual(c.validateResearchEvent(base({ occurred_at: '2026-06-01T00:00:00Z' }), NOW), []);
  assert.ok(c.validateResearchEvent(base({ occurred_at: '2026-10-22T13:00:00Z' }), NOW).includes('occurred_at is in the future'));
});

test('prohibited streams and unknown types are rejected', () => {
  for (const t of ['pointer.move', 'ui.mousemove', 'input.keystroke', 'replay.rrweb', 'mouse.trajectory'])
    assert.ok(c.validateResearchEvent(base({ event_type: t }), NOW).includes('event_type is a prohibited continuous stream'), t);
  assert.ok(c.validateResearchEvent(base({ event_type: 'ui.click' }), NOW).some((e) => e.includes('not in contract')));
});

test('long content must be referenced, not inlined or truncated', () => {
  const tool = (meta, refs = []) => base({
    data_type: 'agent_execution', event_type: 'tool.end', target: 'bash', thread_id: 't1', tool_call_id: 'call_1',
    view: null, action_id: null, metadata: { status: 'completed', ...meta }, content_refs: refs,
  });
  assert.ok(c.validateResearchEvent(tool({ output: 'x'.repeat(9000) }), NOW).some((e) => e.includes('inline')));
  assert.deepEqual(c.validateResearchEvent(tool({}, [{ role: 'output', sha256: sha, bytes: 9000, mime: 'text/plain' }]), NOW), []);
  assert.deepEqual(c.validateResearchEvent(tool({ output_absent: true }), NOW), []);
  assert.ok(c.validateResearchEvent(tool({}, [{ role: 'output', sha256: 'abc', bytes: 1 }]), NOW).some((e) => e.includes('sha256')));
});

test('source import is identified by content hash', () => {
  const ev = base({ data_type: 'source_input', event_type: 'source.import', source_id: sha, target: null, view: null, action_id: null,
    metadata: { provenance: 'upload', filename: 'knobe2003.pdf' }, content_refs: [{ role: 'source', sha256: sha, bytes: 812345, mime: 'application/pdf' }] });
  assert.deepEqual(c.validateResearchEvent(ev, NOW), []);
});

test('sanitizer removes credentials, emails and machine paths but keeps hashes and URLs', () => {
  const s = c.scrubResearchString('mail a@b.org key sk-or-v1-abcdefghijklmnop at /Users/alice/x.txt see https://doi.org/10.1/x ' + sha,
    { email: 'a@b.org' });
  assert.doesNotMatch(s, /a@b\.org|sk-or|\/Users\/alice/);
  assert.match(s, /https:\/\/doi\.org\/10\.1\/x/);
  assert.ok(s.includes(sha));
  assert.equal(c.scrubResearchString('/proj/dir/program.json', { projectDir: '/proj/dir' }), 'program.json');
  assert.deepEqual(c.scrubResearchValue({ token: 'x', note: 'C:\\Users\\bob\\f.txt' }), { note: '[path]' });
});

test('parts split content without losing bytes', () => {
  const r = c.partRanges(9 * 1024 * 1024);
  assert.equal(r.length, 3);
  assert.equal(r[0][0], 0);
  assert.equal(r.at(-1)[1], 9 * 1024 * 1024);
  for (let i = 1; i < r.length; i++) assert.equal(r[i][0], r[i - 1][1]);
  assert.deepEqual(c.partRanges(10), [[0, 10]]);
});
