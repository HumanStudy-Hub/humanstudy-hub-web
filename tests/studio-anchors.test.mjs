import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(file,dependencies={}){
 const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const loadedModule={exports:{}};
 new Function('require','module','exports',js)(id=>dependencies[id]||((id === "./human-program" || id === "@/lib/studio/human-program") ? load("lib/studio/human-program.ts") : id === "./human-program.schema.json" ? JSON.parse(fs.readFileSync(new URL("../lib/studio/human-program.schema.json",import.meta.url),"utf8")) : require(id)),loadedModule,loadedModule.exports);
 return loadedModule.exports;
}
const {quoteRects,sourceRect}=load('lib/studio/source-anchor.ts');
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


test('PDF highlights keep the same page coordinates after zoom and horizontal scrolling',()=>{
 const fit=sourceRect({left:20,top:40,width:400,height:600},{left:60,top:160,width:80,height:30});
 const zoom=sourceRect({left:-120,top:-80,width:800,height:1200},{left:-40,top:160,width:160,height:60});
 assert.deepEqual(fit,{x:10,y:20,w:20,h:5});
 assert.deepEqual(zoom,fit);
});
test('PDF selection clips to page boundaries so saved marks always validate',()=>{
 assert.deepEqual(sourceRect({left:0,top:0,width:100,height:100},{left:90,top:95,width:30,height:10}),{x:90,y:95,w:10,h:5});
 assert.equal(sourceRect({left:0,top:0,width:100,height:100},{left:110,top:95,width:30,height:10}),null);
});
