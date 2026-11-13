import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const cache = new Map();
let pathname = '/';

function load(file, dependencies = {}) {
  if (cache.has(file)) return cache.get(file);

  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const loadedModule = { exports: {} };

  function resolve(id) {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id === 'next/navigation') return { usePathname: () => pathname };
    if (id === 'next/link') {
      return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
    }
    if (id === 'next/image') {
      return { __esModule: true, default: ({ src, alt, width, height }) => React.createElement('img', { src, alt, width, height }) };
    }
    if (id.endsWith('.module.css')) {
      return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    }
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? id.slice(2) : path.join(path.dirname(file), id);
      if (base.endsWith('.json')) return require(path.join(root, base));
      const target = ['.ts', '.tsx'].map(extension => base + extension)
        .find(candidate => fs.existsSync(path.join(root, candidate)));
      assert.ok(target, 'Resolve component dependency: ' + id);
      return load(target);
    }
    return require(id);
  }

  new Function('require', 'module', 'exports', compiled)(resolve, loadedModule, loadedModule.exports);
  cache.set(file, loadedModule.exports);
  return loadedModule.exports;
}

const Navbar = load('components/Navbar.tsx').default;
const Footer = load('components/Footer.tsx').default;
const Home = load('app/page.tsx').default;
const render = component => renderToStaticMarkup(React.createElement(component));
const destinations = ['/forum', '/studies', '/download', '/research', '/collaboration', '/account'];

test('public navigation preserves every existing destination on desktop and mobile', () => {
  for (pathname of ['/', '/forum', '/studies', '/account', '/download', '/research', '/collaboration']) {
    const html = render(Navbar);
    assert.match(html, /aria-label="Main navigation"/);
    assert.match(html, /href="\/"/);
    for (const href of destinations) {
      assert.equal(html.split(`href="${href}"`).length - 1, 2, href + ' has desktop and mobile entries');
    }
    assert.match(html, /<details[^>]*>.*<summary/s);
    assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  }
});

test('active navigation identifies the current section without matching similar route names', () => {
  pathname = '/studies/study_005';
  const html = render(Navbar);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 2);
  assert.match(html, /href="\/studies"[^>]*aria-current="page"/);
  pathname = '/studies-unrelated';
  assert.doesNotMatch(render(Navbar), /aria-current="page"/);
});

test('workspace pages retain their own navigation and footer', () => {
  for (pathname of ['/build', '/build/projects', '/build/design', '/build/example', '/build/workspace-123']) {
    assert.equal(render(Navbar), '', pathname);
    assert.equal(render(Footer), '', pathname);
  }
  pathname = '/';
  assert.match(render(Footer), /All rights reserved/);
});

test('the real homepage retains its original actions and has one main heading', () => {
  const html = render(Home);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.doesNotMatch(html, /<main\b/);
  for (const href of ['/forum', '/studies', '/download']) {
    assert.match(html, new RegExp(`href="${href}"`));
  }
  assert.match(html, /Open infrastructure for/);
  assert.match(html, /human-study research/);
  assert.match(html, /Turn published human studies into executable programs that others can reuse and build upon\./);
});

test('Forum introduces the community before its two original featured posts', async () => {
  const ForumPage = load('app/forum/page.tsx').default;
  const html = render(ForumPage);
  assert.match(html, /<h1[^>]*>Community forum<\/h1>/);
  const alias = load('app/blog/page.tsx');
  assert.equal(render(alias.default), html);
  assert.equal(alias.metadata.alternates.canonical, '/forum');
  assert.ok(html.indexOf('Community forum') < html.indexOf('Featured posts'));
  assert.equal((html.match(/<article\b/g) || []).length, 2);
  const posts = load('lib/forum-posts.ts');
  const Article = load('app/forum/[slug]/page.tsx', {
    '@/lib/forum-posts': { ...posts, readForumPost: async () => '## Original heading\n\nOriginal paragraph.' },
  }).default;
  for (const post of posts.forumPosts) {
    assert.ok(html.includes(`href="/forum/${post.slug}"`));
    const article = renderToStaticMarkup(await Article({ params: Promise.resolve({ slug: post.slug }) }));
    assert.ok(article.includes(post.author));
    assert.ok(article.includes(posts.forumPostUrl(post)));
    assert.match(article, /<h2>Original heading<\/h2>/);
    assert.match(article, /href="\/forum"/);
  }
  assert.doesNotMatch(html, /implicit-agent-behavior/);
  assert.ok(html.includes('href="https://forum.humanstudy-hub.com/"'));
  assert.ok(html.includes('src="/images/forum-discussions.webp"'));
});

