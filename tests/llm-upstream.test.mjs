import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const js = ts.transpileModule(fs.readFileSync(new URL('../lib/llm-upstream.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = { exports: {} }; new Function('require', 'module', 'exports', js)(require, m, m.exports);
const lib = m.exports;

function mockFetch(answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const a = answers[url.includes('anthropic') ? 'anthropic' : 'openrouter'];
    if (a instanceof Error) throw a;
    return new Response(a.body ?? 'data: {}\n\n', { status: a.status ?? 200 });
  };
  return calls;
}
const signal = new AbortController().signal;
const req = { model: 'anthropic/claude-sonnet-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }], parallel_tool_calls: true, provider: { order: ['x'] } };

test('maps model ids', () => {
  assert.equal(lib.anthropicModel('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5-5');
  assert.equal(lib.anthropicModel('anthropic/claude-haiku-5.5'), 'claude-haiku-5-5');
  assert.equal(lib.anthropicModel('deepseek/deepseek-v4.1-flash'), null);
});

test('Claude goes to Anthropic first, with OpenRouter-only fields removed', async () => {
  process.env.ANTHROPIC_API_KEY = 'a'; process.env.OPENROUTER_API_KEY = 'o';
  const calls = mockFetch({ anthropic: {}, openrouter: {} });
  const r = await lib.chatCompletions(req, 'u1', signal);
  assert.equal(r.via, 'anthropic');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
  assert.equal(calls[0].body.provider, undefined);
  assert.equal(calls[0].body.user, undefined);
  assert.equal(calls[0].body.parallel_tool_calls, undefined); // no tools
  assert.equal(calls[0].body.stream, true);
});

test('any Anthropic error falls back to OpenRouter with the original body', async () => {
  for (const anthropic of [{ status: 400, body: '{"error":"credit balance too low"}' }, { status: 529 }, new Error('network')]) {
    const calls = mockFetch({ anthropic, openrouter: {} });
    const r = await lib.chatCompletions(req, 'u1', signal);
    assert.equal(r.via, 'openrouter');
    assert.ok(r.fallback);
    assert.equal(calls[1].body.model, 'anthropic/claude-sonnet-5.5');
    assert.equal(calls[1].body.user, 'hsd:u1');
  }
});

test('without the key, or for other models, OpenRouter only', async () => {
  let calls = mockFetch({ anthropic: {}, openrouter: {} });
  assert.equal((await lib.chatCompletions({ ...req, model: 'deepseek/deepseek-v4.1-flash' }, 'u1', signal)).via, 'openrouter');
  assert.equal(calls.length, 1);
  delete process.env.ANTHROPIC_API_KEY;
  calls = mockFetch({ anthropic: {}, openrouter: {} });
  assert.equal((await lib.chatCompletions(req, 'u1', signal)).via, 'openrouter');
  assert.equal(calls.length, 1);
});
