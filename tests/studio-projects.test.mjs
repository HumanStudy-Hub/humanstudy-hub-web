import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const root=path.resolve(import.meta.dirname,'..');
const next={NextResponse:{json:(body,init={})=>({body,status:init.status||200})}};
function load(file,deps={}){
 const js=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const m={exports:{}};
 new Function('require','module','exports',js)(id=>{
  if(id in deps)return deps[id];if(id==='next/server')return next;
  if(id.startsWith('@/lib/'))return load(`${id.slice(2)}.ts`);
  if(id.startsWith('./')){const target=path.join(path.dirname(file),id);return id.endsWith('.json')?JSON.parse(fs.readFileSync(path.join(root,target),'utf8')):load(`${target}.ts`);}
  return require(id);
 },m,m.exports);return m.exports;
}
const copy=load('lib/studio/project-copy.ts'),validation=load('lib/studio/validation.ts'),http=load('lib/studio/http.ts');
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='cccccccc-cccc-4ccc-8ccc-cccccccccccc',sid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ctx={user:{id:owner},accessToken:'verified-user'};
const source={id:sid,name:'paper.pdf',path:`${owner}/${id}/${sid}.pdf`,mimeType:'application/pdf',kind:'paper',size:10};
const document=()=>({...copy.emptyStudy('Original'),sources:[source]});
const workspace=()=>({id,revision:2,title:'Original',document:document(),created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
function service(overrides={}){
 const records=new Map(),calls=[];let fail=false;
 const store={getWorkspace:async(_,key)=>records.get(key)||null,createWorkspace:async(_,doc,key)=>{const w={...workspace(),id:key,revision:1,title:doc.title,document:structuredClone(doc)};records.set(key,w);calls.push(['create',key]);return w;},saveWorkspace:async(_,key,doc,revision)=>{const w=records.get(key);if(w.revision!==revision)return {conflict:true,latest:w};const next={...w,revision:revision+1,document:structuredClone(doc)};records.set(key,next);calls.push(['save',key,doc.project?.copyState]);return next;},...overrides};
 const projects=load('lib/studio/projects.ts',{'./store':store,'./http':{...http,studioConfig:()=>({url:'https://storage.example.test',key:'publishable'}),studioFetch:async(endpoint,options)=>{calls.push([endpoint,options]);return fail?Response.json({error:'Denied'},{status:403}):Response.json({});}}});
 return {records,calls,store,projects,setFail:value=>{fail=value;}};
}
const request=body=>new Request('https://app.example.test/api/studio/workspaces/'+id+'/project',{method:'POST',headers:{origin:'https://app.example.test','content-type':'application/json'},body:JSON.stringify(body)});

test('fork clones scientific references and files, detaches job authority and does not mutate the source',()=>{
 const d=document();d.pipeline={jobId:'remote'};d.discussion={jobId:'remote'};d.acceptedPackage={jobId:'remote'};d.programVersions=[{}];d.project={archived:true,sampleId:'seed'};
 d.annotations=[{id:'annotation',sourceId:sid,page:1,rects:[],comment:'Keep this'}];
 d.conversations=[{id:'chat',messages:[{id:'message',proposal:{jobId:'remote',status:'pending',model:d.model}},{id:'applied',proposal:{jobId:'remote',status:'applied',model:d.model}}]}];
 const before=structuredClone(d),next=copy.forkDocument(d,owner,other,{workspaceId:id,revision:2});
 assert.deepEqual(d,before);assert.equal(next.project.forkedFrom.workspaceId,id);assert.equal(next.project.archived,undefined);
 assert.equal(next.sources[0].path,`${owner}/${other}/${sid}.pdf`);assert.equal(next.sources[0].id,sid);assert.equal(next.annotations[0].sourceId,sid);
 for(const key of ['pipeline','discussion','acceptedPackage','programVersions'])assert.equal(next[key],undefined);
 assert.equal(next.conversations[0].messages[0].proposal.status,'rejected');assert.equal(next.conversations[0].messages[1].proposal.status,'applied');
 assert.equal(next.conversations[0].messages[0].proposal.jobId,undefined);
 next.model.title='Independent';assert.notEqual(d.model.title,next.model.title);
 assert.throws(()=>copy.sourceCopyPairs([{...source,size:11}],next.sources),/Source changed/);
});

test('load sample provisions a normal validated project before five private uploads',async()=>{
 const s=service(),prior=global.fetch;global.fetch=async(url,options)=>{assert.ok(s.records.size);assert.match(url,/storage\/v1\/object\/studio-sources\//);assert.equal(options.headers.Authorization,'Bearer verified-user');assert.ok(options.body.size>0);s.calls.push(['upload']);return Response.json({});};
 try{const w=await s.projects.loadSample(ctx);assert.equal(w.document.project.sampleId,'intentional-action');assert.equal(w.document.project.copyState,'ready');assert.equal(w.document.sources.length,5);assert.equal(w.document.artifacts.length,4);assert.equal(w.document.model.program.schemaVersion,2);assert.ok(w.document.model.program.studies.length>=2);assert.equal(w.document.model.program.steps.length,6);assert.ok(w.document.model.program.issues.length);for(const e of w.document.model.program.evidence)assert.ok(w.document.sources.some(source=>source.id===e.sourceId));assert.ok(w.document.model.program.nodes.length);assert.equal(w.document.pipeline,undefined);assert.equal(s.calls.filter(c=>c[0]==='upload').length,5);assert.deepEqual(validation.validateStudioDocument(w.document),w.document);for(const source of w.document.sources)assert.ok(source.path.startsWith(`${owner}/${w.id}/`));}
 finally{global.fetch=prior;}
});

test('fork copies attachments under independent owner/project paths and marks completion',async()=>{
 const s=service(),original=workspace();s.records.set(id,original);const fork=await s.projects.forkWorkspace(ctx,original);
 assert.equal(fork.document.project.copyState,'ready');assert.equal(fork.document.project.forkedFrom.revision,2);
 const call=s.calls.find(c=>c[0]==='/storage/v1/object/copy');assert.deepEqual(call[1].body,{bucketId:'studio-sources',sourceKey:source.path,destinationKey:`${owner}/${fork.id}/${sid}.pdf`});assert.equal(call[1].token,ctx.accessToken);assert.equal(original.document.sources[0].path,source.path);
});

test('failed copy stays recoverable, retry acquires a revision lock, active copy cannot be retried',async()=>{
 const s=service(),original=workspace();s.records.set(id,original);s.setFail(true);
 await assert.rejects(s.projects.forkWorkspace(ctx,original),e=>e.code==='project_copy_failed');
 const failed=[...s.records.values()].find(w=>w.id!==id);assert.equal(failed.document.project.copyState,'failed');s.setFail(false);
 const ready=await s.projects.retryProjectCopy(ctx,failed);assert.equal(ready.document.project.copyState,'ready');assert.equal(ready.revision,failed.revision+2);
 const pending={...ready,document:{...ready.document,project:{...ready.document.project,copyState:'preparing'}}};s.records.set(ready.id,pending);
 await assert.rejects(s.projects.retryProjectCopy(ctx,pending),e=>e.code==='project_copy_pending');
 const stale={...pending,updated_at:new Date(Date.now()-130_000).toISOString()};s.records.set(ready.id,stale);assert.equal((await s.projects.retryProjectCopy(ctx,stale)).document.project.copyState,'ready');
});

test('fork bounds file size and rejects projects whose files have not finished copying',async()=>{
 const s=service(),original=workspace();original.document.sources[0]={...source,size:51*1024*1024};await assert.rejects(s.projects.forkWorkspace(ctx,original),e=>e.code==='project_copy_too_large');assert.equal(s.records.size,0);
 original.document.project={copyState:'failed'};await assert.rejects(s.projects.forkWorkspace(ctx,original),e=>e.code==='project_copy_pending');
});

test('project rename/archive/restore enforce owner lookup and optimistic revisions',async()=>{
 const s=service();s.records.set(id,workspace());const route=load('app/api/studio/workspaces/[id]/project/route.ts',{'@/lib/studio/auth':{requireStudioUser:async()=>ctx},'@/lib/studio/http':http,'@/lib/studio/store':s.store,'@/lib/studio/projects':s.projects});const params={params:Promise.resolve({id})};
 assert.equal((await route.POST(request({action:'rename',revision:1,title:'Wrong'}),params)).status,409);
 assert.equal((await route.POST(request({action:'rename',revision:2,title:' Renamed '}),params)).status,200);assert.equal(s.records.get(id).document.title,'Renamed');assert.equal(s.records.get(id).document.model.title,'Original');
 assert.equal((await route.POST(request({action:'archive',revision:3}),params)).status,200);assert.equal(s.records.get(id).document.project.archived,true);
 assert.equal((await route.POST(request({action:'restore',revision:4}),params)).status,200);assert.equal(s.records.get(id).document.project.archived,false);
 assert.equal((await route.POST(request({action:'delete',revision:5}),params)).status,400);
 assert.equal((await route.POST(request({action:'rename',revision:5,title:' '}),params)).status,400);
 assert.equal((await route.POST(request({action:'archive',revision:5}),{params:Promise.resolve({id:other})})).status,404);
 const foreign=new Request(request({action:'archive',revision:5}),{headers:{origin:'https://other.example.test','content-type':'application/json'}});assert.equal((await route.POST(foreign,params)).status,403);
});

test('directory lists metadata only and autosave preserves server-owned provenance',async()=>{
 let selection;const store=load('lib/studio/store.ts',{'./http':{...http,studioFetch:async(url)=>{selection=url;return Response.json([]);}}});await store.listWorkspaces(ctx);assert.match(selection,/project:document->project/);assert.doesNotMatch(selection,/revision,document,/);
 const w=workspace();w.document.project={sampleId:'intentional-action',copyState:'ready'};let saved;
 const route=load('app/api/studio/workspaces/[id]/route.ts',{'@/lib/studio/auth':{requireStudioUser:async()=>ctx},'@/lib/studio/http':http,'@/lib/studio/store':{getWorkspace:async()=>w,saveWorkspace:async(_,__,doc)=>{saved=doc;return {...w,document:doc};}},'@/lib/studio/validation':validation});
 const forged={...w.document,project:{sampleId:'forged',archived:true}};
 const response=await route.PATCH(request({document:forged,expectedRevision:2}),{params:Promise.resolve({id})});assert.equal(response.status,200);assert.deepEqual(saved.project,w.document.project);
 w.document.project.copyState='preparing';assert.equal((await route.PATCH(request({document:forged,expectedRevision:2}),{params:Promise.resolve({id})})).status,409);
});

 test('legacy example route leads to sample loading rather than an offline editor',()=>{
 let destination;const page=load('app/build/example/page.tsx',{'next/navigation':{redirect:href=>{destination=href;}}});page.default();assert.equal(destination,'/build?sample=intentional-action');
 });