test('featured post relay returns the original Markdown and rejects drafts and mismatched IDs', async () => {
  const { forumPosts, readForumPost } = load('lib/forum-posts.ts');
  const post = forumPosts[0];
  const original = '## Heading\n\nExact source.\n';
  const record = { _id: post.id, slug: post.slug, status: 2, contents: { markdown: original } };
  const response = result => async (url, init) => {
    assert.equal(url, 'https://forum.humanstudy-hub.com/graphql');
    assert.equal(JSON.parse(init.body).variables.id, post.id);
    return Response.json({ data: { post: { result } } });
  };
  assert.equal(await readForumPost(post, response(record)), original);
  assert.equal(await readForumPost(post, response({ ...record, draft: true })), null);
  assert.equal(await readForumPost(post, response({ ...record, _id: 'different' })), null);
});

test('contributor profiles show an unavailable state during storage errors', async () => {
  const Profile = load('app/contributors/[id]/page.tsx', {
    '@/lib/community-credit': {
      UUID: /^[a-f0-9-]+$/,
      creditPage: () => 1,
      getContributor: async () => { throw Error('storage unavailable'); },
      listCredits: async () => [],
    },
  }).default;
  const html = renderToStaticMarkup(await Profile({
    params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    searchParams: Promise.resolve({}),
  }));
  assert.match(html, /Contributor profile/);
  assert.match(html, /This contributor profile is temporarily unavailable/);
  assert.match(html, /href="\/studies"/);
});

test('the homepage groups all four actions in the requested order without secondary sections', () => {
  const html = render(Home);
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, ['/download', '/forum', '/collaboration', '/studies']);
  assert.match(html, /aria-label="Explore HumanStudy Hub"/);
  assert.doesNotMatch(html, /Questions we’re exploring|Join the conversation|<h2/);
});

const { libraryFilters, libraryAvailability, paperSource, researchContributorNames, validateResearchQuery } = load('lib/research.ts');
const libraryCalls = [];
let libraryResult;
let libraryError;
const Studies = load('app/studies/page.tsx', {
  '@/lib/research': {
    validateResearchQuery, libraryFilters, libraryAvailability, paperSource, researchContributorNames,
    searchLibrary: async (input, pool, validatedOnly) => {
      libraryCalls.push({ input, pool, validatedOnly });
      if (libraryError) throw libraryError;
      return libraryResult;
    },
  },
}).default;

async function renderStudies(params, result, error) {
  libraryCalls.length = 0;
  libraryResult = result;
  libraryError = error;
  return renderToStaticMarkup(await Studies({ searchParams: Promise.resolve(params) }));
}

const paper = {
  id: 'paper_0123456789abcdef01234567',
  title: 'Published study',
  authors: ['Original author'],
  year: 2024,
  currentRevision: null,
  legacyStudyId: 'study_005',
  aliases: [],
};
const results = { items: [paper], total: 1, counts: { all: 336, program: 34, runnable: 9, protocol: 0, development: 20, indexed: 282 }, offset: 0, limit: 30, nextOffset: null };

