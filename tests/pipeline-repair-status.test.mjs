import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../lib/pipeline-repair-status.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { pipelineRepairStatus } = loaded.exports;

test('a terminal failed job cannot conceal an interrupted repair behind a stale running flag', () => {
  const repair = { attempted: true, inProgress: true };
  assert.equal(pipelineRepairStatus({ status: 'running', repair }), null);
  assert.equal(pipelineRepairStatus({ status: 'queued', repair }), null);
  assert.deepEqual(pipelineRepairStatus({ status: 'failed', repair }), {
    failed: true, message: 'Automatic repair did not finish.',
  });
});

test('terminal error is shown by the existing error box rather than repeated in the repair line', () => {
  const job = { status: 'failed', error: 'Required source unavailable', repair: { attempted: true, accepted: false } };
  assert.equal(pipelineRepairStatus(job).message, 'Automatic repair did not succeed.');
  assert.equal(pipelineRepairStatus({ ...job, status: 'review' }).message,
    'Automatic repair did not succeed: Required source unavailable');
});

test('older jobs stay silent and accepted repairs require the accepted result and repaired marker', () => {
  assert.equal(pipelineRepairStatus({ status: 'review' }), null);
  assert.equal(pipelineRepairStatus({ status: 'running', repaired: true }), null);
  assert.equal(pipelineRepairStatus({ status: 'review', repair: { accepted: true } }), null);
  for (const [rounds, phrase] of [[1, '1 round;'], [2, '2 rounds;']]) {
    const status = pipelineRepairStatus({ status: 'review', repaired: true, repair: { accepted: true, rounds } });
    assert.equal(status.failed, false);
    assert.ok(status.message.includes(phrase));
    assert.ok(status.message.includes('nothing marked missing was filled'));
  }
});
