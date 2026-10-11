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
const Doc=load('components/studio/program-document.tsx',{'@/lib/studio/human-program':hp,'@/lib/studio/program-view':pv,'./program-document.module.css':css}).default;
const mobile=()=>JSON.parse(fs.readFileSync(new URL('../components/studio/design-cases/mobile-internet.json',import.meta.url),'utf8'));
const knobe=()=>JSON.parse(fs.readFileSync(new URL('../data/studio-samples/intentional-action/program.json',import.meta.url),'utf8'));
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/human-program-v2.json',import.meta.url),'utf8'));
const sample=id=>structuredClone(fixtures.cases.find(c=>c.id===id).program);
const noop=()=>{};
const render=(program,studyId,extra={})=>renderToStaticMarkup(React.createElement(Doc,{program,studyId,selectedIds:[],issuesFor:()=>[],onPick:noop,onIssue:noop,onSource:noop,onAsk:noop,...extra}));
const count=(html,pattern)=>(html.match(pattern)||[]).length;
/** The real crossover output with its two conditions stated explicitly across both phases. */
const stated=()=>{
 const p=mobile();
 p.nodes.push({id:'cond-intervention',kind:'condition',title:'Intervention',studyIds:['study1_rct'],fields:[],evidenceIds:[]},{id:'cond-delayed',kind:'condition',title:'Delayed intervention',studyIds:['study1_rct'],fields:[],evidenceIds:[]});
 for(const [id,c] of [['step_phase1_intervention_block','cond-intervention'],['step_phase2_intervention_release','cond-intervention'],['step_phase1_delayed_normal','cond-delayed'],['step_phase2_delayed_block','cond-delayed']])p.steps.find(s=>s.id===id).conditionIds=[c];
 return hp.validateHumanProgram(p);
};

test('the sample states its conditions as condition nodes and still validates',()=>{
 const p=hp.validateHumanProgram(knobe());
 assert.deepEqual(pv.studyConditions(p,'exp-1').map(c=>[c.label,c.nodeIds]),[['Harm',['material-1-harm']],['Help',['material-1-help']]]);
});

test('conditionIds must name condition nodes of the same study',()=>{
 const p=knobe();p.nodes.find(n=>n.id==='material-1-harm').conditionIds=['design'];
 assert.throws(()=>hp.validateHumanProgram(p),/is not a condition/);
 const q=stated();q.nodes.find(n=>n.id==='cond-delayed').studyIds=[];q.studies.push({id:'other',title:'Other',type:'empirical'});q.nodes.find(n=>n.id==='cond-delayed').studyIds=['other'];
 assert.throws(()=>hp.validateHumanProgram(q),/belongs to another study/);
});

test('repro 1: steps without next edges are not joined by arrows',()=>{
 const p=knobe();p.steps.forEach(s=>s.next=[]);hp.validateHumanProgram(p);
 const html=render(p,'exp-1');
 assert.equal(count(html,/aria-label="then"/g),0);
 assert.equal(count(html,/aria-label="order not stated"/g),2);
 assert.equal(count(render(knobe(),'exp-1'),/aria-label="then"/g),2);
});

test('repro 2: stated conditions keep their own paths across phases',()=>{
 const p=stated(),[intervention,delayed]=pv.studyConditions(p,'study1_rct');
 assert.deepEqual(intervention.stepIds,['step_phase1_intervention_block','step_phase2_intervention_release']);
 assert.deepEqual(delayed.stepIds,['step_phase1_delayed_normal','step_phase2_delayed_block']);
 assert.equal(pv.conditionSuggestion(p,'study1_rct'),null);
 // A presentation plan cannot change these relations.
 p.extensions={...p.extensions,presentation:{open:['step_t2_survey','unknown'],conditions:[{id:'x'}]}};
 assert.deepEqual(pv.presentationPlan(p),{open:['step_t2_survey'],collapsed:[]});
 assert.deepEqual(pv.studyConditions(p,'study1_rct').map(c=>c.stepIds),[intervention.stepIds,delayed.stepIds]);
});

test('repro 3: branches of uneven length stay aligned on the shared continuation',()=>{
 const p=mobile(),alt=p.steps.find(s=>s.id==='step_phase1_intervention_block');
 alt.kind='sequence';alt.children=['extra-check'];
 p.steps.push({...structuredClone(alt),id:'extra-check',kind:'action',title:'Additional intervention check',children:[],next:[]});hp.validateHumanProgram(p);
 const timeline=pv.studyFlow(p,'study1_rct')[0].children;
 const ids=timeline.map(i=>i.step.id);
 assert.equal(ids.filter(id=>id==='step_t2_survey').length,1);
 const branch=timeline.find(i=>i.step.id==='step_phase1_branch');
 assert.equal(branch.columns,true);
 assert.deepEqual(branch.children.map(c=>c.step.id),['step_phase1_intervention_block','step_phase1_delayed_normal']);
 assert.equal(branch.children[0].children[0].step.id,'extra-check');
 assert.equal(timeline[ids.indexOf('step_phase1_sms_loop')].linked,true);
});