test('the styled study library uses the real search contract and retains paper metadata', async () => {
  const html = await renderStudies({ q: 'knobe' }, results);
  assert.equal(libraryCalls.length, 1);
  assert.equal(libraryCalls[0].pool, 'program');
  assert.equal(libraryCalls[0].input.query, 'knobe');
  assert.match(html, /href="\/studies\/paper_0123456789abcdef01234567"/);
  assert.match(html, /Published study/);
  assert.match(html, /Original author/);
  assert.match(html, /2024/);
  assert.match(html, />View paper /);
  assert.doesNotMatch(html, />Run experiment</);
  assert.match(html, /<h1>Study Library<\/h1>/);
  assert.match(html, /1 paper\b/);
  assert.match(html, /href="\/studies\?q=knobe&amp;status=all"[^>]*>All papers/);
  assert.match(html, /href="\/studies\?q=knobe&amp;status=program"[^>]*>Interactive papers/);
  assert.match(html, /name="validated"[^>]*>Validated protocols only/);
  assert.doesNotMatch(html, /Awaiting extraction|In development|Runnable experiments|Human Study Programs/);
  assert.doesNotMatch(html, /Study collections|name="pool"/);
});

test('the old pending link opens the awaiting-extraction filter', async () => {
  const html = await renderStudies({ q: 'knobe', pool: 'pending' }, {
    ...results, items: [{ ...paper, legacyStudyId: null }], other: 0,
  });
  assert.equal(libraryCalls[0].pool, 'indexed');
  assert.match(html, /<h1>Study Library<\/h1>/);
  assert.match(html, /name="status" value="indexed"/);
  assert.match(html, /href="\/studies\?q=knobe&amp;status=all"[^>]*>All papers/);
  assert.doesNotMatch(html, /more indexed/);
});

test('library pagination preserves the search query and the selected pool', async () => {
  const html = await renderStudies({ q: 'choice & risk', status: 'all', validated: '1', offset: '30' }, {
    ...results, total: 90, offset: 30, nextOffset: 60,
  });
  assert.equal(libraryCalls[0].pool, 'all');
  assert.equal(libraryCalls[0].input.query, 'choice & risk');
  assert.equal(libraryCalls[0].input.offset, 30);
  assert.equal(libraryCalls[0].validatedOnly, true);
  assert.match(html, /<h1>Study Library<\/h1>/);
  assert.match(html, /name="status" value="all"/);
  const links = [...html.matchAll(/href="([^"]+)"/g)]
    .map(match => new URL(match[1].replaceAll('&amp;', '&'), 'http://local.test'));
  for (const offset of ['0', '60']) {
    const url = links.find(link => link.searchParams.get('offset') === offset);
    assert.ok(url, 'Pagination exposes offset ' + offset);
    assert.equal(url.searchParams.get('q'), 'choice & risk');
    assert.equal(url.searchParams.get('status'), 'all');
    assert.equal(url.searchParams.get('validated'), '1');
  }
});

test('program cards open the interactive document and a separate run setup without implying validation', async () => {
  const html = await renderStudies({ status: 'program' }, {
    ...results, items: [{ ...paper, currentRevision: 'a'.repeat(64), assetFiles: [{ path: 'program.json' }], contributors: [{ github: 'assassin808' }] }],
  });
  assert.match(html, /href="\/studies\/paper_0123456789abcdef01234567#paper-program"[^>]*>Interact with paper/);
  assert.match(html, /href="\/studies\/paper_0123456789abcdef01234567#run-experiment"[^>]*>Run experiment/);
  assert.match(html, /Run experiment<\/a><p[^>]*>Contributed by HumanStudy Hub Team<\/p>/);
  assert.doesNotMatch(html, />Validated protocol<|>Runnable draft</);
});

test('user-submitted protocol cards hide self-declared review quality', async () => {
  const revision = 'a'.repeat(64);
  const html = await renderStudies({}, {
    ...results, items: [{ ...paper, currentRevision: revision, assetFiles: [{ path: 'program.json' }, { path: 'protocol.json' }],
      publication: { kind: 'user-submitted', revision },
      protocol: { slug: 'submitted', schemaVersion: '1', revision, arms: [{ id: 'main', runnable: true }],
        fidelity: { verdict: 'high fidelity', signedBy: ['Uploader'] } } }],
  });
  assert.match(html, />User submitted</);
  assert.match(html, />Run experiment</);
  assert.doesNotMatch(html, />Validated protocol<|>High fidelity</);
});

