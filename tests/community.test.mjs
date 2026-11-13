import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), AdmZip = require('adm-zip');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)((n) => deps[n] ?? require(n), m, m.exports); return m.exports;
}
const access = { ACCESS_SECRET: 'test-secret' };
const admZip = { default: AdmZip };
const archive = load('lib/community-archive.ts');
const communityDeps = { 'adm-zip': admZip, './community-archive': archive };
const lib = load('lib/community.ts', { './access': access, ...communityDeps });
const pairedModule = load('lib/community-paired.ts', { './community-archive': archive, './community': lib });
const pairedDeps = { './community-archive': archive, './community-paired': pairedModule };

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
  const other = load('lib/community.ts', { './access': { ACCESS_SECRET: 'other' }, ...communityDeps });
  assert.equal(other.verifyHub('user-1', sig), false);
});

test('github tokens are sealed and only open with the same secret', () => {
  const sealed = lib.encryptToken('gho_secret');
  assert.ok(!sealed.includes('gho_secret'));
  assert.equal(lib.decryptToken(sealed), 'gho_secret');
  assert.notEqual(lib.encryptToken('gho_secret'), sealed);
  const parts = sealed.split('.');
  const tamperedBody = Buffer.from(parts[3], 'base64url');
  tamperedBody[0] ^= 1;
  parts[3] = tamperedBody.toString('base64url');
  assert.equal(lib.decryptToken(parts.join('.')), null);
  const other = load('lib/community.ts', { './access': { ACCESS_SECRET: 'other' }, ...communityDeps });
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

test('private sources and raw runs are rejected while derived reports stay eligible', () => {
  const privatePaths = [
    'sources/Private/attachment.txt',
    'sources/RESEARCHER/data.csv',
    'sources/quarantine/source.txt',
    'sources/ｐｒｉｖａｔｅ/file.txt',
    'artifacts/archive/runs/result.json',
    'artifacts/simulations/20260101/results.html',
    'artifacts/records.jsonl',
    'artifacts/participant-responses.csv',
    'artifacts/notes.annotations.json',
    'sources/another-archive.zip',
    'package/fixture/human-data/table.csv',
  ];
  for (const path of privatePaths) {
    assert.ok(lib.validateContributionZip([...good, f(path)]).some(error => /private project file or raw record/.test(error)), path);
  }
  assert.deepEqual(lib.validateContributionZip([...good, f('artifacts/simulations/20260101/summary.md')]), []);
  assert.match(lib.validateContributionZip([...good, f('sources/Paper.txt'), f('sources/paper.txt')])[0], /more than once/);
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
  const community = load('lib/community.ts', { './access': access, ...communityDeps });
  const store = {
    countRecentContributions: async () => recent,
    getIdentity: async () => identity && { ...identity, token_encrypted: community.encryptToken(identity.token) },
    insertContribution: async (row) => { inserted.push(row); },
  };
  const publish = load('lib/community-publish.ts', { '@octokit/rest': { Octokit: Fake }, './community': community, ...pairedDeps, './community-store': store });
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
  publicReviewed: true,
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
  assert.equal(pr.base, 'main');
  assert.equal(pr.title, 'Community: Intentional action and side effects (2003) — Ada Lovelace');
  assert.match(pr.body, /Ada Lovelace/);
  assert.match(pr.body, /HumanStudy Hub/);
  assert.equal(inserted.length, 1);
  assert.deepEqual([inserted[0].owner_id, inserted[0].status, inserted[0].pr_number, inserted[0].folder], [userId, 'pr_open', 42, r.id]);
});

test('a Vercel preview opens the contribution against Bench dev', async () => {
  const previous = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'preview';
  try {
    const { Fake, publish } = setup();
    const result = await publish({ userId, zip: zipOf(), body: body() });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(call(Fake, 'git.getRef')[0].ref, 'heads/dev');
    assert.equal(call(Fake, 'pulls.create')[0].base, 'dev');
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
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

test('publish validates actual paths and the exact optional manifest before writing to GitHub', async () => {
  const { Fake, publish } = setup();
  const files = { 'program.json': '{"nodes":[]}', 'artifacts/simulations/example/report.md': 'Public derived report' };
  const manifest = Object.entries(files).map(([path, text]) => ({
    path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
  }));
  function archiveOf(manifest, extra = {}) {
    const zip = new AdmZip();
    zip.addFile('CONTRIBUTION.json', Buffer.from(JSON.stringify({ files: manifest })));
    for (const [path, text] of Object.entries({ ...files, ...extra })) zip.addFile(path, Buffer.from(text));
    return zip.toBuffer();
  }

  for (const zip of [
    archiveOf(manifest, { 'sources/quarantine/item.txt': 'Private attachment' }),
    archiveOf(manifest, { 'program.json': '{"nodes": [ ]}' }),
    archiveOf(manifest, { 'artifacts/other/report.md': 'Unlisted' }),
  ]) {
    const result = await publish({ userId, zip, body: body() });
    assert.equal(result.error, 'invalid_zip');
    assert.equal(Fake.calls.length, 0);
  }
  const valid = await publish({ userId, zip: archiveOf(manifest), body: body() });
  assert.equal(valid.ok, true);
  assert.ok(call(Fake, 'git.createTree')[0].tree.some(entry => entry.path.endsWith('/report.md')));
});

const pairedHash = bytes => createHash('sha256').update(bytes).digest('hex');

function pairedZip(options = {}) {
  const sourcePath = 'sources/open/stimuli.txt';
  const source = Buffer.from('Public fixture stimulus');
  const protocol = {
    schema_version: '1', id: 'fixture',
    meta: { sources: { stimulus: { file: sourcePath, distribution: {
      tier: 'hosted', licence: 'CC0-1.0', attribution: 'Fixture Author', sha256: pairedHash(source),
    } } } },
    arms: [{id: 'missing', runnable: false, why: 'The task material is missing.'}],
    distribution: {format: 'hsenv-projection/1', hsenv: '0.8.1', strict: true, placeholder: '░', held: {}, attribution: []},
  };
  options.protocol?.(protocol);
  const protocolBytes = Buffer.from(JSON.stringify(protocol));
  const program = {
    schemaVersion: 2, intent: 'reconstruct', source:{title:'Intentional action and side effects',authors:'Joshua Knobe'}, evidence:[], issues: [{ title: 'Missing task material' }],
    extensions: { scholarly: { profile: 'scholarly-v1', protocol: { path: 'protocol.json', id: 'fixture', sha256: pairedHash(protocolBytes) } } },
  };
  options.program?.(program);
  const study = { schema_version: '1', id: 'fixture', title:'Intentional action and side effects', authors:['Joshua Knobe'], year:2003, doi:'10.1111/1468-0017.00215', version: '2.3.1', quality: 'draft',
    protocol: { path: 'protocol.json', sha256: 'b'.repeat(64), schema_version: '1' } };
  options.study?.(study);
  const sourceManifest = { schemaVersion: 1, files: [{ path: sourcePath, bytes: source.length,
    sha256: pairedHash(source), license: 'CC0-1.0', attribution: 'Fixture Author' }] };
  options.sources?.(sourceManifest);
  const payload = {
    'program.json': Buffer.from(JSON.stringify(program)), 'study.json': Buffer.from(JSON.stringify(study)),
    'protocol.json': protocolBytes, 'sources/SOURCE.json': Buffer.from(JSON.stringify(sourceManifest)),
    [sourcePath]: source, 'artifacts/simulations/fixture/report.md': Buffer.from('Shareable finished report'),
    ...options.extra,
  };
  const files = Object.entries(payload).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: pairedHash(bytes) }));
  const metadata = { schemaVersion: 2, kind: 'protocol', paper:{...body().paperMeta,authors:['Joshua Knobe']}, baseRevision: 'c'.repeat(64), files,
    checks: { schema: true, package: true, simulation: true } };
  options.metadata?.(metadata);
  const zip = new AdmZip();
  for (const [path, bytes] of Object.entries(payload)) zip.addFile(path, bytes);
  zip.addFile('CONTRIBUTION.json', Buffer.from(JSON.stringify(metadata)));
  return { zip: zip.toBuffer(), payload, files };
}

test('paired submission opens a public review proposal with the exact verified payload and original metadata', async () => {
  const { Fake, publish } = setup();
  const fixture = pairedZip();
  const result = await publish({ userId, zip: fixture.zip, body: body({ publicReviewed: true, paperMeta:{...body().paperMeta,authors:['Joshua Knobe']} }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, 'protocol');
  const tree = call(Fake,'git.createTree')[0].tree;
  const blobs = call(Fake,'git.createBlob');
  for (const [path, bytes] of Object.entries(fixture.payload)) {
    const index = tree.findIndex(file => file.path.endsWith('/' + path));
    assert.ok(index >= 0, path);
    assert.deepEqual(Buffer.from(blobs[index].content,'base64'), bytes);
  }
  const metadata = committedJson(Fake,'CONTRIBUTION.json');
  assert.deepEqual(metadata.files, fixture.files);
  assert.equal(metadata.kind, 'protocol');
  assert.equal(metadata.studyVersion, '2.3.1');
  assert.equal(metadata.baseRevision, 'c'.repeat(64));
  assert.equal(metadata.paper.authors[0], 'Joshua Knobe');
  assert.equal(metadata.contributor.name, 'Ada Lovelace');
  assert.deepEqual(metadata.checks, { schema:false,package:null,simulation:null });
  assert.match(call(Fake,'pulls.create')[0].body, /User submitted.*maintainer review/);
  assert.ok(tree.every(file => file.path.includes('/proposals/')));
});

test('paired consent, source policy, exact binding and held material are enforced before GitHub writes', async () => {
  const { Fake, publish } = setup();
  const submit = (options, reviewed = true) => publish({
    userId, zip: pairedZip(options).zip, body: body({ publicReviewed: reviewed, paperMeta:{...body().paperMeta,authors:['Joshua Knobe']} }),
  });
  assert.equal((await submit({}, false)).error, 'public_review_required');
  assert.equal((await publish({ userId, zip: pairedZip().zip, body: body({
    publicReviewed: true, baseRevision:'f'.repeat(64), paperMeta: {...body().paperMeta, authors:['Joshua Knobe']},
  }) })).error, 'invalid_zip');
  assert.equal((await publish({ userId, zip: pairedZip().zip, body: body({
    publicReviewed: true, paperMeta: {...body().paperMeta, authors:['Impostor'],title:'Another paper'},
  }) })).error, 'invalid_zip');
  for (const options of [
    { metadata: meta => delete meta.files },
    { metadata: meta => {meta.files[0].sha256 = 'f'.repeat(64)} },
    { extra: {'sources/quarantine/secret.txt':Buffer.from('Private')} },
    { extra: {'sources/open/unlicensed.txt':Buffer.from('Unlisted')} },
    { extra: {'artifacts/simulations/fixture/records.jsonl':Buffer.from('{}')} },
    { extra: {'review/fidelity-review-supplied.md':Buffer.from('Reviewer')} },
    { protocol: protocol => {protocol.distribution.held = { field: {source:'stimulus'} }} },
    { protocol: protocol => {protocol.distribution.rehydrated = true} },
    { protocol: protocol => {protocol.data = { item: '░░░' }} },
    { protocol: protocol => {protocol.meta.sources.stimulus.distribution.tier = 'user'} },
    { protocol: protocol => {protocol.meta.sources.stimulus.distribution.sha256 = 'f'.repeat(64)} },
    { program: program => {program.extensions.scholarly.protocol.sha256 = 'f'.repeat(64)} },
    { program: program => {program.evidence = [{path:'sources/open/missing.txt'}]} },
    { protocol: protocol => {protocol.meta.sources = {}} },
    { study: study => {study.quality = 'high_fidelity'; study.fidelity = {signed_by:'Uploader'}} },
    { sources: manifest => {manifest.files[0].license = 'CC-BY-NC-4.0'} },
  ]) assert.equal((await submit(options)).error, 'invalid_zip');
  assert.equal(Fake.calls.length, 0);
});

test('Desktop paired export passes Web validation and reaches the public proposal writer byte-for-byte', {
  skip: !process.env.HUMANSTUDY_DESKTOP_PAIRED_ZIP,
}, async () => {
  const { Fake, publish } = setup();
  const zip = fs.readFileSync(process.env.HUMANSTUDY_DESKTOP_PAIRED_ZIP);
  const original = lib.readContributionZip(zip);
  assert.deepEqual(original.errors, []);
  const metadata = JSON.parse(original.files.find(file => file.name === 'CONTRIBUTION.json').data.toString());
  const result = await publish({ userId, zip, body: body({
    publicReviewed: true, paperMeta: metadata.paper,
  }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, 'protocol');
  const tree = call(Fake,'git.createTree')[0].tree;
  const blobs = call(Fake,'git.createBlob');
  assert.equal(tree.length, original.files.length);
  const pathPattern = new RegExp('/proposals/' + result.id + '/');
  for (const file of original.files.filter(file => file.name !== 'CONTRIBUTION.json')) {
    const index = tree.findIndex(entry => entry.path.split(pathPattern)[1] === file.name);
    assert.ok(index >= 0, file.name);
    assert.deepEqual(Buffer.from(blobs[index].content, 'base64'), file.data);
    assert.doesNotMatch(file.data.toString(), /PRIVATE-CANARY|private annotation|Private raw participant row/i);
  }
  assert.ok(!tree.some(file => /\/(?:private|runs|researcher)\//i.test(file.path)));
  const published = committedJson(Fake, 'CONTRIBUTION.json');
  assert.equal(published.studyVersion, '1.2.3');
  assert.equal(published.paper.authors[0], 'A. Example');
  assert.equal(published.contributor.name, 'Ada Lovelace');
  assert.equal(published.checks.schema, false);
  assert.match(call(Fake,'pulls.create')[0].body, /User submitted/);
});

test('a rejected GitHub token gives a plain-language error', async () => {
  process.env.GITHUB_TOKEN = 'bot-token';
  const community = load('lib/community.ts', { './access': access, ...communityDeps });
  const rejecting = class { constructor() { this.rest = { repos: { get: async () => { const e = new Error('Bad credentials'); e.status = 401; throw e; } } }; } };
  const mod = load('lib/community-publish.ts', {
    '@octokit/rest': { Octokit: rejecting }, './community': community, ...pairedDeps,
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
  assert.equal(hook.statusChangeFor('pull_request', { ...pr(false), action: 'labeled', label: { name: 'community:needs-review' } }), null);
  const run = hook.statusChangeFor('workflow_run', { action: 'completed', workflow_run: { conclusion: 'failure', head_branch: 'community/x--hub-1', pull_requests: [], name: 'Validate' } });
  assert.deepEqual(run.match, { branch: 'community/x--hub-1' }); assert.equal(run.status, 'checks_failed');
  assert.equal(hook.statusChangeFor('check_suite', { action: 'completed', check_suite: { conclusion: 'success', head_branch: 'community/x', pull_requests: [] } }), null);
  assert.equal(hook.statusChangeFor('pull_request_review', { action: 'submitted', review: { state: 'changes_requested' }, pull_request: { number: 3, head: { ref: 'community/x' } } }).status, 'changes_requested');
});

test('publishing refuses embedded credentials and local paths before any GitHub call', async () => {
  const samples = ['Loaded from /Users/example/private/interview.txt', 'Read C:\\Users\\example\\notes.txt', 'Read C:/Users/example/notes.txt', 'Authorization: Bearer synthetic-secret-value', 'key sk-synthetic0000000000000000', 'file:///home/example/private.txt'];
  for (const sample of samples) {
    const { publish, Fake, inserted } = setup();
    const z = new AdmZip(zipOf());
    z.updateFile('program.json', Buffer.from(JSON.stringify({nodes: [], notes: sample})));
    const result = await publish({userId, zip: z.toBuffer(), body: body()});
    assert.equal(result.error, 'private_content');
    assert.equal(Fake.calls.length, 0); assert.equal(Fake.instances.length, 0); assert.equal(inserted.length, 0);
    assert.ok(!result.message.includes(sample));
  }
});

test('publication checks reports and contributor metadata but retains ordinary citations', async () => {
  for (const location of ['report', 'metadata']) {
    const {publish, Fake} = setup(); const z = new AdmZip(zipOf()); const b = body();
    if (location === 'report') z.addFile('artifacts/report.md', Buffer.from('Copied from /home/example/interview.txt'));
    else b.contributor.affiliation = 'Credentials: ghp_synthetic0000000000000';
    const result = await publish({userId, zip:z.toBuffer(), body:b});
    assert.equal(result.error, 'private_content'); assert.equal(Fake.calls.length,0);
  }
  const {publish} = setup(); const z = new AdmZip(zipOf());
  z.updateFile('program.json',Buffer.from(JSON.stringify({nodes:[],notes:'Author author@example.org; https://example.org/home/paper and https://example.org/Users/resource; doi:10.1234/example; Qualtrics: ${q://QID373/Choices}'})));
  assert.equal((await publish({userId,zip:z.toBuffer(),body:body()})).ok,true);
});


test('Program-only submissions require explicit public file approval', async () => {
  const { publish, Fake } = setup();
  for (const publicReviewed of [undefined, false, "true"]) {
    const result = await publish({ userId, zip: zipOf(), body: body({ publicReviewed }) });
    assert.equal(result.error, 'public_review_required');
  }
  assert.equal(Fake.calls.length, 0);
});
