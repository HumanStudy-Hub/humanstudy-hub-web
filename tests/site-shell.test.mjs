import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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

const { validateResearchQuery } = load('lib/research.ts');
const libraryCalls = [];
let libraryResult;
let libraryError;
const Studies = load('app/studies/page.tsx', {
  '@/lib/research': {
    validateResearchQuery,
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
const results = { items: [paper], total: 1, other: 287, offset: 0, limit: 30, nextOffset: null };

test('the styled study library uses the real search contract and retains paper metadata', async () => {
  const html = await renderStudies({ q: 'knobe' }, results);
  assert.equal(libraryCalls.length, 1);
  assert.equal(libraryCalls[0].pool, 'extracted');
  assert.equal(libraryCalls[0].input.query, 'knobe');
  assert.match(html, /href="\/studies\/paper_0123456789abcdef01234567"/);
  assert.match(html, /Published study/);
  assert.match(html, /Original author/);
  assert.match(html, /2024/);
  assert.match(html, /Study materials/);
  assert.match(html, /<h1>Study Library<\/h1>/);
  assert.doesNotMatch(html, /Study collections|Extracted studies|Not yet extracted|awaiting extraction|\b\d+ papers?\b|name="pool"/);
});

test('library pagination preserves the search query and discards legacy collection parameters', async () => {
  const html = await renderStudies({ q: 'choice & risk', pool: 'pending', offset: '30' }, {
    ...results, total: 90, offset: 30, nextOffset: 60,
  });
  assert.equal(libraryCalls[0].pool, 'extracted');
  assert.equal(libraryCalls[0].input.query, 'choice & risk');
  assert.equal(libraryCalls[0].input.offset, 30);
  assert.match(html, /<h1>Study Library<\/h1>/);
  assert.doesNotMatch(html, /name="pool"|Not yet extracted|awaiting extraction|\b\d+ papers?\b/);
  const links = [...html.matchAll(/href="([^"]+)"/g)]
    .map(match => new URL(match[1].replaceAll('&amp;', '&'), 'http://local.test'));
  for (const offset of ['0', '60']) {
    const url = links.find(link => link.searchParams.get('offset') === offset);
    assert.ok(url, 'Pagination exposes offset ' + offset);
    assert.equal(url.searchParams.get('q'), 'choice & risk');
    assert.equal(url.searchParams.has('pool'), false);
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
  assert.match(empty, /No matching papers\./);
  const unavailable = await renderStudies({}, undefined, new Error('Unavailable'));
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /The research library could not be loaded/);
  assert.match(unavailable, /role="search"/);
});
