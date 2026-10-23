import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), AdmZip = require('adm-zip');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)((n) => deps[n] ?? require(n), m, m.exports); return m.exports;
}
const access = { ACCESS_SECRET: 'test-secret' };
const admZip = { default: AdmZip };
const lib = load('lib/community.ts', { './access': access, 'adm-zip': admZip });

// Same cases as HumanStudy-Bench tests/test_community.py.
test('paper keys match scripts/community.py', () => {
  assert.equal(lib.makePaperKey({ doi: 'https://doi.org/10.1111/ABC.1', title: 't', year: 2000, firstAuthor: 'A B' }), 'doi:10.1111/abc.1');
  assert.equal(lib.makePaperKey({ doi: 'doi: 10.1234/x', title: 't', year: 2000, firstAuthor: 'A B' }), 'doi:10.1234/x');
  // Bench rejects DOIs outside 10.NNNN/…; such input keys by title so the proposal can still validate.
  assert.equal(lib.makePaperKey({ doi: 'doi: 10.1/x', title: 't', year: 2000, firstAuthor: 'A B' }), 'title:t-2000-b');
  assert.equal(lib.makePaperKey({ title: 'Intentional Action & Side-Effects!', year: 2003, firstAuthor: 'Joshua Knobe' }), 'title:intentional-action-side-effects-2003-knobe');
  assert.equal(lib.makePaperKey({ doi: '', title: 'Café Müller', year: 1999, firstAuthor: 'Müller, Hans' }), 'title:cafe-muller-1999-muller');
  assert.equal(lib.makePaperKey({ doi: 'not-a-doi', title: 'T', year: null, firstAuthor: 'Ada Lovelace' }), 'title:t-nd-lovelace');
  assert.equal(lib.makePaperKey({ doi: '10.1111/1468-0017.00215', title: 'x', year: 2003, firstAuthor: 'k' }), 'doi:10.1111/1468-0017.00215');
});

test('long titles are cut on a word boundary', () => {
  const r = lib.normaliseTitle('word '.repeat(30));
  assert.ok(r.length <= 60 && !r.endsWith('-') && r.startsWith('word-word'));
  assert.equal(r, 'word-'.repeat(12).slice(0, -1)); // 12 words = 59 chars
});

test('paper key to folder name', () => {
  assert.equal(lib.paperKeyToDir('doi:10.1111/1468-0017.00215'), 'doi_10.1111_1468-0017.00215');
  assert.equal(lib.paperKeyToDir('doi:10.1002/(sici)1097<x>'), 'doi_10.1002__sici_1097_x_');
  assert.equal(lib.paperKeyToDir('title:a-b-2000-c'), 'title_a-b-2000-c');
});

test('contribution folders and versions', () => {
  assert.equal(lib.contributionFolder('knobe-2003', 'gh-ada', 1), 'knobe-2003--gh-ada');
  assert.equal(lib.contributionFolder('knobe-2003', 'gh-ada', 3), 'knobe-2003--gh-ada-v3');
  assert.equal(lib.hubContributorId('7F3A91C2-1111-2222-3333-444455556666'), 'hub-7f3a91c2');
  const names = ['knobe-2003--gh-ada', 'knobe-2003--gh-ada-v2', 'knobe-2003--gh-adam', 'other--gh-ada'];
  assert.equal(lib.latestVersion(names, 'knobe-2003', 'gh-ada'), 2);
  assert.equal(lib.latestVersion(names, 'knobe-2003', 'hub-1'), 0);
});

test('hub signatures round trip and reject forgeries', () => {
  const sig = lib.signHub('user-1');
  assert.match(sig, /^[\w-]{43}$/);
  assert.equal(lib.verifyHub('user-1', sig), true);
  assert.equal(lib.verifyHub('user-2', sig), false);
  assert.equal(lib.verifyHub('user-1', sig.slice(0, -2) + 'xx'), false);
  assert.equal(lib.verifyHub('user-1', undefined), false);
  const other = load('lib/community.ts', { './access': { ACCESS_SECRET: 'other' }, 'adm-zip': admZip });
  assert.equal(other.verifyHub('user-1', sig), false);
});

