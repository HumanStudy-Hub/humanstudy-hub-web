import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const require=createRequire(import.meta.url),ts=require('typescript');
process.env.RESEARCH_COLLECTION_V1_ENABLED='1';
function load(file,deps={}){const m={exports:{}};const js=ts.transpileModule(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',js)(id=>deps[id]??require(id),m,m.exports);return m.exports;}
const {verifyContent,verifyPendingContent}=load('lib/research-data/verify-content.ts');
const sha=b=>createHash('sha256').update(b).digest('hex');
const owner='11111111-1111-4111-8111-111111111111';
function whole(bytes){return {owner_id:owner,sha256:sha(bytes),kind:'whole',bytes:bytes.length,stored_bytes:bytes.length,encoding:'identity',surface:'desktop'}}
test('integrity verifies original and gzip bytes; corruption never succeeds',async()=>{
 const b=Buffer.from('Complete scientific material: αβγ'),r=whole(b);await verifyContent(r,{object:async()=>b});
 await assert.rejects(verifyContent(r,{object:async()=>Buffer.alloc(b.length)}),/hash_mismatch/);
 const gz=gzipSync(b);await verifyContent({...r,stored_bytes:gz.length,encoding:'gzip'},{object:async()=>gz});
 const bomb=gzipSync(Buffer.alloc(4*1024*1024+1));await assert.rejects(verifyContent({...r,stored_bytes:bomb.length,encoding:'gzip'},{object:async()=>bomb}));
});
test('manifest checks ordered parts, whole hash and byte count without nested manifests',async()=>{
 const a=Buffer.from('first α'),b=Buffer.from('second β'),parts=[whole(a),whole(b)],raw=Buffer.concat([a,b]),hash=sha(raw);
 const body=Buffer.from(JSON.stringify({format:'humanstudy-content-parts-v1',encoding:'bytes',bytes:raw.length,sha256:hash,parts:parts.map(p=>({sha256:p.sha256,bytes:p.bytes}))}));
 const row={...whole(raw),kind:'manifest',stored_bytes:body.length,parts:parts.map(p=>p.sha256)},read={row:async(_,h)=>parts.find(p=>p.sha256===h),object:async(_,h)=>h===hash?body:h===parts[0].sha256?a:b};
 await verifyContent(row,read);await assert.rejects(verifyContent(row,{...read,row:async()=>null}),/part_not_uploaded/);
 await assert.rejects(verifyContent({...row,parts:[...row.parts].reverse()},read),/invalid_manifest_part/);
 await assert.rejects(verifyContent(row,{...read,row:async()=>({...parts[0],kind:'manifest'})}),/invalid_part_row/);
});
test('scheduled verifier marks only checked bytes and does not return content',async()=>{
 const data=Buffer.from('verified scientific content'),row=whole(data),updates=[];
 const result=await verifyPendingContent({url:'https://db.test',key:'server-test-secret',fetch:async(url,init={})=>{
  if(init.method==='PATCH'){updates.push(JSON.parse(init.body));return new Response(null,{status:204});}
  if(url.includes('/storage/'))return new Response(data);
  return Response.json([row]);
 }});assert.deepEqual(result,{checked:1,verified:1,pending:0,failed:0});assert.ok(updates[0].verified_at);assert.ok(!JSON.stringify(result).includes(data.toString()));
});
test('real consent guard refuses unagreed and old-version records; owner filter is server-derived',async()=>{
 let rows=[],path;const ctx={user:{id:owner},accessToken:'personal-fixture'};
 const guard=load('lib/research-data/consent-server.ts',{'../studio/auth':{requireStudioUser:async()=>ctx},'./agreement':{RESEARCH_CONSENT_VERSION:3},'../studio/http':{studioFetch:async p=>{path=p;return Response.json(rows);},upstreamJson:r=>r.json(),StudioError:class extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}}});
 await assert.rejects(guard.requireStudioResearchUser(),e=>e.status===403);rows=[{version:2}];await assert.rejects(guard.requireStudioResearchUser(),e=>e.status===403);rows=[{version:3}];assert.equal((await guard.requireStudioResearchUser()).user.id,owner);assert.match(path,new RegExp('owner_id=eq.'+owner));
});
test('first-use gate mounts the workspace only after agreement and API routes enforce it',()=>{
 const ui=fs.readFileSync(new URL('../components/studio/research-agreement.tsx',import.meta.url),'utf8');assert.match(ui,/if \(ready\) return <ResearchCollectionContext.Provider/);assert.match(ui,/data\.agreed === true/);
 for(const p of ['sources','chat','pipeline','events']){const src=fs.readFileSync(new URL(`../app/api/studio/workspaces/[id]/${p}/route.ts`,import.meta.url),'utf8');assert.match(src,/requireStudioResearchUser/);}
});
test('web source archival keeps exact bytes, deduplicates across projects and retries idempotently',async()=>{
 const contract=load('lib/research-data/contract.ts'),raw=Buffer.from('Exact source bytes: αβγ'),objects=new Map(),content=new Map(),events=new Map();let posts=0;
 const previous=global.fetch;
 global.fetch=async(url,init)=>{posts++;objects.set(url,Buffer.from(init.body));return new Response(null,{status:201});};
 const http={
  StudioError:class extends Error{},studioConfig:()=>({url:'https://db.test',key:'public'}),upstreamJson:r=>r.json(),
  studioFetch:async(path,o={})=>{
   if(path.includes('/studio-sources/'))return new Response(raw);
   if(path.startsWith('/rest/v1/research_content')){
    if(o.method==='POST'){content.set(o.body.sha256,o.body);return Response.json([o.body]);}
    const h=new URL('https://db.test'+path).searchParams.get('sha256').slice(3);return Response.json(content.has(h)?[{sha256:h}]:[]);
   }
   if(path.startsWith('/rest/v1/research_events')){
    if(o.method==='POST'){const keys=Object.keys(o.body[0]).sort();for(const row of o.body){assert.deepEqual(Object.keys(row).sort(),keys,'real PostgREST rejects mixed bulk-insert columns');events.set(row.id,row);}return Response.json(o.body);}
    return Response.json([]);
   }
   throw Error('Unexpected route');
  },
 };
 const {archiveSource}=load('lib/research-data/archive-source.ts',{'../studio/http':http,'./contract':contract});
 const ctx={user:{id:owner},accessToken:'personal-fixture'},source={id:'22222222-2222-4222-8222-222222222222',name:'source.pdf',mimeType:'application/pdf',path:owner+'/project/source.pdf',size:raw.length};
 try{
  const first=await archiveSource(ctx,'33333333-3333-4333-8333-333333333333',source);await archiveSource(ctx,'33333333-3333-4333-8333-333333333333',source);await archiveSource(ctx,'44444444-4444-4444-8444-444444444444',source);
  assert.equal(first.sha256,sha(raw));assert.equal(posts,1);assert.deepEqual([...objects.values()][0],raw);assert.equal(events.size,6);assert.ok([...events.values()].every(e=>contract.validateResearchEvent(e).length===0));
 }finally{global.fetch=previous;}
});
