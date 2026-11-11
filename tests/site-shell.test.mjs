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
const destinations = ['/forum', '/studies', '/download', '/results', '/collaboration', '/account'];

test('public navigation preserves every existing destination on desktop and mobile', () => {
  for (pathname of ['/', '/studies', '/account', '/download', '/results', '/collaboration']) {
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
  assert.match(html, /Human studies\./);
  assert.match(html, /Built for AI agents\./);
});

test('the homepage groups all four actions in the requested order without secondary sections', () => {
  const html = render(Home);
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, ['/download', '/forum', '/collaboration', '/studies']);
  assert.match(html, /aria-label="Explore HumanStudy Hub"/);
  assert.doesNotMatch(html, /Questions we’re exploring|Join the conversation|<h2/);
});

const { developmentUpdated, libraryAvailability, validateResearchQuery } = load('lib/research.ts');
const libraryCalls = [];
let libraryResult;
let libraryError;
const Studies = load('app/studies/page.tsx', {
  '@/lib/research': {
    validateResearchQuery, developmentUpdated, libraryAvailability,
    searchLibrary: async (input, pool) => {
      libraryCalls.push({ input, pool });
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
};
const results = { items: [paper], total: 1, counts: { all: 336, program: 34, runnable: 9, protocol: 0, development: 20, indexed: 282 }, offset: 0, limit: 30, nextOffset: null };

test('the styled study library uses the real search contract and retains paper metadata', async () => {
  const html = await renderStudies({ q: 'knobe' }, results);
  assert.equal(libraryCalls.length, 1);
  assert.equal(libraryCalls[0].pool, 'all');
  assert.equal(libraryCalls[0].input.query, 'knobe');
  assert.match(html, /href="\/studies\/paper_0123456789abcdef01234567"/);
  assert.match(html, /Published study/);
  assert.match(html, /Original author/);
  assert.match(html, /2024/);
  assert.match(html, /Study materials/);
  assert.match(html, /<h1>Study Library<\/h1>/);
  assert.match(html, /1 record\b/);
  assert.match(html, /href="\/studies\?q=knobe&amp;status=development"[^>]*>In development <span>20/);
  assert.doesNotMatch(html, /Study collections|name="pool"/);
});

test('the old pending link opens the awaiting-extraction filter', async () => {
  const html = await renderStudies({ q: 'knobe', pool: 'pending' }, {
    ...results, items: [{ ...paper, legacyStudyId: null }], other: 0,
  });
  assert.equal(libraryCalls[0].pool, 'indexed');
  assert.match(html, /<h1>Study Library<\/h1>/);
  assert.match(html, /name="status" value="indexed"/);
  assert.match(html, /href="\/studies\?q=knobe"[^>]*>All indexed/);
  assert.match(html, /<span>Indexed<\/span>/);
  assert.doesNotMatch(html, /more indexed/);
});

test('library pagination preserves the search query and the selected pool', async () => {
  const html = await renderStudies({ q: 'choice & risk', pool: 'pending', offset: '30' }, {
    ...results, total: 90, offset: 30, nextOffset: 60,
  });
  assert.equal(libraryCalls[0].pool, 'indexed');
  assert.equal(libraryCalls[0].input.query, 'choice & risk');
  assert.equal(libraryCalls[0].input.offset, 30);
  assert.match(html, /<h1>Study Library<\/h1>/);
  const links = [...html.matchAll(/href="([^"]+)"/g)]
    .map(match => new URL(match[1].replaceAll('&amp;', '&'), 'http://local.test'));
  for (const offset of ['0', '60']) {
    const url = links.find(link => link.searchParams.get('offset') === offset);
    assert.ok(url, 'Pagination exposes offset ' + offset);
    assert.equal(url.searchParams.get('q'), 'choice & risk');
    assert.equal(url.searchParams.get('status'), 'indexed');
  }
});

test('invalid study queries display an error without querying the catalog', async () => {
  const html = await renderStudies({ offset: '-1' }, results);
  assert.equal(libraryCalls.length, 0);
  assert.match(html, /role="alert"/);
  assert.match(html, /Invalid offset/);
});

test('empty studies and catalog outages retain accessible recovery states', async () => {
  const empty = await renderStudies({ q: 'no match' }, { ...results, items: [], total: 0 });
  assert.match(empty, /No studies match this view\./);
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