test('github tokens are sealed and only open with the same secret', () => {
  const sealed = lib.encryptToken('gho_secret');
  assert.ok(!sealed.includes('gho_secret'));
  assert.equal(lib.decryptToken(sealed), 'gho_secret');
  assert.notEqual(lib.encryptToken('gho_secret'), sealed);
  assert.equal(lib.decryptToken(sealed.slice(0, -2) + 'AA'), null);
  const other = load('lib/community.ts', { './access': { ACCESS_SECRET: 'other' }, 'adm-zip': admZip });
  assert.equal(other.decryptToken(sealed), null);
});

const f = (name, size = 10) => ({ name, size });
const good = [f('CONTRIBUTION.json'), f('program.json'), f('package/knobe/study.json'), f('artifacts/simulations/20260101/report.md')];

test('a well-formed zip passes', () => {
  assert.deepEqual(lib.validateContributionZip(good, { zipBytes: 1000 }), []);
});

test('zip validation explains each problem', () => {
  const has = (errs, re) => assert.ok(errs.some((e) => re.test(e)), `${re} in ${JSON.stringify(errs)}`);
  has(lib.validateContributionZip([f('program.json')]), /no CONTRIBUTION\.json/);
  has(lib.validateContributionZip([f('CONTRIBUTION.json')]), /no program\.json/);
  has(lib.validateContributionZip([...good, f('notes.txt'), f('sources/paper.txt')]), /notes\.txt/);
  assert.deepEqual(lib.validateContributionZip([...good, f('artifacts/other/x.md'), f('sources/paper.txt')]), []);
  has(lib.validateContributionZip([...good, f('package/.humanstudy/threads.json')]), /private project/);
  has(lib.validateContributionZip([...good, f('package/big.bin', 26 * 1024 * 1024)]), /package\/big\.bin is 26 MB/);
  has(lib.validateContributionZip(good, { zipBytes: 41 * 1024 * 1024 }), /41 MB, over the 40 MB/);
  has(lib.validateContributionZip([...good, f('package/../../etc/passwd')]), /path that is not allowed/);
  has(lib.validateContributionZip([...good, f('/abs.json')]), /path that is not allowed/);
  has(lib.validateContributionZip([...good, f('package\\x.json')]), /path that is not allowed/);
  has(lib.validateContributionZip([...good, f('package/paper.pdf')]), /is a PDF/);
  assert.deepEqual(lib.validateContributionZip([...good, f('package/paper.pdf')], { includesPdf: true }), []);
  assert.deepEqual(lib.validateContributionZip([...good, f('__MACOSX/x'), f('.DS_Store')]), []);
});

test('readContributionZip rejects garbage and reads real zips', () => {
  assert.match(lib.readContributionZip(Buffer.from('nope')).errors[0], /not a valid zip/);
  const z = new AdmZip();
  z.addFile('CONTRIBUTION.json', Buffer.from('{}'));
  z.addFile('program.json', Buffer.from('{"a":1}'));
  const r = lib.readContributionZip(z.toBuffer());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.files.map((x) => x.name).sort(), ['CONTRIBUTION.json', 'program.json']);
});

// ---- publish route branching --------------------------------------------------------------

