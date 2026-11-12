import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';

const require = createRequire(import.meta.url);

function exampleModel(root) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(root, 'app/build-preview/study-schema.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('module', 'exports', compiled)(loaded, loaded.exports);
  return loaded.exports.study;
}

export async function checkRemainingFrontend({ page, origin, root, output, report, accessSecret, setSignedIn, paperPath }) {
  const checked = message => {
    report.checks.push(message);
    console.log('Passed: ' + message);
  };
  const model = exampleModel(root);
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const intakeId = '22222222-2222-4222-8222-222222222222';
  const processingId = '33333333-3333-4333-8333-333333333333';
  const document = {
    version: 1, title: model.title, model, sources: [], annotations: [],
    conversations: [], reviewResponses: {},
  };
  const workspace = {
    id: workspaceId, title: model.title, revision: 1, document,
    created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z',
  };
  const blank = { ...document, title: 'New research project', model: { ...model, entities: [], relations: [], procedure: [], variables: [] } };
  const projects = [
    { ...workspace, document: undefined, project: { archived: false } },
    { ...workspace, id: intakeId, title: 'Archived research project', document: undefined, project: { archived: true } },
  ];
  const workspaces = new Map([
    [workspaceId, workspace],
    [intakeId, { ...workspace, id: intakeId, title: blank.title, document: blank }],
    [processingId, { ...workspace, id: processingId, title: blank.title, document: {
      ...blank,
      pipeline: { jobId: 'preview-job', status: 'queued', message: 'Waiting for the study agent.', updatedAt: new Date().toISOString() },
    } }],
  ]);
  report.mockedWorkspaceActions = [];
  const projectRequests = [];

  // Every workspace write stays inside Playwright. Unexpected requests fail the check.
  await page.route(origin + '/api/studio/workspaces{,/**}', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const [, , , , id, operation] = pathname.split('/');
    if (request.method() === 'GET') {
      if (pathname === '/api/studio/workspaces') return route.fulfill({ json: { workspaces: projects } });
      if (operation === 'pipeline') return route.fulfill({ json: { job: { status: 'queued', message: 'Waiting for the study agent.' }, discussion: null } });
      const item = workspaces.get(id);
      if (item) return route.fulfill({ json: { workspace: item } });
    }
    report.mockedWorkspaceActions.push({ method: request.method(), path: pathname });
    if (operation === 'events') return route.fulfill({ json: { ok: true } });
    const body = request.postDataJSON();
    if (request.method() === 'PATCH' && workspaces.has(id)) {
      const item = workspaces.get(id);
      assert.equal(body.expectedRevision, item.revision);
      item.document = body.document;
      item.revision++;
      const project = projects.find(project => project.id === id);
      if (project) project.revision = item.revision;
      return route.fulfill({ json: { workspace: item } });
    }
    if (request.method() === 'POST' && pathname === '/api/studio/workspaces') {
      projectRequests.push(body);
      assert.ok(body.document?.title);
      return route.fulfill({ status: 503, json: { error: 'Preview creation is unavailable. Try again.' } });
    }
    if (request.method() === 'POST' && operation === 'project') {
      projectRequests.push(body);
      assert.equal(body.action, 'rename');
      const item = workspaces.get(id);
      assert.equal(body.revision, item.revision);
      item.title = body.title;
      item.document.title = body.title;
      projects[0].title = body.title;
      return route.fulfill({ json: { workspace: item } });
    }
    assert.fail('Unexpected mocked workspace request: ' + request.method() + ' ' + pathname);
  });

  let recoveryReady = false;
  await page.route(origin + '/api/studio/password', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ready: recoveryReady, email: recoveryReady ? 'preview@example.test' : undefined } });
    const body = route.request().postDataJSON();
    assert.ok(['begin', 'reset', 'change', 'clear'].includes(body.action));
    report.mockedAuthActions.push('password:' + body.action);
    recoveryReady = body.action === 'begin';
    return route.fulfill({ json: body.action === 'begin' ? { ready: true, email: 'preview@example.test' } : { ok: true } });
  });

  async function visit(route, status = 200) {
    const response = await page.goto(origin + route, { waitUntil: 'networkidle' });
    assert.equal(response.status(), status, route + ' keeps its response status');
    assert.equal(new URL(page.url()).pathname, new URL(route, origin).pathname, route + ' reaches its actual page');
  }

  async function checkLayout(route, width, name) {
    await page.evaluate(() => document.fonts.ready);
    await page.locator('main img').evaluateAll(async images => {
      for (const image of images) image.loading = 'eager';
      await Promise.all(images.map(image => image.decode()));
    });
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    if (size.width > size.viewport + 1) {
      await page.screenshot({ path: path.join(output, 'overflow-' + name + '-' + width + '.png'), fullPage: true });
    }
    assert.ok(size.width <= size.viewport + 1, route + ' has no horizontal overflow at ' + width + ': ' + size.width);
    assert.equal(await page.locator('main').count(), 1, route + ' has one main landmark');
    report.views.push({ page: route, width, ...size });
    if (width === 1280 || width === 390) {
      await page.screenshot({ path: path.join(output, name + '-' + width + '.png'), fullPage: true });
    }
  }

  const routes = [
    ['/download', 'download'], ['/research/humanstudy-bench', 'results'], ['/collaboration', 'collaboration'],
    ['/contribute', 'contribute'], ['/benchmark', 'benchmark'], ['/citation', 'citation'],
    ['/access', 'access'], ['/auth/confirm', 'confirm'], ['/auth/reset', 'recovery'],
    ['/auth/reset?mode=change', 'change-password'], ['/pipeline', 'workspace-choice'],
    ['/pipeline?legacy=1', 'legacy-pipeline'], [paperPath, 'paper'], ['/studies/study_005', 'legacy-study'],
  ];

  // The map and native partner list must remain usable without client-side JavaScript.
  const noScriptContext = await page.context().browser().newContext({
    javaScriptEnabled: false, viewport: { width: 390, height: 1000 },
  });
  try {
    await noScriptContext.route('**/*', route => {
      const request = route.request();
      return new URL(request.url()).origin === origin && ['GET', 'HEAD'].includes(request.method())
        ? route.continue()
        : route.abort();
    });
    const noScriptPage = await noScriptContext.newPage();
    const response = await noScriptPage.goto(origin + '/collaboration', { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    const map = noScriptPage.getByRole('img', { name: /World map of HumanStudy-Hub partnerships/ });
    assert.ok(await map.isVisible());
    assert.equal(await map.locator('circle').count(), 7);
    await noScriptPage.getByText('View research partners', { exact: true }).click();
    assert.ok(await noScriptPage.getByText('University of Lausanne', { exact: true }).isVisible());
    await noScriptPage.screenshot({ path: path.join(output, 'collaboration-no-javascript.png'), fullPage: true });
    checked('Collaboration map and partner list work with JavaScript disabled');
  } finally {
    await noScriptContext.close();
  }

  for (const route of ['/pipeline', '/playground']) {
    const response = await fetch(origin + route, { redirect: 'manual' });
    await response.arrayBuffer();
    assert.equal(response.status, 307);
    const destination = new URL(response.headers.get('location'), origin);
    assert.equal(destination.pathname, '/access');
    assert.equal(destination.searchParams.get('next'), route);
  }
  // This secret belongs only to the isolated server started by check-frontend.mjs.
  const cookie = createHmac('sha256', accessSecret).update('humanstudy-hub:unlock:v1').digest('hex');
  await page.context().addCookies([{ name: 'hs_unlock', value: cookie, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  setSignedIn(true);
  checked('Protected page redirects while anonymous, followed by an isolated local unlock for actual page coverage');
  async function checkResponsivePages() {
    setSignedIn(true);
    for (const width of [1280, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [route, name] of routes) {
        await visit(route);
        if (route === '/collaboration') {
          const map = page.getByRole('img', { name: /World map of HumanStudy-Hub partnerships/ });
          assert.ok(await map.isVisible());
          assert.equal(await map.locator('circle').count(), 7);
          assert.equal(await page.locator('main header a[href="mailto:xul049@ucsd.edu"]').count(), 1);
          assert.equal(await page.getByRole('heading', { name: 'Work with HumanStudy-Hub' }).count(), 0);
          await page.getByText('View research partners', { exact: true }).click();
          assert.ok(await page.getByText('University of Lausanne', { exact: true }).isVisible());
          await page.getByText('View research partners', { exact: true }).click();
        }
        await checkLayout(route, width, name);
      }
      for (const [route, name] of [
        ['/build/projects', 'projects'], ['/build/projects?new', 'new-project'],
        ['/build/' + workspaceId, 'workspace'], ['/build/' + intakeId, 'intake'],
        ['/build/' + processingId, 'processing'], ['/build/design', 'design-review'],
      ]) {
        await visit(route);
        const ready = route.startsWith('/build/projects') ? 'input[aria-label="Find a project"]' : '[data-studio-workspace], select#review-case';
        await page.locator(ready).first().waitFor();
        assert.equal(await page.locator('[data-site-navigation], [data-site-footer]').count(), 0);
        await checkLayout(route, width, name);
        if (route === '/build/' + workspaceId) {
          const controls = await page.getByRole('navigation', { name: 'Workspace views', exact: true }).getByRole('button').evaluateAll(buttons => buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return { name: button.innerText, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
          }));
          for (const [index, button] of controls.entries()) {
            assert.ok(button.x >= 0 && button.right <= width + 1, button.name + ' remains within the editor at ' + width);
            for (const other of controls.slice(index + 1)) {
              const overlap = Math.min(button.right, other.right) - Math.max(button.x, other.x) > 1 && Math.min(button.bottom, other.bottom) - Math.max(button.y, other.y) > 1;
              assert.equal(overlap, false, button.name + ' does not overlap ' + other.name + ' at ' + width);
            }
          }
        }
      }
      console.log('Checked remaining frontend layouts at ' + width + 'px.');
    }
    checked('All remaining public pages, project lists, intake, processing and editor layouts at four viewport widths');
  }

  async function checkUnavailablePages() {
    // Document bodies live outside this checkout. Their template is covered by the SSR tests.
    report.documentResponses = [];
    for (const route of ['/docs', '/docs/what_to_submit', '/docs/extract_from_paper', '/docs/build_study_files', '/docs/submit_study', '/playground', '/studies/paper_000000000000000000000000', '/missing-page']) {
      const response = await page.goto(origin + route, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 404, route + ' keeps its existing not-found behavior');
      await page.getByRole('heading', { name: 'Page not found.', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.getByRole('link', { name: 'Explore studies →', exact: true }).getAttribute('href'), '/studies');
      report.documentResponses.push({ path: route, status: response.status() });
    }
    await checkLayout('/missing-page', 320, 'notfound');
    checked('Document availability, hidden playground, missing research and styled not-found recovery');

    report.redirects = [];
    for (const [route, destination] of [
      ['/dataset', '/studies'], ['/community', '/studies'], ['/build', '/download'], ['/leaderboard', '/research/humanstudy-bench'], ['/results', '/research/humanstudy-bench'],
      ['/build-preview', '/build/example'], ['/build/example', '/build/projects?sample=intentional-action'],
      ['/docs', '/docs/what_to_submit'],
    ]) {
      const response = await fetch(origin + route, { redirect: 'manual' });
      await response.arrayBuffer();
      assert.ok([307, 308].includes(response.status), route + ' remains a redirect');
      assert.equal(new URL(response.headers.get('location'), origin).pathname + new URL(response.headers.get('location'), origin).search, destination);
      report.redirects.push({ route, destination, status: response.status });
    }
    checked('All existing alias redirects retain their destinations');
  }

  await page.setViewportSize({ width: 1280, height: 1000 });
  await visit('/download');
  const question = page.locator('main summary').filter({ hasText: 'Who can use the app?' });
  await question.click();
  assert.equal(await question.evaluate(element => element.closest('details').open), true);
  assert.ok(await page.locator('main img[src="/desktop/study-and-paper.webp"]').evaluate(image => image.complete && image.naturalWidth > 0));
  assert.ok(await page.locator('main a[href^="https://github.com/HumanStudy-Hub/humanstudy-desktop/releases"]').count() > 0);
  await visit('/research/humanstudy-bench');
  const filter = page.locator('main select').first();
  await filter.selectOption({ index: 1 });
  const rows = page.locator('tbody > tr');
  const count = await rows.count();
  assert.ok(count > 0);
  await rows.first().click();
  await page.locator('tbody > tr > td[colspan="8"]').waitFor();
  assert.equal(await rows.count(), count + 1);
  checked('Download assets, FAQ disclosure, leaderboard filtering and per-study expansion');

  await visit('/build/projects');
  const search = page.getByRole('textbox', { name: 'Find a project', exact: true });
  await search.fill('no-matching-preview-project');
  await page.getByRole('heading', { name: 'No matching projects', exact: true }).waitFor();
  await search.fill('');
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('link', { name: /Archived research project/ }).waitFor();
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await page.locator('summary[aria-label^="Actions for"]').first().click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Rename project', exact: true }).fill('Renamed preview project');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.getByRole('link', { name: /Renamed preview project/ }).waitFor();
  assert.equal(projectRequests.at(-1).action, 'rename');
  await page.getByRole('button', { name: '＋ New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Unsaved preview project');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('main').getByRole('alert').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Project name', exact: true }).inputValue(), 'Unsaved preview project');
  checked('Mocked project filtering, archive navigation, rename and creation failure without losing form input');

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('combobox', { name: /^Appearance/ }).selectOption('dark');
  assert.equal(await page.locator('[data-theme]').first().getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: path.join(output, 'projects-dark.png'), fullPage: true });
  await settings.getByRole('combobox', { name: /^Appearance/ }).selectOption('light');
  await settings.getByRole('combobox', { name: /^Density/ }).selectOption('compact');
  await page.waitForFunction(() => document.querySelector('[data-density]')?.getAttribute('data-density') === 'compact');
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await visit('/build/projects');
  await page.waitForFunction(() => document.querySelector('[data-density]')?.getAttribute('data-density') === 'compact');
  checked('Workspace preferences, dark appearance and density persistence');

  await visit('/build/' + workspaceId);
  await page.locator('[data-studio-workspace]').waitFor();
  await page.locator('[data-studio-workspace] footer').getByRole('button', { name: /^Commands/ }).click();
  await page.getByRole('dialog').filter({ visible: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 900 });
  const views = page.getByRole('navigation', { name: 'Workspace views', exact: true });
  if (await page.getByRole('complementary', { name: 'Project explorer', exact: true }).isVisible()) {
    await views.getByRole('button', { name: 'Projects', exact: true }).click();
  }
  await views.getByRole('button', { name: 'Resources', exact: true }).click();
  assert.ok(await page.locator('[data-pane="source"]').isVisible());
  await views.getByRole('button', { name: 'Human Study Program', exact: true }).click();
  assert.ok(await page.locator('[data-pane="model"]').isVisible());
  await views.getByRole('button', { name: 'Study agent', exact: true }).click();
  assert.ok(await page.locator('[data-pane="agent"]').isVisible());
  assert.ok(report.mockedWorkspaceActions.some(request => request.method === 'PATCH'), 'The editor retains its autosave requests.');
  checked('Real editor command palette and mobile panel switching with mocked workspace data');

  await visit('/auth/reset');
  await page.getByLabel('Email', { exact: true }).fill('preview@example.test');
  await page.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'If an account matches' }).waitFor();
  assert.ok(await page.getByRole('button', { name: /^Try again in \d+s$/ }).isDisabled());
  await visit('/auth/reset?' + new URLSearchParams({ token_hash: 'a'.repeat(64), type: 'recovery' }));
  await page.getByRole('button', { name: 'Verify reset link', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose a new password.', exact: true }).waitFor();
  await page.getByLabel('New password', { exact: true }).fill('preview-only-password');
  await page.getByLabel('Confirm new password', { exact: true }).fill('mismatched-password');
  assert.ok(await page.getByRole('button', { name: 'Update password', exact: true }).isDisabled());
  await page.getByLabel('Confirm new password', { exact: true }).fill('preview-only-password');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await page.getByRole('heading', { name: 'Password updated.', exact: true }).waitFor();
  const confirmations = report.mockedAuthActions.filter(action => action === 'confirm').length;
  await visit('/auth/confirm?' + new URLSearchParams({ token_hash: 'b'.repeat(64), type: 'email' }));
  assert.equal(report.mockedAuthActions.filter(action => action === 'confirm').length, confirmations);
  await page.getByRole('button', { name: 'Confirm and continue', exact: true }).click();
  await page.waitForURL(origin + '/build/projects');
  assert.equal(report.mockedAuthActions.filter(action => action === 'confirm').length, confirmations + 1);
  checked('Mocked password recovery, cooldown, password matching and explicit email confirmation');

  let accessAccepted = false;
  await page.route(origin + '/api/access', async route => {
    assert.equal(route.request().method(), 'POST');
    return route.fulfill({ status: accessAccepted ? 200 : 401, json: accessAccepted ? { ok: true } : { error: 'invalid_code' } });
  });
  await visit('/access?next=/studies');
  await page.getByLabel('Promo code', { exact: true }).fill('preview-only-code');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('That promo code is not recognized.', { exact: true }).waitFor();
  accessAccepted = true;
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(origin + '/studies');
  checked('Mocked invitation-code failure and success with the existing library destination');

  // The browser is signed in through the existing auth fixture; history must use
  // that same fixture instead of falling through to an unconfigured live API.
  await page.context().clearCookies({ name: 'hs_unlock' });
  await page.route(origin + '/api/community/mine{,?*}', async route => {
    assert.equal(route.request().method(), 'GET');
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page') || 1);
    return route.fulfill({ json: { contributions: [], github: null, page: pageNumber, hasMore: false } });
  });
  await visit('/contribute');
  await page.getByRole('region', { name: 'My contributions', exact: true }).getByText('No submissions on this page.', { exact: true }).waitFor();
  const upload = page.getByLabel('Community contribution ZIP', { exact: true });
  await upload.setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('Preview only') });
  await page.getByRole('alert').filter({ hasText: 'Choose a community ZIP no larger than 40 MB.' }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'My contributions', exact: true }).getByRole('alert').count(), 0);
  assert.ok(await page.getByRole('button', { name: 'Contribute', exact: true }).isDisabled());
  const zip = new (require('adm-zip'))();
  zip.addFile('CONTRIBUTION.json', Buffer.from(JSON.stringify({
    paper: { title: 'Framing experiment', firstAuthor: 'Original Researcher', year: 2025 },
  })));
  zip.addFile('program.json', Buffer.from('{}'));
  zip.addFile('artifacts/simulations/example/report.md', Buffer.from('Public derived report'));
  await upload.setInputFiles({ name: 'study.zip', mimeType: 'application/zip', buffer: zip.toBuffer() });
  await page.getByText('Original paper authors: Original Researcher', { exact: false }).waitFor();
  const inventory = page.locator('summary').filter({ hasText: 'Files to publish (2)' });
  assert.equal(await inventory.evaluate(element => element.parentElement.open), false);
  await inventory.click();
  assert.ok(await page.getByText('artifacts/simulations/example/report.md', { exact: true }).isVisible());
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Preview Contributor');
  assert.ok(await page.getByRole('button', { name: 'Contribute', exact: true }).isEnabled());

  zip.addFile('sources/private/item.txt', Buffer.from('Private attachment'));
  await upload.setInputFiles({ name: 'private.zip', mimeType: 'application/zip', buffer: zip.toBuffer() });
  const privateFileAlert = page.getByRole('alert').filter({ hasText: 'private project file or raw record' });
  await privateFileAlert.waitFor();
  assert.ok(await page.getByRole('button', { name: 'Contribute', exact: true }).isDisabled());

  setSignedIn(false);
  await visit('/contribute');
  await page.getByRole('link', { name: 'Sign in to HumanStudy Hub', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Community contribution ZIP', { exact: true }).count(), 0);
  checked('Community submission and history use Hub sign-in without a promo cookie');
  await page.context().addCookies([{ name: 'hs_unlock', value: cookie, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  workspace.title = model.title;
  workspace.document.title = model.title;
  projects[0].title = model.title;
  await page.evaluate(() => {
    localStorage.removeItem('humanstudy-preferences-v1');
    localStorage.removeItem('build-study-theme');
  });
  await checkResponsivePages();
  await checkUnavailablePages();
  setSignedIn(false);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await visit('/build/projects');
    await page.getByRole('heading', { name: /Your study,/ }).waitFor();
    assert.ok(await page.getByLabel('Email', { exact: true }).isVisible());
    assert.ok(await page.getByLabel('Password', { exact: true }).isVisible());
    await checkLayout('/build/projects (signed out)', width, 'workspace-signin');
  }
  await page.context().clearCookies({ name: 'hs_unlock' });
}
