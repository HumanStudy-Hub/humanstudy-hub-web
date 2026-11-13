import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checkRemainingFrontend } from './check-remaining-frontend.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const output = process.env.FRONTEND_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'humanstudy-frontend-'));
const accessSecret = 'frontend-preview-only-cookie-secret';
fs.mkdirSync(output, { recursive: true });

assert.ok(fs.existsSync(path.join(root, '.next/BUILD_ID')), 'Run npm run build before checking the frontend.');
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  assert.ok(!fs.existsSync(path.join(root, name)), 'Use a checkout without environment files: ' + name);
}

const fixtures = new Map([
  ['/research-index.json', fs.readFileSync(path.join(root, 'data/research_index.json'))],
  ['/studies-index.json', fs.readFileSync(path.join(root, 'data/studies_index.json'))],
]);
const researchIndex = JSON.parse(fixtures.get('/research-index.json').toString('utf8'));
const development = JSON.parse(fs.readFileSync(path.join(root, 'data/studies-in-development.json'), 'utf8'));
const developmentLinks = development.papers.map(paper => {
  const alias = 'doi:' + paper.doi;
  const existing = researchIndex.papers.find(item => item.doi === paper.doi || item.aliases.includes(alias));
  const id = existing?.id ?? 'paper_' + createHash('sha256').update(alias).digest('hex').slice(0, 24);
  return '/studies/' + id;
}).sort();
// Keep the browser fixture deterministic as the bundled catalog gains real packages.
// This test deliberately exercises one interactive paper against indexed-only records.
for (const paper of researchIndex.papers) {
  delete paper.currentRevision;
  delete paper.assetFiles;
  delete paper.protocol;
  delete paper.publication;
}
researchIndex.publications = {};
const interactivePaper = researchIndex.papers.find(paper => paper.legacyStudyId === 'study_001');
assert.ok(interactivePaper, 'The fixture requires the original team-contributed study.');
interactivePaper.assetRoot = 'studies/study_001';
interactivePaper.aliases = interactivePaper.aliases.filter(alias => !alias.startsWith('community:'));
interactivePaper.currentRevision = 'a'.repeat(64);
interactivePaper.contributors = [{ github: 'assassin808' }];
interactivePaper.assetFiles = [{ path: 'program.json' }];
fixtures.set('/research-index.json', Buffer.from(JSON.stringify(researchIndex)));
const interactiveLink = '/studies/' + interactivePaper.id;
const indexedLinks = [...new Set([
  ...researchIndex.papers.map(paper => '/studies/' + paper.id),
  ...developmentLinks,
])].sort();
const fixtureServer = createServer((request, response) => {
  const body = fixtures.get(request.url);
  if (request.method !== 'GET' || !body) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
});
const report = { passed: false, views: [], checks: [], runtimeErrors: [], runtimeErrorDetails: [], blockedWrites: [], mockedAuthActions: [], checkedAt: new Date().toISOString() };
const navigation = [
  ['Forum', '/forum'], ['Study Library', '/studies'], ['Desktop app', '/download'],
  ['Research', '/research'], ['Partnerships', '/collaboration'], ['Account', '/account'],
];
let server;
let browser;