test('invalid study queries display an error without querying the catalog', async () => {
  const html = await renderStudies({ offset: '-1' }, results);
  assert.equal(libraryCalls.length, 0);
  assert.match(html, /role="alert"/);
  assert.match(html, /Invalid offset/);
});

test('empty studies and catalog outages retain accessible recovery states', async () => {
  const empty = await renderStudies({ q: 'no match' }, { ...results, items: [], total: 0 });
  assert.match(empty, /No papers match this view\./);
  const unavailable = await renderStudies({}, undefined, new Error('Unavailable'));
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /The research library could not be loaded/);
  assert.match(unavailable, /role="search"/);
});

const desktop = load('lib/desktop-release.ts');
let release = desktop.NO_RELEASE;
const Download = load('app/download/page.tsx', {
  '@/lib/desktop-release': { ...desktop, getDesktopRelease: async () => release },
}).default;

test('the redesigned download page retains actual platform assets and release notes', async () => {
  release = {
    version: 'v1.2.3', publishedAt: '2026-10-01T12:00:00Z', prerelease: true,
    pageUrl: 'https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/tag/v1.2.3',
    macArm64: { name: 'app-mac-arm64.dmg', url: 'https://example.test/app-mac-arm64.dmg', size: 1000 },
    macX64: { name: 'app-mac-x64.dmg', url: 'https://example.test/app-mac-x64.dmg', size: 2000 },
    windows: { name: 'App-Setup-1.2.3.exe', url: 'https://example.test/App-Setup-1.2.3.exe', size: 3000 },
  };
  const html = renderToStaticMarkup(await Download());
  for (const asset of [release.macArm64, release.macX64, release.windows]) {
    assert.equal(html.split(`href="${asset.url}"`).length - 1, 2);
  }
  assert.match(html, /Version 1\.2\.3 \(beta\)/);
  assert.match(html, /<span class="whitespace-nowrap">Windows \(preview\)<\/span>/);
  assert.doesNotMatch(html, /From paper to experiment|Turn a paper into a study you can inspect/);
  assert.ok(html.includes(`href="${release.pageUrl}"`));
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.doesNotMatch(html, /<main\b/);
  assert.match(html, /src="\/desktop\/study-and-paper\.webp"/);
});

test('unavailable desktop releases retain the release-page fallback', async () => {
  release = desktop.NO_RELEASE;
  const html = renderToStaticMarkup(await Download());
  assert.ok(html.includes(`href="${desktop.DESKTOP_RELEASES_URL}"`));
  assert.match(html, /Windows: coming soon/);
  assert.doesNotMatch(html, /href="(?:null|undefined)"/);
});

const PaperDetail = load('components/ResearchPaperDetail.tsx').default;

test('paper details preserve research links, capability caveats and safe resource URLs', async () => {
  const html = renderToStaticMarkup(await PaperDetail({ paper: {
    ...paper,
    description: 'Original research description.',
    assetRoot: 'studies/study_005',
    studyCapabilities: { run: { status: 'partial', reason: 'Some materials are missing.' } },
    resources: [
      { id: 'safe', kind: 'original-data-link', url: 'https://example.test/data', access: 'unverified' },
      { id: 'unsafe', kind: 'metadata', url: 'javascript:alert(1)', access: 'unverified' },
    ],
  } }));
  assert.match(html, /Published study/);
  assert.match(html, /Original author · 2024/);
  assert.match(html, /Some materials are missing/);
  assert.match(html, /Availability not checked/);
  assert.match(html, /href="https:\/\/example\.test\/data"/);
  assert.match(html, /href="https:\/\/github\.com\/HumanStudy-Hub\/HumanStudy-Bench\/tree\/main\/studies\/study_005"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<main\b/);
});

