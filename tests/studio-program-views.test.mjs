import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(file,deps={}){const js=ts.transpileModule(fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;const m={exports:{}};new Function('require','module','exports',js)(name=>deps[name]??require(name),m,m.exports);return m.exports;}
const contract=JSON.parse(fs.readFileSync(new URL('../lib/studio/human-program.schema.json',import.meta.url),'utf8'));
const hp=load('lib/studio/human-program.ts',{'./human-program.schema.json':contract});
const pv=load('lib/studio/program-view.ts',{'./human-program':hp});
const css={default:new Proxy({},{get:(_,key)=>String(key)})};
const views=load('components/studio/program-views.tsx',{'@/lib/studio/human-program':hp,'@/lib/studio/program-view':pv,'./program-views.module.css':css}).default;
const knobe=()=>JSON.parse(fs.readFileSync(new URL('../data/studio-samples/intentional-action/program.json',import.meta.url),'utf8'));
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/human-program-v2.json',import.meta.url),'utf8'));
const sample=id=>structuredClone(fixtures.cases.find(c=>c.id===id).program);
const noop=()=>{};
const render=(program,view,studyId)=>renderToStaticMarkup(React.createElement(views,{program,view,studyId,selectedIds:[],issuesFor:()=>[],onPick:noop,onIssue:noop}));

test('the sample program with its presentation extension still validates',()=>{assert.doesNotThrow(()=>hp.validateHumanProgram(knobe()));});

test('agent-declared conditions win, and inference recovers the same arms without them',()=>{
 const p=knobe(),declared=pv.conditionArms(p,'exp-1');
 assert.deepEqual(declared.map(a=>[a.label,a.source,a.nodeIds]),[['Harm','agent',['material-1-harm']],['Help','agent',['material-1-help']]]);
 delete p.extensions.presentation;
 assert.deepEqual(pv.conditionArms(p,'exp-1').map(a=>[a.label,a.source,a.nodeIds]),[['harm','design',['material-1-harm']],['help','design',['material-1-help']]]);
});

test('flow forks at assignment and splits condition materials into lanes',()=>{
 const flow=pv.studyFlow(knobe(),'exp-1');
 assert.deepEqual(flow.map(f=>f.step.id),['exp-1-assign','exp-1-read','exp-1-answer']);
 assert.equal(flow[0].splits,true);
 assert.deepEqual(flow[1].lanes.map(l=>[l.arm.id,l.nodeIds]),[['harm',['material-1-harm']],['help',['material-1-help']]]);
});

test('repeat containers nest and two actors become swimlanes',()=>{
 const game=sample('study_009'),flow=pv.studyFlow(game,'exp-1');
 assert.equal(flow.length,1);assert.equal(flow[0].children[0].step.id,'guess');
 const trust=sample('study_012');
 assert.deepEqual(pv.flowActors(trust,pv.studyFlow(trust,'exp-1')).map(a=>a.id),['sender','receiver']);
});

test('screens use only verbatim fields and keep the unresolved question order visible',()=>{
 const p=knobe(),[harm,help]=pv.conditionArms(p,'exp-1');
 const screens=pv.studyScreens(p,'exp-1',help),answer=screens.find(s=>s.step.id==='exp-1-answer');
 assert.equal(screens.find(s=>s.step.id==='exp-1-read').blocks[0].text.includes('help the environment'),true);
 assert.deepEqual(answer.blocks.filter(b=>b.type==='question').map(b=>b.scale),[false,true]);
 assert.ok(answer.blocks.some(b=>b.type==='gap'&&b.issueId==='exp-1-question-order'));
 assert.ok(!JSON.stringify(pv.studyScreens(p,'exp-1',harm)).includes('help the environment'));
});

test('compare collapses identical rows and marks only the differing words',()=>{
 const p=knobe(),rows=pv.compareRows(p,pv.conditionArms(p,'exp-1'));
 assert.ok(rows.filter(r=>r.group==='Procedure').every(r=>r.same));
 const q=rows.find(r=>r.label==='Questions 1');assert.equal(q.same,false);
 assert.deepEqual(pv.wordDiff(q.cells[0].text,q.cells[1].text).filter(d=>d.changed).map(d=>d.text.trim()),['harm']);
});

test('every view renders the fixture programs without throwing',()=>{
 for(const [program,study] of [[knobe(),'exp-1'],[sample('study_012'),'exp-1'],[sample('study_009'),'exp-1'],[sample('study_015'),'exp-1']])for(const view of ['flow','compare','screens'])assert.doesNotThrow(()=>render(program,view,study));
 assert.match(render(knobe(),'flow','exp-1'),/splits into/);
 assert.match(render(sample('study_012'),'compare','exp-1'),/No History Treatment/);
});
