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
 const module={exports:{}};new Function('require','module','exports',js)(id=>deps[id]||require(id),module,module.exports);return module.exports;
}
const semantic=load('lib/studio/model-version.ts');
const versions=load('lib/studio/program-versions.ts',{'./model-version':semantic});
const changes=load('lib/studio/model-diff.ts');
const history=load('lib/studio/program-history.ts',{'./model-diff':changes});
const tree=load('lib/studio/conversation-tree.ts'),resources=load('lib/studio/resources.ts');
const validation=load('lib/studio/validation.ts',{'./conversation-tree':tree,'./resources':resources});
const schema=load('app/build-preview/study-schema.ts');
const overview=load('app/build-preview/model-review.ts',{'./study-schema':schema});
const route=load('lib/studio/editor-route.ts');
const at='2026-10-06T18:00:00Z';
const model=title=>({id:'program',title,source:{title:'',authors:'',filename:''},entities:[],relations:[],procedure:[],variables:[]});
const conversation=messages=>({id:'main',title:'Main',updatedAt:at,messages,draft:'',modelAnchor:null,sourceSelection:null,selected:''});
const message=(id,next,status='pending',base)=>({id,role:'agent',text:'Proposal',createdAt:at,proposal:{id,model:next,summary:`Change ${id}`,status,baseModelFingerprint:base}});
const doc=(current,messages)=>({version:1,title:'Study',model:current,sources:[],annotations:[],reviewResponses:{},conversations:[conversation(messages)]});

test('accepted changes preserve the previous baseline and reference the durable proposal snapshot',()=>{
 const initial=model('Before'),next=model('After'),document=doc(initial,[message('p1',next)]);
 const log=versions.acceptedProgramVersions(document,'p1',at);
 assert.equal(log.length,2);assert.deepEqual(log[0].model,initial);
 assert.equal(log[1].parentId,log[0].id);assert.equal(log[1].proposalId,'p1');assert.equal(log[1].model,undefined);
 const saved=validation.validateStudioDocument({...document,model:next,programVersions:log,conversations:[conversation([message('p1',next,'applied')])]});
 const nodes=history.programHistory(saved.model,saved.programVersions,saved.conversations);
 assert.deepEqual(nodes.map(n=>n.status),['accepted','current']);assert.deepEqual(nodes[1].model,next);
 const newer=model('Later');saved.conversations[0].messages.push(message('p2',newer));
 const second=versions.acceptedProgramVersions(saved,'p2',at);
 assert.equal(second.length,3);assert.equal(second[2].parentId,second[1].id);
});
test('pending and rejected proposals remain branches from their recorded base, rather than becoming accepted versions',()=>{
 const before=model('Before'),after=model('After'),pending=model('Pending'),rejected=model('Rejected');
 const v1={id:'v1',label:'Baseline',createdAt:at,fingerprint:semantic.modelFingerprint(before),model:before};
 const v2={id:'v2',parentId:'v1',label:'Accepted',createdAt:at,fingerprint:semantic.modelFingerprint(after),proposalId:'a'};
 const messages=[message('a',after,'applied',v1.fingerprint),message('p',pending,'pending',v1.fingerprint),message('r',rejected,'rejected',v1.fingerprint)];
 const nodes=history.programHistory(after,[v1,v2],[conversation(messages)]);
 assert.equal(nodes.find(n=>n.id==='v2').status,'current');
 for(const id of ['p','r'])assert.equal(nodes.find(n=>n.proposalId===id).parentId,'v1');
 assert.equal(nodes.find(n=>n.proposalId==='p').status,'pending');assert.equal(nodes.find(n=>n.proposalId==='r').status,'rejected');
});
test('legacy missing parents are explicitly unavailable and the example never fabricates a revision history',()=>{
 const current=model('Current');assert.equal(history.programHistory(current,[],[]).length,1);
 const nodes=history.programHistory(current,[],[conversation([message('p',model('Proposal'),'pending','a'.repeat(64))])]);
 const earlier=nodes.find(n=>n.status==='earlier');assert.equal(earlier.model,undefined);
 assert.equal(nodes.find(n=>n.proposalId==='p').parentId,earlier.id);
});
test('version lineage rejects cycles, missing parents and unaccepted proposal snapshots',()=>{
 const document=doc(model('Current'),[]),base={id:'v1',label:'Initial',createdAt:at,fingerprint:'a'.repeat(64),model:document.model};
 assert.throws(()=>validation.validateStudioDocument({...document,programVersions:[{...base,parentId:'v1'}]}),/parent/);
 assert.throws(()=>validation.validateStudioDocument({...document,programVersions:[{...base,parentId:'missing'}]}),/parent/);
 assert.throws(()=>validation.validateStudioDocument({...document,programVersions:[{...base,model:undefined,proposalId:'pending'}]}),/accepted proposal/);
});
test('material-only or scientifically unchanged proposals do not create fake program versions',()=>{
 const current=model('Current'),document=doc(current,[message('p',current)]);
 assert.deepEqual(versions.acceptedProgramVersions(document,'p',at),[]);
 document.conversations[0].messages[0].proposal={...document.conversations[0].messages[0].proposal,model:model('Unused'),changesModel:false};
 assert.deepEqual(versions.acceptedProgramVersions(document,'p',at),[]);
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
 assert.equal(route.isStudioEditorRoute('/build'),false);assert.equal(route.isStudioEditorRoute('/dataset'),false);
});