test('repro 4: content says where it comes from, and inputs are not shown as what participants see',()=>{
 const p=knobe();p.nodes.find(n=>n.id==='material-1-help').fields.find(f=>f.id==='questions').origin='implementation';hp.validateHumanProgram(p);
 const html=render(p,'exp-1');
 assert.doesNotMatch(html,/verbatim/i);
 assert.match(html,/implementation choice/);
 const read=render(knobe(),'exp-1');
 assert.match(read,/Uses <span[^>]*><button[^>]*>Side-effect condition/);
 assert.doesNotMatch(read,/participants see[^<]*<\/p>[^]*?Side-effect condition<\/button>[^]*?Uses/i);
});

test('without stated conditions the view only suggests them, and draws no condition colours',()=>{
 const p=mobile();
 assert.deepEqual(pv.conditionSuggestion(p,'study1_rct').labels,['Intervention arm','Delayed Intervention arm']);
 const html=render(p,'study1_rct');
 assert.match(html,/Conditions are not stated/);assert.match(html,/Ask the agent to confirm/);
 assert.equal(count(html,/data-tone=/g),0);
 const colored=render(stated(),'study1_rct');
 assert.match(colored,/data-tone="0"/);assert.match(colored,/data-tone="1"/);
});

test('an opened step compares condition materials in place, marking only the differing words',()=>{
 const html=render(knobe(),'exp-1');
 assert.match(html,/<mark>harm<\/mark>/);assert.match(html,/<mark>help<\/mark>/);
 assert.doesNotMatch(html,/<mark>chairman/);
 assert.deepEqual(pv.wordDiff('Did he harm it?','Did he help it?').filter(d=>d.changed).map(d=>d.text),['harm']);
});

test('every item links to its source; items without one say so',()=>{
 const p=mobile(),html=render(p,'study1_rct');
 assert.equal(pv.itemSources(p,'flow:step_randomize')[0].page,pv.sourceRefs(p,['ev_sample_size_randomization'])[0].page);
 assert.match(html,/\[p\. \d+\]/);
 const k=render(knobe(),'exp-1');assert.match(k,/\[no source\]/);assert.match(k,/\[file\]/);
});

test('a selected passage finds the items that cite it, and only on its page',()=>{
 const p=mobile(),e=p.evidence.find(e=>e.id==='ev_sample_size_randomization');
 const ids=pv.supportedBy(p,{sourceId:e.sourceId,page:e.locator.page,text:e.quote});
 assert.ok(ids.includes('flow:step_randomize'));
 assert.deepEqual(pv.supportedBy(p,{sourceId:e.sourceId,page:e.locator.page+40,text:e.quote}),[]);
 assert.deepEqual(pv.supportedBy(p,{sourceId:e.sourceId,page:e.locator.page,text:'participants were asked to'}),[]);
 const html=render(p,'study1_rct',{highlightIds:new Set(ids)});
 assert.match(html,/data-model-id="flow:step_randomize"[^>]*/);assert.match(html,/cited/);
});

test('loops back and joins further on are written out, never drawn as the next arrow',()=>{
 const p=mobile();p.steps.find(s=>s.id==='step_t3_survey').next=[{to:'step_phase1_branch',when:'if required'}];hp.validateHumanProgram(p);
 const t3=pv.flatFlow(pv.studyFlow(p,'study1_rct')).find(i=>i.step.id==='step_t3_survey');
 assert.deepEqual(t3.jumps.map(j=>[j.to,j.back]),[['step_phase1_branch',true]]);
});

test('the document adapts to the structure (branches, repeats) and every fixture renders',()=>{
 for(const [p,st] of [[sample('study_012'),'exp-1'],[sample('study_009'),'exp-1'],[sample('study_015'),'exp-1'],[stated(),'study1_rct']])assert.doesNotThrow(()=>render(p,st));
 assert.match(render(sample('study_009'),'exp-1'),/Repeated/);
 assert.match(render(stated(),'study1_rct'),/Depending on condition/);
});

test('generated views: a streamed reply splits into its note and artifact, even while incomplete',()=>{
 const views=load('lib/studio/views.ts');
 assert.deepEqual(views.parseView('Here is the flow. <artifact title="Flow"><html><body>'),{note:'Here is the flow.',title:'Flow',html:'<html><body>',done:false});
 assert.equal(views.parseView('Done.<artifact title="F">```html\n<p>x</p>\n```</artifact>').html,'<p>x</p>');
 assert.equal(views.parseView('Thinking').html,'');
 const ctx=JSON.parse(views.programContext(knobe(),'exp-1'));
 assert.ok(ctx.steps.every(s=>s.studyId==='exp-1'));
 assert.equal(views.viewTemplates.length,3);
});
