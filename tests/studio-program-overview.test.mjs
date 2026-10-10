import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const require=createRequire(import.meta.url),ts=require('typescript');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
function load(file,deps={}){
 const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};new Function('require','module','exports',js)(id=>deps[id]||((id === "./human-program" || id === "@/lib/studio/human-program") ? load("lib/studio/human-program.ts") : id === "./human-program.schema.json" ? JSON.parse(fs.readFileSync(new URL("../lib/studio/human-program.schema.json",import.meta.url),"utf8")) : require(id)),module,module.exports);return module.exports;
}
const tree=load('lib/studio/conversation-tree.ts'),resources=load('lib/studio/resources.ts');
const validation=load('lib/studio/validation.ts',{'./conversation-tree':tree,'./resources':resources});
const schema=load('app/build-preview/study-schema.ts');
const overview=load('app/build-preview/model-review.ts',{'./study-schema':schema});
const route=load('lib/studio/editor-route.ts');
const at='2026-10-06T18:00:00Z';
const model=title=>({id:'program',title,source:{title:'',authors:'',filename:''},entities:[],relations:[],procedure:[],variables:[]});
const conversation=messages=>({id:'main',title:'Main',updatedAt:at,messages,draft:'',modelAnchor:null,sourceSelection:null,selected:''});
const doc=(current,messages)=>({version:1,title:'Study',model:current,sources:[],annotations:[],reviewResponses:{},conversations:[conversation(messages)]});

test('existing version metadata rejects cycles, missing parents and unaccepted proposal snapshots',()=>{
 const document=doc(model('Current'),[]),base={id:'v1',label:'Initial',createdAt:at,fingerprint:'a'.repeat(64),model:document.model};
 assert.throws(()=>validation.validateStudioDocument({...document,programVersions:[{...base,parentId:'v1'}]}),/parent/);
 assert.throws(()=>validation.validateStudioDocument({...document,programVersions:[{...base,parentId:'missing'}]}),/parent/);
 assert.throws(()=>validation.validateStudioDocument({...document,programVersions:[{...base,model:undefined,proposalId:'pending'}]}),/accepted proposal/);
});
test('the program overview covers the full scientific arc and routes every example entity exactly once',()=>{
 const view=overview.modelOverview(schema.study),nodes=view.stages.flatMap(stage=>stage.nodes);
 assert.equal(nodes.length,schema.study.entities.length);assert.equal(new Set(nodes).size,nodes.length);
 assert.deepEqual(view.stages.map(s=>s.id),['rationale','prepare','run','record','analyze','results']);
 assert.ok(view.stages[0].nodes.includes('confidence-prediction'));
 assert.ok(view.stages.at(-1).nodes.includes('reported-results'));
 const other={...schema.study,id:'other'};
 assert.equal(overview.modelOverview(other).stages.flatMap(s=>s.nodes).length,other.entities.length);
 assert.equal(route.isStudioEditorRoute('/build/example'),true);assert.equal(route.isStudioEditorRoute('/build/abc'),true);
 assert.equal(route.isStudioEditorRoute('/build'),true);assert.equal(route.isStudioEditorRoute('/dataset'),false);
});
