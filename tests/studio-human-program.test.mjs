import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(file,deps={}){const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};new Function('require','module','exports',js)(id=>deps[id]??require(id),m,m.exports);return m.exports;}
const contract=JSON.parse(fs.readFileSync(new URL('../lib/studio/human-program.schema.json',import.meta.url),'utf8'));
const program=load('lib/studio/human-program.ts',{'./human-program.schema.json':contract});
const tree=load('lib/studio/conversation-tree.ts'),resources=load('lib/studio/resources.ts');
const validation=load('lib/studio/validation.ts',{'./human-program':program,'./conversation-tree':tree,'./resources':resources});
const schema=load('app/build-preview/study-schema.ts'),review=load('app/build-preview/model-review.ts',{'./study-schema':schema});
const adapter=load('lib/studio/pipeline-adapter.ts',{'./human-program':program,'./validation':validation});
const version=load('lib/studio/model-version.ts'),diff=load('lib/studio/model-diff.ts');
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/human-program-v2.json',import.meta.url),'utf8'));
const sample=id=>structuredClone(fixtures.cases.find(c=>c.id===id).program);
for(const c of fixtures.cases)test(`${c.id}: complete typed data survives validation, projection, storage and export shape`,()=>{
 const model=validation.validateStudyModel(c.program);
 assert.deepEqual(model.program,c.program);
 const roundtrip=validation.validateStudyModel(JSON.parse(JSON.stringify(model)));
 assert.deepEqual(roundtrip.program,c.program);
 assert.equal(review.modelOverview(model).stages.flatMap(s=>s.nodes).length,model.entities.length);
 const doc={version:1,title:c.program.title,model,sources:[],annotations:[],conversations:[],reviewResponses:{}};
 assert.deepEqual(validation.validateStudioDocument(doc).model.program,c.program);
});
test('sequential interaction retains visibility; repeat children are not flattened or made into independent actors',()=>{
 const trust=sample('study_012'),game=sample('study_009');
 assert.deepEqual(program.validateHumanProgram(trust).steps[1].visibleIds,['transfer']);
 assert.deepEqual(program.validateHumanProgram(game).steps[0].children,['guess']);
 const model=validation.validateStudyModel(trust);
 const a=review.modelOverview(model,'exp-1').stages.flatMap(s=>s.nodes);
 assert(a.includes('flow:send-0'));assert(!a.includes('flow:send-1'));
});
test('dangling references, duplicate fields, cross-study flows and containment cycles fail before display',()=>{
 const p=sample('study_009');p.steps[0].actorIds=['ghost'];assert.throws(()=>program.validateHumanProgram(p),/unknown reference/);
 const q=sample('study_009');q.steps[1].children=['rounds'];assert.throws(()=>program.validateHumanProgram(q),/containment cycle/);
 const r=sample('study_012');r.steps[0].next=[{to:'send-1'}];assert.throws(()=>program.validateHumanProgram(r),/cross-study/);
 const f=sample('exploratory-extension');f.nodes[0].fields.push({...f.nodes[0].fields[0]});assert.throws(()=>program.validateHumanProgram(f),/duplicate/);
});
test('unknown extensions remain visible; missing hypotheses and future observations are not fabricated questions',()=>{
 const p=sample('exploratory-extension'),model=validation.validateStudyModel(p);
 assert.deepEqual(model.program.nodes[0].extensions,{codingRules:{multipleCodes:true}});
 assert.deepEqual(review.modelIssues(model),[]);
 assert.throws(()=>program.validateHumanProgram({...p,schemaVersion:3}),/unsupported schema version/);
 p.nodes[0].fields[0].origin='derived';assert.throws(()=>program.validateHumanProgram(p),/derivation/);
});
test('field context remains anchored by stable ID; historical context survives field removal',()=>{
 const m=validation.validateStudyModel(sample('exploratory-extension'));
 const anchor={kind:'objects',entityIds:['coding'],fieldId:'categories'};
 assert.deepEqual(validation.validateModelAnchor(anchor,m),anchor);
 assert.throws(()=>validation.validateModelAnchor({...anchor,fieldId:'missing'},m),/missing field/);
 assert.equal(validation.validateModelAnchor({...anchor,fieldId:'missing'},m,{historical:true}).fieldId,'missing');
});
test('canonical package wins over stale projections; conflicting mirrors fail instead of dropping data',()=>{
 const p=sample('study_005'),doc={sources:[],title:'Study'};
 const file=(path,value)=>({path:`paper/${path}`,content:JSON.stringify(value)});
 const adapted=adapter.adaptPipelinePackage([file('study.json',{program:p}),file('studio-model.json',p)],doc);
 assert.deepEqual(adapted.model.program,p);
 assert.match(adapted.summary,/Canonical/);
 const conflict=structuredClone(p);conflict.title='Different';
 assert.throws(()=>adapter.adaptPipelinePackage([file('study.json',{program:p}),file('studio-model.json',conflict)],doc),/disagree/);
 const wrapper=validation.validateStudyModel(p);wrapper.entities[0].title='Wrong projection';assert.notEqual(validation.validateStudyModel(wrapper).entities[0].title,'Wrong projection');
});
test('unverified quote cannot fabricate source highlighting; server grounding verifies actual attached page text',()=>{
 const p=sample('exploratory-extension');p.evidence=[{id:'e1',sourceId:'paper',locator:{page:1},quote:'Fabricated quote',verification:'verified'}];p.nodes[0].evidenceIds=['e1'];
 const doc={sources:[{id:'paper',pages:[{page:1,text:'Real passage'}]}],title:'Study'};
 const m=adapter.groundStudioModelEvidence(validation.validateStudyModel(p),doc);
 assert.equal(m.entities[0].evidence.quote,'');assert.equal(m.program.evidence[0].quote,'Fabricated quote');assert.equal(m.program.evidence[0].verification,'unverified');
 p.evidence[0].quote='Real passage';assert.equal(adapter.groundStudioModelEvidence(validation.validateStudyModel(p),doc).entities[0].evidence.quote,'Real passage');
});
test('typed changes beyond a card preview invalidate packages and appear in proposal comparison',()=>{
 const p=sample('exploratory-extension'),a=validation.validateStudyModel(p);p.nodes[0].extensions.codingRules.multipleCodes=false;
 const b=validation.validateStudyModel(p);
 assert.notEqual(version.modelFingerprint(a),version.modelFingerprint(b));assert(diff.modelChanges(a,b).hasChanges);
});