test('catalog contributor names remain visible without a registered Hub profile', async () => {
  const html = renderToStaticMarkup(await PaperDetail({ paper: {
    ...paper, contributors: [{ name: 'Public Contributor', github: 'example' }, { hub: { id: 'private-account-id' } }],
  } }));
  assert.match(html, /Original author · 2024/);
  assert.match(html, /Build a study<\/a><\/div><p[^>]*>Contributed by Public Contributor/);
  assert.doesNotMatch(html, /private-account-id|href="\/contributors\//);
});

test('contributor attribution distinguishes team, named collaborators and unknown provenance', () => {
  const currentRevision = 'a'.repeat(64);
  const curated = { ...paper, currentRevision, assetRoot: 'studies/study_005' };
  const community = { ...curated, assetRoot: `community/${paper.id}/revisions/${currentRevision}` };
  assert.deepEqual(researchContributorNames(curated), ['HumanStudy Hub Team']);
  assert.deepEqual(researchContributorNames(community), []);
  assert.deepEqual(researchContributorNames({ ...curated, aliases: ['community:doi:unknown'] }), []);
  assert.deepEqual(researchContributorNames({ ...community, contributors: [
    { name: 'Named Collaborator', github: 'https://github.com/example' },
    { github: 'assassin808' }, { github: 'another-user' }, { hub: { id: 'private' } },
  ] }, ['Named Collaborator', 'Verified Hub contributor']), [
    'Named Collaborator', 'HumanStudy Hub Team', '@another-user', 'Verified Hub contributor',
  ]);
});

test('user-submitted protocol details show conditions and suppress uploader fidelity claims', async () => {
  const revision = 'a'.repeat(64);
  const html = renderToStaticMarkup(await PaperDetail({ paper: {
    ...paper, currentRevision: revision, assetFiles: [{ path: 'protocol.json' }],
    publication: { kind: 'user-submitted', revision },
    protocol: { slug: 'submitted', schemaVersion: '1', revision, arms: [{ id: 'main', label: 'Test condition', runnable: true }],
      fidelity: { verdict: 'high fidelity', signedBy: ['Uploader'] } },
  } }));
  assert.match(html, />User submitted</);
  assert.match(html, /Test condition/);
  assert.doesNotMatch(html, /High fidelity|signed by Uploader|Validated protocol/);
});

test('run setup opens the exact online paper, retains Desktop and shows blockers', () => {
  const RunExperiment = load('components/RunExperiment.tsx').default;
  const html = renderToStaticMarkup(React.createElement(RunExperiment, {
    paper: { ...paper, currentRevision: 'b'.repeat(64) }, program: { source: { filename: 'supplement.pdf' }, evidence: [], studies: [{ type: 'empirical' }, { type: 'empirical' }], issues: [
      { id: 'issue', severity: 'blocking', title: 'Missing scenario wording', reason: 'The available paper only summarizes the prompt.' },
    ] }, protocol: null, validated: false, runnable: false,
  }));
  assert.match(html, /id="run-experiment"/);
  assert.match(html, /Prepare and review an experiment/);
  assert.match(html, /href="\/try\?paper=paper_0123456789abcdef01234567&amp;revision=b{64}&amp;intent=run"/);
  assert.match(html, /Use the desktop app/);
  assert.match(html, /Fork to my projects/);
  assert.match(html, /select the experiment you want to run/);
  assert.match(html, /Build the study first/);
  assert.match(html, /Check readiness/);
  assert.match(html, /Run simulation/);
  assert.match(html, /paper_0123456789abcdef01234567/);
  assert.match(html, /supplement.pdf/);
  assert.match(html, /Missing scenario wording/);
  assert.doesNotMatch(html, />Validated protocol/);
});

test('run setup recognizes the canonical paper path when its display filename differs', () => {
  const RunExperiment = load('components/RunExperiment.tsx').default;
  const html = renderToStaticMarkup(React.createElement(RunExperiment, {
    paper: { ...paper, assetFiles: [{ path: 'sources/open/paper.pdf' }] },
    program: { source: { filename: 'Published paper.pdf' }, studies: [], issues: [],
      evidence: [{ sourceId: 'paper', path: 'sources/open/paper.pdf' }] },
    protocol: null, validated: false, runnable: false,
  }));
  assert.doesNotMatch(html, /does not identify an included copy|has no paper PDF/);
});

let documentContent;
const Docs = load('app/docs/[slug]/page.tsx', {
  fs: { promises: { readFile: async () => {
    if (documentContent === undefined) throw new Error('Missing document');
    return documentContent;
  } } },
  'next/navigation': { notFound: () => { throw new Error('Not found'); } },
}).default;

test('the guide template preserves Markdown, source callouts and document navigation', async () => {
  documentContent = '# Source heading\n\nOriginal instructions.\n\n[Next guide](extract_from_paper.md#materials)\n\n!!! warning "Check the source"\n    Keep this qualification.\n';
  const html = renderToStaticMarkup(await Docs({ params: Promise.resolve({ slug: 'what_to_submit' }) }));
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /What Should I Submit\?/);
  assert.match(html, /Original instructions/);
  assert.match(html, /href="\/docs\/extract_from_paper#materials"/);
  assert.match(html, /Check the source/);
  assert.match(html, /Keep this qualification/);
  assert.match(html, /aria-label="Contributor guides"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /aria-label="Guide pages"/);
  assert.doesNotMatch(html, /<main\b|Source heading/);
});

