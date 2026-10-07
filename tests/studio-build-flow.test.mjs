import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const m = { exports: {} }; new Function('require', 'module', 'exports', js)(id => deps[id] ?? require(id), m, m.exports); return m.exports;
}
const flow = load('lib/studio/build-stage.ts');
const resources = load('lib/studio/resources.ts');
const View = load('components/studio/build-start.tsx', { 'next/link': { default: props => React.createElement('a', props) }, '@/lib/studio/resources': resources, './build-start.module.css': { default: {} } }).default;
const draft = () => ({ title: 'New study', model: { entities: [] }, sources: [], conversations: [] });
test('first build progresses from intake to processing to a pending review, including after reload', () => {
  const d = draft(); assert.equal(flow.workspaceBuildStage(d), 'intake');
  d.pipeline = { jobId: 'job', status: 'queued' }; assert.equal(flow.workspaceBuildStage(d), 'processing');
  d.pipeline.status = 'failed'; assert.equal(flow.workspaceBuildStage(d), 'processing');
  d.pipeline = { ...d.pipeline, status: 'review', proposalId: 'result' };
  d.conversations = [{ messages: [{ proposal: { id: 'result', status: 'pending', model: { entities: [{ id: 'design' }] } } }] }];
  assert.equal(flow.workspaceBuildStage(JSON.parse(JSON.stringify(d))), 'editor');
  assert.equal(flow.firstBuildPreview(d), 'result'); assert.equal(d.model.entities.length, 0, 'preview does not silently accept the model');
  d.conversations[0].messages[0].proposal.status = 'rejected'; assert.equal(flow.workspaceBuildStage(d), 'editor'); assert.equal(flow.firstBuildPreview(d), undefined);
});
test('subsequent builds and failures keep the accepted study in its editor', () => {
  const d = draft(); d.model.entities = [{ id: 'design' }]; d.pipeline = { status: 'running' };
  assert.equal(flow.workspaceBuildStage(d), 'editor'); d.pipeline.status = 'failed'; assert.equal(flow.workspaceBuildStage(d), 'editor'); assert.equal(flow.firstBuildPreview(d), undefined);
});
test('processing uses real file counts and intake accepts paper plus resource uploads', () => {
  const d = draft(); d.sources = [{ id: 'paper', name: 'paper.pdf', kind: 'paper' }, { id: 'materials', name: 'survey.docx' }];
  const common = { id: 'workspace', document: d, onPaper() {}, onBuild() {}, onRetry() {}, onCheck() {}, onNavigate() {}, busy: false, resources: React.createElement('span', null, 'Upload materials') };
  const start = renderToStaticMarkup(React.createElement(View, { ...common, stage: 'intake', primaryPaper: d.sources[0] }));
  assert.match(start, /Upload materials/); assert.match(start, /Optional research question/); assert.match(start, /data-studio-workspace="workspace"/);
  const processing = renderToStaticMarkup(React.createElement(View, { ...common, stage: 'processing', job: { status: 'running', message: 'Reading source', progress: { phase: 'validating_package', completedRequired: 6, totalRequired: 8 } } }));
  assert.match(processing, /Checking the package/); assert.match(processing, /6 \/ 8 required files/); assert.match(processing, /survey.docx/); assert.match(processing, /will open when the result is ready/);
});
