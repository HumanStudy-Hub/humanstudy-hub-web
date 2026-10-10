import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync(new URL('../lib/studio/program-views.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const m={exports:{}};new Function('require','module','exports',code)(require,m,m.exports);
const {programGraph,branchChoices,branchPaths,programView}=m.exports;
const mobile=JSON.parse(fs.readFileSync(new URL('../components/studio/design-cases/mobile-internet.json',import.meta.url),'utf8'));
const trust=JSON.parse(fs.readFileSync(new URL('../components/studio/design-cases/study_012.json',import.meta.url),'utf8'));

test('real longitudinal flow splits and reconverges using explicit steps without altering the model',()=>{
 const before=JSON.stringify(mobile),graph=programGraph(mobile);
 assert.equal(graph.steps.length+graph.wrappers.length,mobile.steps.length);
 assert.equal(graph.wrappers[0].kind,'sequence');
 const positions=new Map(graph.positions.map(p=>[p.id,p]));
 assert.equal(positions.get('step_phase1_intervention_block').y,positions.get('step_phase1_delayed_normal').y);
 assert(positions.get('step_t2_survey').y>positions.get('step_phase1_sms_loop').y);
 assert(graph.links.some(e=>e.from==='step_phase1_intervention_block'&&e.to==='step_phase1_sms_loop'));
 assert(graph.links.some(e=>e.from==='step_phase1_delayed_normal'&&e.to==='step_phase1_sms_loop'));
 assert.equal(new Set(graph.positions.map(p=>`${p.x}:${p.y}`)).size,graph.steps.length);
 assert.equal(JSON.stringify(mobile),before);
});
test('condition comparison shows the two distinct interventions and only one common continuation',()=>{
 const result=branchPaths(mobile,'step_phase1_branch');
 assert.equal(result.paths.length,2);
 assert.deepEqual([...result.paths[0].unique],['step_phase1_intervention_block']);
 assert.deepEqual([...result.paths[1].unique],['step_phase1_delayed_normal']);
 assert(result.shared.has('step_phase1_sms_loop'));assert(result.shared.has('step_t3_survey'));
 assert(result.before.has('step_randomize'));assert(result.before.has('step_t1_baseline'));
 assert(!result.shared.has('step_randomize'));
});
test('shared or overlapping titles do not fabricate conditions or connect unrelated studies',()=>{
 const p=structuredClone(trust);p.steps.forEach(s=>s.title='Control condition');
 assert.equal(branchChoices(p).length,0);
 const graph=programGraph(p,p.studies[0].id);
 assert(graph.steps.every(s=>s.studyId===p.studies[0].id));
 assert(graph.links.every(e=>graph.steps.some(s=>s.id===e.from)&&graph.steps.some(s=>s.id===e.to)));
});
test('feedback loops remain finite and do not merge both alternatives through revisiting the decision',()=>{
 const p=structuredClone(mobile);
 p.steps.find(s=>s.id==='step_t3_survey').next=[{to:'step_phase1_branch',when:'repeat if required'}];
 const graph=programGraph(p);
 assert(graph.height<2000);assert.equal(graph.positions.length,graph.steps.length);
 const result=branchPaths(p,'step_phase1_branch');
 assert(result.paths[0].unique.has('step_phase1_intervention_block'));
 assert(result.paths[1].unique.has('step_phase1_delayed_normal'));
 assert(!result.shared.has('step_phase1_branch'));
 assert(!result.before.has('step_t3_survey'));
});
test('unmapped, repeated and parallel protocols retain their distinction',()=>{
 const p=structuredClone(mobile);p.steps=[];
 assert.equal(programGraph(p).steps.length,0);
 p.steps=[{...mobile.steps[2],kind:'parallel'},...mobile.steps.slice(3,5)];
 assert.equal(branchChoices(p).length,0);assert(programGraph(p).links.some(e=>e.kind==='contains'));
 assert.equal(programView('compare'),'compare');assert.equal(programView('unknown'),'flow');
});