test('missing guide content and unknown document slugs retain the not-found response', async () => {
  documentContent = undefined;
  await assert.rejects(Docs({ params: Promise.resolve({ slug: 'what_to_submit' }) }), /Not found/);
  await assert.rejects(Docs({ params: Promise.resolve({ slug: 'unknown-guide' }) }), /Not found/);
});

test('shared loading, error and not-found views retain clear recovery actions', () => {
  const Loading = load('components/PageLoading.tsx').default;
  const ErrorPage = load('app/error.tsx').default;
  const NotFound = load('app/not-found.tsx').default;
  assert.match(render(Loading), /role="status"/);
  assert.match(renderToStaticMarkup(React.createElement(ErrorPage, { reset: () => {} })), /Try again/);
  const html = render(NotFound);
  assert.match(html, /href="\/studies"/);
  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /<main\b/);
});

test('the collaboration page renders its map and contact details before JavaScript loads', () => {
  const bytes = fs.readFileSync(path.join(root, 'public/data/maps/world_110m.json'));
  const topology = JSON.parse(bytes);
  const source = JSON.parse(fs.readFileSync(path.join(root, 'public/data/maps/source.json'), 'utf8'));
  assert.equal(topology.type, 'Topology');
  assert.ok(topology.objects.countries);
  assert.ok(topology.objects.land);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  const Collaboration = load('app/collaboration/page.tsx').default;
  const html = render(Collaboration);
  const header = html.match(/<header\b[^>]*>(.*?)<\/header>/s)?.[1];
  assert.ok(header);
  assert.match(header, /AI tools for social science/);
  assert.match(header, /href="mailto:xul049@ucsd.edu"/);
  assert.equal((html.match(/mailto:/g) || []).length, 1);
  assert.doesNotMatch(html, /Work with HumanStudy-Hub/);
  assert.match(html, /<svg\b[^>]*role="img"/);
  assert.match(html, /World map of HumanStudy-Hub partnerships/);
  assert.equal((html.match(/<circle\b/g) || []).length, 7);
  assert.match(html, /University of California San Diego/);
  assert.match(html, /University of Lausanne/);
  assert.match(html, /<details\b/);
  assert.doesNotMatch(html, /(?:NaN|Infinity|undefined)/);
  for (const [, pathData] of html.matchAll(/\bd="([^"]+)"/g)) {
    for (const [ring] of pathData.matchAll(/M[^MZ]+Z/g)) {
      const longitudes = [...ring.matchAll(/[ML](-?[\d.]+),/g)].map(match => Number(match[1]));
      for (let index = 1; index < longitudes.length; index++) {
        assert.ok(Math.abs(longitudes[index] - longitudes[index - 1]) <= 500, 'Country borders do not cross the entire map at the date line');
      }
    }
  }
});
