import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(file,dependencies={}){
 const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const loadedModule={exports:{}};
 new Function('require','module','exports',js)(id=>dependencies[id]||require(id),loadedModule,loadedModule.exports);
 return loadedModule.exports;
}
const {quoteRects}=load('lib/studio/source-anchor.ts');
const schema=load('app/build-preview/study-schema.ts');
const {modelOverview,modelIssues}=load('app/build-preview/model-review.ts',{'./study-schema':schema});
const box=(t,x=10,y=20)=>({t,x,y,w:12,h:3});

test('source quotes use real text boxes, normalize whitespace, and merge adjacent runs',()=>{
 assert.deepEqual(quoteRects([box('Participants'),box('read',23),box('instructions.',10,26)],'Participants   read instructions.'),[{x:10,y:20,w:25,h:3},{x:10,y:26,w:12,h:3}]);
});
test('missing or ambiguous quotes never fabricate a highlight',()=>{
 assert.deepEqual(quoteRects([box('Repeated text'),box('Repeated text',10,26)],'Repeated text'),[]);
 assert.deepEqual(quoteRects([box('Observed text')],'Unreported result'),[]);
 assert.deepEqual(quoteRects([],'Some quote'),[]);
});
test('new study overview and review IDs do not depend on the anchoring fixture or field language',()=>{
 const model={...schema.study,id:'new-study',title:'Interview study',entities:[{...schema.study.entities[0],id:'research-team',kind:'participants',title:'Interview participants',fields:[{name:'报告的细节',value:'Provided',status:'reported'},{name:'Recruitment decision?',value:'Specify recruitment',status:'unresolved'}]}],relations:[],variables:[],procedure:[]};
 const overview=modelOverview(model),issues=modelIssues(model);
 assert.equal(overview.question,'Interview study');
 assert.deepEqual(overview.stages[0].nodes,['research-team']);
 assert.equal(issues[0].id,'research-team:field:1');
 assert.match(issues[0].id,/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
 assert.equal(issues[0].question,'Specify recruitment');
});