function fakeOctokit({ existingDir = null, userLogin = null } = {}) {
  const calls = [];
  const rec = (name, result) => async (args) => { calls.push([name, args]); return typeof result === 'function' ? result(args) : result; };
  class Fake {
    constructor(opts) {
      this.auth = opts.auth; Fake.instances.push(this);
      this.rest = {
        repos: {
          get: rec('repos.get', { data: { default_branch: 'main', name: 'HumanStudy-Bench' } }),
          getContent: rec('repos.getContent', () => {
            if (!existingDir) { const e = new Error('Not Found'); e.status = 404; throw e; }
            return { data: existingDir.map((name) => ({ name })) };
          }),
          createFork: rec('repos.createFork', { data: { owner: { login: userLogin }, name: 'HumanStudy-Bench' } }),
        },
        git: {
          getRef: rec('git.getRef', (a) => {
            if (a.ref.startsWith('heads/community/')) { const e = new Error('Not Found'); e.status = 404; throw e; }
            return { data: { object: { sha: 'BASE' } } };
          }),
          getCommit: rec('git.getCommit', { data: { tree: { sha: 'BASETREE' } } }),
          createBlob: rec('git.createBlob', { data: { sha: 'blob' } }),
          createTree: rec('git.createTree', { data: { sha: 'TREE' } }),
          createCommit: rec('git.createCommit', { data: { sha: 'COMMIT' } }),
          createRef: rec('git.createRef', { data: {} }),
          updateRef: rec('git.updateRef', { data: {} }),
        },
        pulls: {
          list: rec('pulls.list', { data: [] }),
          create: rec('pulls.create', { data: { number: 42, html_url: 'https://github.com/HumanStudy-Hub/HumanStudy-Bench/pull/42' } }),
          update: rec('pulls.update', { data: {} }),
        },
      };
    }
  }
  Fake.instances = []; Fake.calls = calls;
  return Fake;
}

function setup({ identity = null, recent = 0, existingDir = null } = {}) {
  process.env.GITHUB_TOKEN = 'bot-token';
  const Fake = fakeOctokit({ existingDir, userLogin: identity?.login });
  const inserted = [];
  const community = load('lib/community.ts', { './access': access, 'adm-zip': admZip });
  const store = {
    countRecentContributions: async () => recent,
    getIdentity: async () => identity && { ...identity, token_encrypted: community.encryptToken(identity.token) },
    insertContribution: async (row) => { inserted.push(row); },
  };
  const publish = load('lib/community-publish.ts', { '@octokit/rest': { Octokit: Fake }, './community': community, './community-store': store });
  return { Fake, inserted, publish: publish.publishContribution };
}

function zipOf(extra = {}) {
  const z = new AdmZip();
  z.addFile('CONTRIBUTION.json', Buffer.from(JSON.stringify({ appVersion: '0.9.0', checks: { schema: true, package: null, simulation: null }, ...extra })));
  z.addFile('program.json', Buffer.from('{"nodes":[]}'));
  z.addFile('package/knobe-2003/study.json', Buffer.from('{}'));
  return z.toBuffer();
}
const body = (over = {}) => ({
  contributor: { name: 'Ada Lovelace', affiliation: 'NYU' },
  includesPdf: false,
  paperMeta: { doi: '10.1111/1468-0017.00215', title: 'Intentional action and side effects', year: 2003, firstAuthor: 'Joshua Knobe' },
  slug: 'knobe-2003',
  ...over,
});
const call = (Fake, name) => Fake.calls.filter(([n]) => n === name).map(([, a]) => a);
const userId = '7f3a91c2-0000-4000-8000-000000000001';
const committedJson = (Fake, name) => {
  // the blobs are base64 of file content, in the order of the tree entries
  const blobs = call(Fake, 'git.createBlob'); const tree = call(Fake, 'git.createTree')[0].tree;
  const i = tree.findIndex((t) => t.path.endsWith(name));
  return JSON.parse(Buffer.from(blobs[i].content, 'base64').toString());
};

