import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../lib/github-errors.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'console', compiled)(loaded, loaded.exports, console);
const { describeGitHubError, githubFailureMessage, logGitHubFailure, dispatchWithConfirmedRetry, runMayBelongTo, tokenExpiry, tokenExpiryWarning } = loaded.exports;

const TOKEN = 'github_pat_11SECRETSECRETSECRET';
// The shape @octokit/request throws: status, request (with auth header), response headers.
function octokitError(status, url, headers = {}) {
  const error = new Error(`Bad credentials - https://docs.github.com/rest`);
  error.name = 'HttpError';
  error.status = status;
  error.request = { method: url.includes('dispatches') ? 'POST' : 'GET', url: `https://api.github.com${url}?per_page=1`, headers: { authorization: `token ${TOKEN}` } };
  error.response = { status, url, headers: { 'x-github-request-id': 'ABCD:1234:5678', ...headers }, data: { message: 'Bad credentials' } };
  return error;
}
const jobsGet = '/repos/HumanStudy-Hub/humanstudy-hub-jobs';
const dispatchUrl = '/repos/HumanStudy-Hub/HumanStudy-Bench/actions/workflows/run-humanstudy-pipeline.yml/dispatches';

test('401 and permission 403 map to the renew-access message', () => {
  const expired = describeGitHubError(octokitError(401, jobsGet));
  assert.deepEqual(expired, { kind: 'access', responded: true, status: 401, method: 'GET', endpoint: jobsGet, requestId: 'ABCD:1234:5678' });
  assert.match(githubFailureMessage(octokitError(401, jobsGet)), /can't start builds right now/);
  assert.equal(describeGitHubError(octokitError(403, jobsGet)).kind, 'access');
});

test('rate limits are not reported as expired access', () => {
  assert.equal(describeGitHubError(octokitError(403, jobsGet, { 'x-ratelimit-remaining': '0' })).kind, 'rate_limited');
  assert.equal(describeGitHubError(octokitError(429, jobsGet)).kind, 'rate_limited');
  assert.match(githubFailureMessage(octokitError(429, jobsGet)), /limiting requests/);
});

test('5xx and network failures map to the try-again message', () => {
  assert.equal(describeGitHubError(octokitError(500, dispatchUrl)).kind, 'unavailable');
  assert.equal(describeGitHubError(octokitError(503, dispatchUrl)).kind, 'unavailable');
  // Octokit wraps transport failures as a 500 RequestError with no response.
  const network = Object.assign(new Error('fetch failed'), { status: 500, request: { method: 'POST', url: `https://api.github.com${dispatchUrl}` }, cause: { code: 'ECONNRESET' } });
  assert.equal(describeGitHubError(network).kind, 'unavailable');
  assert.equal(describeGitHubError(network).responded, false);
  assert.equal(githubFailureMessage(octokitError(502, dispatchUrl)), "GitHub didn't respond. Please try again in a minute.");
});

test('other failures keep the caller fallback', () => {
  assert.equal(githubFailureMessage(octokitError(422, dispatchUrl)), undefined);
  assert.equal(githubFailureMessage(new Error('Previous package is not ready.')), undefined);
  assert.equal(githubFailureMessage(undefined), undefined);
  // Supabase/Blob failures in the same try block are not blamed on GitHub.
  assert.equal(githubFailureMessage(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), undefined);
  assert.equal(githubFailureMessage(Object.assign(new Error('x'), { status: 503 })), undefined);
});

test('researcher messages and server logs never carry the token, query or raw GitHub text', () => {
  for (const status of [401, 403, 429, 500]) {
    const message = githubFailureMessage(octokitError(status, jobsGet)) || '';
    assert.ok(!message.includes(TOKEN) && !message.includes('api.github.com') && !message.includes('Bad credentials'));
  }
  const lines = [];
  logGitHubFailure('Studio start x', octokitError(401, jobsGet), (...args) => lines.push(JSON.stringify(args)));
  const logged = lines.join('\n');
  assert.ok(logged.includes('401') && logged.includes(jobsGet) && logged.includes('ABCD:1234:5678'));
  assert.ok(!logged.includes(TOKEN) && !logged.includes('per_page') && !logged.includes('Bad credentials'));
  assert.match(logged, /Renew GITHUB_TOKEN/);
  const blob = []; logGitHubFailure('x', new Error(`could not fetch https://blob.example/p.pdf?token=${TOKEN}`), (...a) => blob.push(JSON.stringify(a)));
  assert.ok(!blob.join().includes(TOKEN) && blob.join().includes('[url]'));
});

const quiet = () => {};
const noSleep = async () => {};

test('a successful dispatch is sent once and never checked', async () => {
  let dispatched = 0, checked = 0;
  const outcome = await dispatchWithConfirmedRetry({ dispatch: async () => { dispatched++; }, alreadyQueued: async () => { checked++; return false; }, sleep: noSleep, log: quiet });
  assert.equal(outcome, 'dispatched');
  assert.equal(dispatched, 1);
  assert.equal(checked, 0);
});

test('a 5xx with no run queued on every check is retried exactly once', async () => {
  let dispatched = 0, checked = 0;
  const slept = [];
  const outcome = await dispatchWithConfirmedRetry({
    dispatch: async () => { dispatched++; if (dispatched === 1) throw octokitError(500, dispatchUrl); },
    alreadyQueued: async () => { checked++; return false; },
    sleep: async (ms) => { slept.push(ms); }, log: quiet,
  });
  assert.equal(outcome, 'retried');
  assert.equal(dispatched, 2);
  assert.equal(checked, 4);
  assert.deepEqual(slept, [4000, 4000, 4000, 4000]);
});

test('a 5xx whose run was in fact queued is not dispatched again', async () => {
  let dispatched = 0, checked = 0;
  const outcome = await dispatchWithConfirmedRetry({
    dispatch: async () => { dispatched++; throw octokitError(500, dispatchUrl); },
    alreadyQueued: async () => { checked++; return checked === 2; }, sleep: noSleep, log: quiet,
  });
  assert.equal(outcome, 'already_queued');
  assert.equal(dispatched, 1);
});

test('a confirmation that cannot be made means no second dispatch', async () => {
  let dispatched = 0;
  const first = octokitError(500, dispatchUrl);
  await assert.rejects(dispatchWithConfirmedRetry({
    dispatch: async () => { dispatched++; throw first; },
    alreadyQueued: async () => { throw octokitError(502, '/repos/x/y/actions/workflows/w/runs'); }, sleep: noSleep, log: quiet,
  }), (error) => error === first);
  assert.equal(dispatched, 1);
});

test('a transport failure that may have delivered the dispatch is never retried', async () => {
  let dispatched = 0, checked = 0;
  const reset = Object.assign(new Error('socket hang up'), { status: 500, request: { method: 'POST', url: `https://api.github.com${dispatchUrl}` }, cause: { code: 'ECONNRESET' } });
  await assert.rejects(dispatchWithConfirmedRetry({ dispatch: async () => { dispatched++; throw reset; }, alreadyQueued: async () => { checked++; return false; }, sleep: noSleep, log: quiet }), (error) => error === reset);
  assert.equal(dispatched, 1);
  assert.equal(checked, 0);
});

test('a second 5xx is surfaced and not retried again', async () => {
  let dispatched = 0;
  await assert.rejects(dispatchWithConfirmedRetry({
    dispatch: async () => { dispatched++; throw octokitError(500, dispatchUrl); },
    alreadyQueued: async () => false, sleep: noSleep, log: quiet,
  }), (error) => error.status === 500);
  assert.equal(dispatched, 2);
});

test('401, 403, 404 and 422 dispatch failures are never retried', async () => {
  for (const status of [401, 403, 404, 422]) {
    let dispatched = 0, checked = 0;
    await assert.rejects(dispatchWithConfirmedRetry({
      dispatch: async () => { dispatched++; throw octokitError(status, dispatchUrl); },
      alreadyQueued: async () => { checked++; return false; }, sleep: noSleep, log: quiet,
    }), (error) => error.status === status);
    assert.equal(dispatched, 1);
    assert.equal(checked, 0);
  }
});

test('any run since the dispatch counts as possibly this job unless it names another job', () => {
  const after = Date.parse('2026-11-03T10:00:00Z');
  const job = 'studio-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222';
  const other = 'studio-33333333-3333-4333-8333-333333333333-44444444-4444-4444-8444-444444444444';
  assert.equal(runMayBelongTo(job, { display_title: 'Build HumanStudy package with Claude Code', created_at: '2026-11-03T10:00:05Z' }, after), true);
  assert.equal(runMayBelongTo(job, { display_title: null, created_at: '2026-11-03T10:00:05Z' }, after), true);
  assert.equal(runMayBelongTo(job, { display_title: 'Build HumanStudy package with Claude Code', created_at: '2026-11-03T09:59:00Z' }, after), false);
  assert.equal(runMayBelongTo(job, { display_title: `Build ${job}`, created_at: '2026-11-03T10:00:05Z' }, after), true);
  assert.equal(runMayBelongTo(job, { display_title: `Build ${other}`, created_at: '2026-11-03T10:00:05Z' }, after), false);
});

test('token expiry header is parsed and warned about before it lapses', () => {
  assert.equal(tokenExpiry('2026-11-10 12:00:00 UTC'), Date.parse('2026-11-10T12:00:00Z'));
  assert.equal(tokenExpiry('2026-11-10 12:00:00 -0800'), Date.parse('2026-11-10T20:00:00Z'));
  assert.equal(tokenExpiry(undefined), null);
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.match(tokenExpiryWarning('GITHUB_TOKEN', '2026-11-10 12:00:00 UTC', now), /GITHUB_TOKEN expires in 7 days/);
  assert.equal(tokenExpiryWarning('GITHUB_TOKEN', '2027-01-10 12:00:00 UTC', now), null);
  assert.match(tokenExpiryWarning('GITHUB_TOKEN', '2026-11-01 12:00:00 UTC', now), /has expired/);
  assert.equal(tokenExpiryWarning('GITHUB_TOKEN', undefined, now), null);
});