test('unresolved rules have explicit questions; source gaps do not silently vanish',()=>{
 const p=sample('study_009');p.steps[0].rule.state='missing';
 assert.throws(()=>program.validateHumanProgram(p),/requires a review issue/);
 p.issues=[{id:'round-rule',title:'Define repetition',severity:'blocking',reason:'Stopping rule is absent',impact:'Cannot run faithfully',suggestedAction:'Researcher supplies rule',stepId:'rounds',evidenceIds:[]}];
 const m=validation.validateStudyModel(p);assert.equal(review.modelIssues(m).length,1);assert.equal(review.modelIssues(m)[0].severity,'blocking');
});
test('projection truncation never truncates the canonical value or exported data',()=>{
 const p=sample('exploratory-extension');p.nodes[0].fields[0].value='x'.repeat(10000);
 const m=validation.validateStudyModel(p);assert.equal(m.entities[0].fields[0].value.length,4000);assert.equal(m.program.nodes[0].fields[0].value.length,10000);
 assert.equal(validation.validateStudyModel(JSON.parse(JSON.stringify(m))).program.nodes[0].fields[0].value.length,10000);
});

test('action overview exposes the rule or input/output context without changing the canonical flow',()=>{
 const p=sample('study_012'),step=p.steps.find(s=>s.kind==='action');
 step.rule={id:'rule',label:'Procedure',value:'Measure sustained attention at baseline and after the intervention. '.repeat(10),origin:'reported',state:'confirmed',evidenceIds:[]};
 const before=structuredClone(p),m=validation.validateStudyModel(p),id=`flow:${step.id}`;
 assert.match(review.modelOverview(m).cards[id].text,/Measure sustained attention/);
 assert.equal([...m.entities.find(e=>e.id===id).subtitle].length,240);
 assert.deepEqual(m.program,before);
 delete step.rule;
 const fallback=validation.validateStudyModel(p).entities.find(e=>e.id===id).subtitle;
 assert(fallback.includes(p.nodes.find(n=>n.id===step.actorIds[0]).title));
 assert.deepEqual(validation.validateStudyModel(p).program,p);
});

test('canonical Unicode, long verified evidence and typed variable metadata fit the preview without data loss',()=>{
 const p=sample('exploratory-extension');p.title='🧪'.repeat(300);p.nodes[0].title='🧪'.repeat(200);
 p.evidence=[{id:'long-quote',sourceId:'paper',locator:{page:1},quote:'🧪'.repeat(9000),verification:'verified'}];p.nodes[0].evidenceIds=['long-quote'];
 p.nodes.push({id:'measure',kind:'variable',title:'Measure',studyIds:[],evidenceIds:[],fields:[{id:'role',label:'Role',value:{detail:'x'.repeat(6000)},origin:'researcher',state:'confirmed',evidenceIds:[]}]});
 const m=validation.validateStudyModel(p);assert.equal([...m.entities[0].evidence.quote].length,8000);assert.equal(m.program.evidence[0].quote,p.evidence[0].quote);
 assert.equal(m.variables[0].role.length,500);assert.deepEqual(m.program.nodes[1].fields,p.nodes[1].fields);
 p.steps[0]={id:'s'.repeat(96),studyId:p.studies[0].id,kind:'action',title:'Do',actorIds:[],inputIds:[],outputIds:[],visibleIds:[],children:[],next:[],evidenceIds:[]};
 assert.throws(()=>program.validateHumanProgram(p),/invalid string/);
});
test('legacy import retains source references and page regions without undefined JSON properties',()=>{
 const m=structuredClone(schema.study);m.entities[0].evidence={sourceId:'paper',page:1,quote:'Original',rects:Array.from({length:64},()=>({x:1,y:1,w:10,h:2}))};
 const p=program.importLegacyModel(m),e=p.evidence.find(e=>e.sourceId==='paper');
 assert.equal(e.quote,'Original');assert.deepEqual(JSON.parse(e.locator.region),m.entities[0].evidence.rects);
 assert.equal(p.extensions.scopeUnresolved,true);
});