test('without a connected GitHub account the bot opens the PR with a signed Hub id', async () => {
  const { Fake, inserted, publish } = setup();
  const r = await publish({ userId, zip: zipOf(), body: body() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'pr_open');
  assert.equal(r.prUrl, 'https://github.com/HumanStudy-Hub/HumanStudy-Bench/pull/42');
  assert.equal(Fake.instances[0].auth, 'bot-token');
  assert.equal(call(Fake, 'repos.createFork').length, 0);
  const tree = call(Fake, 'git.createTree')[0];
  assert.ok(tree.tree.every((t) => t.path.startsWith('community/paper_')));
  assert.ok(tree.tree.every((t) => t.path.includes('/proposals/')));
  assert.ok(!tree.tree.some((t) => t.path.endsWith('/current.json')));
  assert.ok(tree.tree.some((t) => t.path.endsWith('/package/knobe-2003/study.json')));
  const meta = committedJson(Fake, 'CONTRIBUTION.json');
  assert.deepEqual(meta.contributor.hub, { id: userId, signature: lib.signHub(userId) });
  assert.equal(meta.contributor.github, undefined);
  assert.equal(meta.paperKey, 'doi:10.1111/1468-0017.00215');
  assert.equal(meta.appVersion, '0.9.0');
  const commit = call(Fake, 'git.createCommit')[0];
  assert.equal(commit.owner, 'HumanStudy-Hub');
  assert.deepEqual([commit.author.name, commit.author.email], ['Ada Lovelace', `${userId}@users.humanstudy-hub.com`]);
  assert.match(commit.message, /Co-authored-by: Ada Lovelace/);
  assert.equal(call(Fake, 'git.createRef')[0].ref, `refs/heads/community/${r.id}`);
  assert.equal(call(Fake, 'git.updateRef').length, 0, 'immutable proposals are never force-pushed');
  const pr = call(Fake, 'pulls.create')[0];
  assert.equal(pr.head, `HumanStudy-Hub:community/${r.id}`);
  assert.equal(pr.title, 'Community: Intentional action and side effects (2003) — Ada Lovelace');
  assert.match(pr.body, /Ada Lovelace/);
  assert.match(pr.body, /HumanStudy Hub/);
  assert.equal(inserted.length, 1);
  assert.deepEqual([inserted[0].owner_id, inserted[0].status, inserted[0].pr_number, inserted[0].folder], [userId, 'pr_open', 42, r.id]);
});

test('with a connected GitHub account the PR comes from the user\'s fork', async () => {
  const { Fake, publish } = setup({ identity: { login: 'Ada', token: 'gho_user' } });
  const r = await publish({ userId, zip: zipOf(), body: body() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(Fake.instances[0].auth, 'gho_user');
  assert.equal(call(Fake, 'repos.createFork').length, 1);
  assert.equal(call(Fake, 'git.createTree')[0].owner, 'Ada');
  const meta = committedJson(Fake, 'CONTRIBUTION.json');
  assert.equal(meta.contributor.github, 'Ada');
  assert.equal(meta.contributor.hub, undefined);
  assert.ok(call(Fake, 'git.createTree')[0].tree.every((t) => t.path.includes(`/proposals/${r.id}/`)));
  assert.equal(call(Fake, 'git.createCommit')[0].author, undefined);
  const pr = call(Fake, 'pulls.create')[0];
  assert.equal(pr.owner, 'HumanStudy-Hub');
  assert.equal(pr.head, `Ada:community/${r.id}`);
});

test('new submissions retain their real baseline and do not create competing public versions', async () => {
  const { Fake, publish } = setup();
  const first = await publish({ userId, zip: zipOf(), body: body({baseRevision:'a'.repeat(64)}) });
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(committedJson(Fake,'CONTRIBUTION.json').baseRevision,'a'.repeat(64));
  const second = await publish({ userId, zip: zipOf(), body: body() });
  assert.equal(second.ok,true);assert.notEqual(first.id,second.id);
  const paths=call(Fake,'git.createTree').flatMap(t=>t.tree.map(f=>f.path));
  assert.ok(paths.every(p=>p.includes('/proposals/')));
  assert.ok(!paths.some(p=>p.endsWith('/current.json')||p.endsWith('/paper.json')));
  assert.equal((await publish({userId,zip:zipOf(),body:body({baseRevision:'main'})})).error,'bad_baseline');
});

test('publish refuses bad input, big zips, PDFs and the sixth publish in an hour', async () => {
  const { publish } = setup();
  assert.equal((await publish({ userId, zip: zipOf(), body: body({ slug: 'Bad Slug' }) })).error, 'bad_slug');
  assert.equal((await publish({ userId, zip: zipOf(), body: body({ contributor: {} }) })).error, 'missing_name');
  assert.equal((await publish({ userId, zip: Buffer.from('x'), body: body() })).error, 'invalid_zip');
  const z = new AdmZip(); z.addFile('CONTRIBUTION.json', Buffer.from('{}')); z.addFile('program.json', Buffer.from('{}')); z.addFile('package/p.pdf', Buffer.from('%PDF'));
  const pdf = await publish({ userId, zip: z.toBuffer(), body: body() });
  assert.equal(pdf.ok, false); assert.match(pdf.message, /PDF/);
  const limited = setup({ recent: 5 });
  const r = await limited.publish({ userId, zip: zipOf(), body: body() });
  assert.deepEqual([r.ok, r.status, r.error], [false, 429, 'rate_limited']);
  assert.equal(limited.Fake.calls.length, 0);
});

test('a rejected GitHub token gives a plain-language error', async () => {
  process.env.GITHUB_TOKEN = 'bot-token';
  const community = load('lib/community.ts', { './access': access, 'adm-zip': admZip });
  const rejecting = class { constructor() { this.rest = { repos: { get: async () => { const e = new Error('Bad credentials'); e.status = 401; throw e; } } }; } };
  const mod = load('lib/community-publish.ts', {
    '@octokit/rest': { Octokit: rejecting }, './community': community,
    './community-store': { countRecentContributions: async () => 0, getIdentity: async () => ({ login: 'Ada', token_encrypted: community.encryptToken('gho') }), insertContribution: async () => {} },
  });
  const r = await mod.publishContribution({ userId, zip: zipOf(), body: body() });
  assert.deepEqual([r.ok, r.status, r.error], [false, 401, 'github_token_rejected']);
  assert.match(r.message, /Reconnect GitHub/);
});

// ---- webhook ------------------------------------------------------------------------------

test('webhook signatures and status changes', () => {
  const hook = load('lib/community-webhook.ts');
  const { createHmac } = require('node:crypto');
  const raw = '{"a":1}';
  const header = 'sha256=' + createHmac('sha256', 's3').update(raw).digest('hex');
  assert.equal(hook.verifyGithubSignature('s3', raw, header), true);
  assert.equal(hook.verifyGithubSignature('s3', raw + ' ', header), false);
  assert.equal(hook.verifyGithubSignature('s3', raw, null), false);
  const pr = (merged, ref = 'community/x--hub-1') => ({ action: 'closed', pull_request: { number: 7, merged, head: { ref } } });
  assert.deepEqual(hook.statusChangeFor('pull_request', pr(true)), { match: { prNumber: 7 }, status: 'merged', error: null });
  assert.equal(hook.statusChangeFor('pull_request', pr(false)).status, 'rejected');
  assert.equal(hook.statusChangeFor('pull_request', pr(true, 'feature/x')), null);
  const run = hook.statusChangeFor('workflow_run', { action: 'completed', workflow_run: { conclusion: 'failure', head_branch: 'community/x--hub-1', pull_requests: [], name: 'Validate' } });
  assert.deepEqual(run.match, { branch: 'community/x--hub-1' }); assert.equal(run.status, 'checks_failed');
  assert.equal(hook.statusChangeFor('check_suite', { action: 'completed', check_suite: { conclusion: 'success', head_branch: 'community/x', pull_requests: [] } }), null);
  assert.equal(hook.statusChangeFor('pull_request_review', { action: 'submitted', review: { state: 'changes_requested' }, pull_request: { number: 3, head: { ref: 'community/x' } } }).status, 'changes_requested');
});