try {
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  const env = {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    RESEARCH_INDEX_URL: fixtureOrigin + '/research-index.json',
    STUDIES_INDEX_URL: fixtureOrigin + '/studies-index.json',
    ACCESS_COOKIE_SECRET: accessSecret,
    PROMO_CODE: 'frontend-preview-only',
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }

  server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '-p', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  let origin;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, 'The production server remains running: ' + log);
    origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (origin) {
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.status === 200) break;
      } catch { /* Wait for the local production server. */ }
    }
    origin = undefined;
    await delay(100);
  }
  assert.ok(origin, 'The local production server starts: ' + log);

  browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route(/^https?:/, route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/_vercel/')) return route.abort();
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.blockedWrites.push({ method: request.method(), path: url.pathname });
      return route.abort();
    }
    if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === new URL(origin).port) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => {
    report.runtimeErrors.push(error.message);
    report.runtimeErrorDetails.push({ page: page.url(), message: error.message, stack: error.stack });
    console.log('Browser error at ' + page.url() + ': ' + error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error' && /hydration|hydrating|Minified React error/i.test(message.text())) {
      report.runtimeErrors.push(message.text());
      report.runtimeErrorDetails.push({ page: page.url(), message: message.text() });
    }
  });
  const visit = async route => {
    const response = await page.goto(origin + route, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200, route + ' loads');
  };

  // Account requests are fulfilled in the browser; no credentials reach the application server.
  const authRequests = [];
  const previewUser = { id: 'preview-user', email: 'preview@example.test' };
  let signedIn = false;
  let rejectSignIn = true;
  await page.route(origin + '/api/studio/auth', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill({ json: { user: signedIn ? previewUser : null, configured: true } });
    }
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON();
    authRequests.push(body);
    report.mockedAuthActions.push(body.action);
    if (body.action === 'forgot-password') return route.fulfill({ json: { sent: true } });
    if (body.action === 'confirm') return route.fulfill({ json: { user: previewUser } });
    if (body.action === 'signup') {
      return route.fulfill({ json: { requiresEmailConfirmation: true } });
    }
    if (body.action === 'signin') {
      if (rejectSignIn) return route.fulfill({ status: 401, json: { error: 'authentication_failed' } });
      signedIn = true;
      return route.fulfill({ json: { user: previewUser } });
    }
    assert.equal(body.action, 'signout');
    signedIn = false;
    return route.fulfill({ json: {} });
  });

  for (const width of [1600, 1280, 1024, 820, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await visit('/');
    await page.evaluate(async () => {
      await document.fonts.ready;
      await document.querySelector('main img').decode();
    });
    assert.equal(await page.locator('main').count(), 1, 'The page has one main landmark.');
    assert.equal(await page.locator('h1').count(), 1);
    assert.ok(await page.getByRole('heading', { name: 'Open infrastructure for human-study research' }).isVisible());
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      headingFont: getComputedStyle(document.querySelector('h1')).fontFamily,
      background: getComputedStyle(document.body).backgroundColor,
      fontsLoaded: [...document.fonts].filter(font => ['Newsreader', 'IBM Plex Sans'].includes(font.family.replaceAll('"', ''))).every(font => font.status === 'loaded'),
    }));
    assert.ok(layout.width <= layout.viewport + 1, 'No horizontal overflow at ' + width);
    assert.match(layout.headingFont, /Newsreader/);
    assert.equal(layout.background, 'rgb(243, 245, 239)');
    assert.ok(layout.fontsLoaded, 'Local fonts load.');
    const actions = page.getByRole('navigation', { name: 'Explore HumanStudy Hub', exact: true });
    assert.deepEqual(await actions.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/download', '/forum', '/collaboration', '/studies']);
    assert.equal(await page.getByText('Questions we’re exploring.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Join the conversation.', { exact: true }).count(), 0);

    const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
    if (width < 1024) await nav.locator('summary').click();
    for (const [name, href] of navigation) {
      const link = nav.getByRole('link', { name, exact: true }).filter({ visible: true });
      assert.equal(await link.count(), 1, name + ' has one visible entry at ' + width);
      assert.equal(await link.getAttribute('href'), href);
      const box = await link.boundingBox();
      assert.ok(box.height >= 44, name + ' has a usable touch target.');
    }
    if (width < 1024) {
      await page.keyboard.press('Escape');
      assert.equal(await nav.locator('details').getAttribute('open'), null);
      assert.equal(await nav.locator('summary').evaluate(element => element === document.activeElement), true);
    }
    await page.screenshot({ path: path.join(output, `home-${width}.png`), fullPage: true });
    report.views.push({ page: '/', width, ...layout });
  }
  report.checks.push('Responsive homepage, four grouped actions and all six navigation destinations');

  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ['/studies', '/studies?pool=pending', '/account']) {
      await visit(route);
      if (route === '/account') await page.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.querySelectorAll('main img')].map(image => image.decode()));
      });
      const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      assert.ok(size.width <= size.viewport + 1, route + ' has no overflow at ' + width);
      assert.equal(await page.locator('main').count(), 1);
      assert.equal(await page.locator('h1').count(), 1);
      if (route.startsWith('/studies')) {
        const heading = 'Study Library';
        await page.getByRole('heading', { name: heading, exact: true }).waitFor({ state: 'visible' });
        assert.equal(await page.getByRole('navigation', { name: 'Study collections', exact: true }).count(), 0);
      }
      if (width === 1280 || width === 390) {
        const name = route === '/account' ? 'account' : route.includes('pending') ? 'legacy-studies' : 'studies';
        await page.screenshot({ path: path.join(output, `${name}-${width}.png`), fullPage: true });
      }
      report.views.push({ page: route, width, ...size });
    }
  }
  report.checks.push('Responsive account, study library and not-yet-extracted list');

  await page.setViewportSize({ width: 390, height: 900 });
  await visit('/');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').innerText(), 'Skip to content');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'main-content');
  await page.locator('nav[data-site-navigation] summary').click();
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Study Library', exact: true }).filter({ visible: true }).click();
  await page.waitForURL(origin + '/studies');
  await page.getByRole('heading', { name: 'Study Library', exact: true }).waitFor();
  assert.equal(await page.locator('nav[data-site-navigation] details').getAttribute('open'), null, 'Selecting a mobile link closes the menu.');
  report.checks.push('Keyboard skip link, menu Escape and mobile navigation');

  const paperLinks = page.locator('main article h2 a');
  const listedLinks = () => paperLinks.evaluateAll(links => links.map(link => link.getAttribute('href')));
  const paperViews = page.getByRole('navigation', { name: 'Paper views', exact: true });
  assert.deepEqual(await paperViews.getByRole('link').allTextContents(), ['Interactive papers', 'All papers']);
  assert.equal(await paperViews.getByRole('link', { name: 'Interactive papers', exact: true }).getAttribute('aria-current'), 'page');
  assert.deepEqual(await listedLinks(), [interactiveLink], 'The default view lists interactive papers.');
  const attribution = page.getByText('Contributed by HumanStudy Hub Team', { exact: true });
  assert.ok(await attribution.isVisible());
  assert.equal(await attribution.evaluate(element => element.previousElementSibling.textContent), 'Run experiment');
  await paperViews.getByRole('link', { name: 'All papers', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('status') === 'all');
  assert.deepEqual(await listedLinks(), indexedLinks.slice(0, 30), 'All papers lists the complete catalog.');
  assert.ok(indexedLinks.length > 1, 'The bundled catalog can exercise pagination with an offset.');
  await visit('/studies?status=all&offset=1');
  assert.deepEqual(await listedLinks(), indexedLinks.slice(1, 31), 'The existing offset contract still applies.');
  await page.getByRole('navigation', { name: 'Research pages', exact: true }).getByRole('link', { name: '← Previous', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('offset') === '0' && url.searchParams.get('status') === 'all');
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await listedLinks(), indexedLinks.slice(0, 30));
  const nextPage = page.getByRole('navigation', { name: 'Research pages', exact: true }).getByRole('link', { name: 'Next →', exact: true });
  if (indexedLinks.length > 30) {
    await nextPage.click();
    await page.waitForURL(url => url.searchParams.get('offset') === '30' && url.searchParams.get('status') === 'all');
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await listedLinks(), indexedLinks.slice(30, 60));
  } else {
    assert.equal(await nextPage.count(), 0, 'A single-page catalog does not show a next-page link.');
  }
  report.checks.push('Catalog contents and real pagination');

  await paperViews.getByRole('link', { name: 'Interactive papers', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('status') === 'program');
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await listedLinks(), [interactiveLink]);
  assert.equal(await page.getByRole('link', { name: /^Interact with paper/ }).getAttribute('href'), '/try?paper=' + interactivePaper.id + '&revision=' + interactivePaper.currentRevision + '&intent=read');
  await page.getByRole('link', { name: /^Run experiment/ }).click();
  await page.waitForURL(origin + interactiveLink + '#run-experiment');
  const runExperiment = page.getByRole('link', { name: 'Run experiment', exact: true });
  await runExperiment.waitFor();
  assert.equal(await runExperiment.getAttribute('id'), 'run-experiment');
  assert.equal(await runExperiment.getAttribute('href'), '/try?paper=' + interactivePaper.id + '&revision=' + interactivePaper.currentRevision + '&intent=run');
  assert.equal(await page.getByRole('link', { name: 'Interact with paper', exact: true }).count(), 0);
  assert.equal(await attribution.count(), 0);

  await visit('/studies?status=program');
  await page.getByRole('checkbox', { name: 'Validated protocols only' }).check();
  await page.waitForURL(url => url.searchParams.get('status') === 'program' && url.searchParams.get('validated') === '1');
  assert.ok(await page.getByRole('checkbox', { name: 'Validated protocols only' }).isChecked());
  assert.ok(await page.getByText('No papers match this view.', { exact: true }).isVisible());
  report.checks.push('Interactive paper view, validation filter and single experiment action');

  await visit('/studies?status=development');
  assert.deepEqual(await listedLinks(), developmentLinks);
  await paperLinks.first().click();
  await page.waitForURL(/\/studies\/paper_[a-f0-9]{24}$/);
  await page.getByText(/In development ·/).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Be the first to contribute a reconstruction', exact: true }).getAttribute('href'), '/contribute');
  report.checks.push('Legacy development view and detail navigation');

  await visit('/studies?status=all&offset=1');
  await page.getByRole('textbox', { name: 'Search papers' }).fill('knobe');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/studies' && url.searchParams.get('q') === 'knobe' && url.searchParams.get('status') === 'all' && !url.searchParams.has('pool') && !url.searchParams.has('offset'));
  assert.equal(await page.getByRole('textbox', { name: 'Search papers' }).inputValue(), 'knobe');
  const paper = page.locator('main a[href^="/studies/paper_"]').first();
  assert.ok(await paper.isVisible(), 'Existing catalog search returns a paper.');
  await paper.click();
  await page.waitForURL(/\/studies\/paper_[a-f0-9]{24}$/);
  await page.locator('main h1').waitFor();
  report.checks.push('Existing study search and catalog-to-detail navigation');

  await visit('/studies?q=zzzz-no-matching-paper-zzzz');
  assert.ok(await page.getByText('No papers match this view.', { exact: true }).isVisible());
  assert.equal(await page.locator('main a[href^="/studies/paper_"]').count(), 0);
  report.checks.push('Empty study search');

  const returnTo = 'https://forum.humanstudy-hub.com/posts/layout-check';
  await visit('/account?' + new URLSearchParams({ returnTo }));
  const account = page.getByRole('region', { name: 'Account access', exact: true });
  await account.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor();
  assert.equal(new URL(await account.getByRole('link', { name: 'Forgot password?', exact: true }).getAttribute('href'), origin).searchParams.get('returnTo'), returnTo);
  const email = account.getByRole('textbox', { name: 'Email', exact: true });
  const password = account.locator('input[name=password]');
  await email.fill(previewUser.email);
  await password.fill('short');
  await account.getByRole('form', { name: 'Sign in', exact: true }).getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.equal(authRequests.length, 0, 'Native password validation prevents an invalid request.');
  await password.fill('preview-only-password');
  await account.getByRole('form', { name: 'Sign in', exact: true }).getByRole('button', { name: 'Sign in', exact: true }).click();
  await account.getByRole('alert').waitFor();
  assert.match(await account.getByRole('alert').innerText(), /Could not sign in/);
  assert.equal(authRequests.at(-1).action, 'signin');
  assert.equal(authRequests.at(-1).returnTo, returnTo);
  assert.equal(await email.inputValue(), previewUser.email);

  await account.getByRole('navigation', { name: 'Account action', exact: true }).getByRole('button', { name: 'Create account', exact: true }).click();
  assert.equal(await password.getAttribute('autocomplete'), 'new-password');
  await account.getByRole('form', { name: 'Create account', exact: true }).getByRole('button', { name: 'Create account', exact: true }).click();
  await account.getByText('Check your email to confirm your account, then continue here.', { exact: true }).waitFor();
  assert.equal(authRequests.at(-1).action, 'signup');
  assert.equal(authRequests.at(-1).returnTo, returnTo);
  assert.equal(await password.inputValue(), '');
  assert.ok(await account.getByRole('button', { name: /^Resend in \d+s$/ }).isDisabled());

  rejectSignIn = false;
  await visit('/account');
  await account.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor();
  await email.fill(previewUser.email);
  await password.fill('preview-only-password');
  await account.getByRole('form', { name: 'Sign in', exact: true }).getByRole('button', { name: 'Sign in', exact: true }).click();
  await account.getByRole('heading', { name: 'Your account', exact: true }).waitFor();
  assert.equal(await account.getByRole('link', { name: 'Your projects', exact: true }).getAttribute('href'), '/build/projects');
  await visit('/account?action=logout');
  await account.getByRole('heading', { name: 'Sign out?', exact: true }).waitFor();
  await account.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(origin + '/');
  report.checks.push('Mocked account validation, sign-in failure and success, returnTo, signup confirmation, resend cooldown and sign-out');

  await checkRemainingFrontend({ page, origin, root, output, report, accessSecret, setSignedIn: value => { signedIn = value; }, paperPath: indexedLinks[0] });

  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const route of ['/download', '/account', '/access', '/auth/confirm', '/auth/reset', '/results', '/studies/study_001', '/studies/study_005']) {
    await visit(route);
    assert.ok(await page.locator('main h1').first().isVisible(), route + ' retains visible content.');
    assert.ok(await page.getByRole('navigation', { name: 'Main navigation', exact: true }).isVisible());
  }
  report.checks.push('Download, account, access, email confirmation, password recovery, results and featured study pages');

  await visit('/build/design');
  assert.equal(await page.locator('[data-site-navigation], [data-site-footer]').count(), 0, 'The editor keeps its own chrome.');
  await page.screenshot({ path: path.join(output, 'editor.png'), fullPage: true });
  report.checks.push('Existing editor navigation isolation');

  for (const route of ['/api/pipeline/jobs', '/api/playground/runs', '/api/contribute/upload', '/api/community/mine']) {
    const response = await fetch(origin + route, { redirect: 'manual' });
    await response.arrayBuffer();
    assert.equal(response.status, 401, route + ' remains protected.');
  }
  report.checks.push('Existing access gates');

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await visit('/forum');
    await page.getByRole('heading', { name: 'Community forum', exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, origin);
    assert.equal(await page.locator('[data-site-navigation], [data-site-footer]').count(), 2);
    const links = page.getByRole('region', { name: 'Featured posts' }).getByRole('link');
    assert.deepEqual(await links.evaluateAll(items => items.map(item => item.getAttribute('href'))), [
      '/forum/making-human-studies-as-reproducible-as-open-source-code',
      '/forum/beyond-human-likeness-preserving-the-human-trace',
    ]);
    const preview = page.getByRole('img', { name: /The HumanStudy Forum discussions page/ });
    await preview.evaluate(img => img.decode());
    assert.ok(await preview.isVisible());
    assert.equal(await preview.evaluate(img => img.closest('a')?.href), 'https://forum.humanstudy-hub.com/');
    assert.equal(await page.getByRole('link', { name: 'Open the forum', exact: true }).getAttribute('href'), 'https://forum.humanstudy-hub.com/');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Forum stays within the viewport.');
    await page.screenshot({ path: path.join(output, `forum-${width}.png`), fullPage: true });
  }
  for (const slug of ['making-human-studies-as-reproducible-as-open-source-code', 'beyond-human-likeness-preserving-the-human-trace']) {
    await page.getByRole('region', { name: 'Featured posts' }).locator(`a[href="/forum/${slug}"]`).click();
    await page.waitForURL(origin + '/forum/' + slug);
    assert.ok(await page.getByRole('link', { name: 'Original post and discussion on the HumanStudy Forum' }).isVisible());
    await page.getByRole('link', { name: '← Forum', exact: true }).click();
    await page.waitForURL(origin + '/forum');
  }
  report.checks.push('Community-first Forum with two same-site featured posts');

  assert.deepEqual(report.runtimeErrors, []);
  assert.deepEqual(report.blockedWrites, []);
  report.passed = true;
  console.log('Passed homepage, account and study layouts; search, pagination, mocked auth, keyboard navigation and access checks.');
} catch (error) {
  report.failure = error.stack;
  try {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  } catch { /* Preserve the original failure when the page has already closed. */ }
  throw error;
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Frontend validation evidence: ' + output);
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (fixtureServer.listening) await new Promise(resolve => fixtureServer.close(resolve));
}
