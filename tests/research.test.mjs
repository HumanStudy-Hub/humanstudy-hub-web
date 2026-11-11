import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../lib/research.ts', import.meta.url),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const mod = {exports:{}};new Function('require','module','exports',js)(require,mod,mod.exports);
const {searchSnapshot, validateResearchQuery, searchResearch}=mod.exports;
const index = JSON.parse(readFileSync(new URL('../data/research_index.json',import.meta.url),'utf8'));

test('search covers the entire corpus, source claims and reviewed Chinese aliases',()=>{
  const all=searchSnapshot(index,{limit:10000});assert.equal(all.total,index.papers.length);
  assert.equal(new Set(all.items.map(p=>p.id)).size,all.total);
  for(const query of ['framing effect','框架效应']) {
    const r=searchSnapshot(index,{query});assert.ok(r.items.some(p=>p.aliases.includes('bench:study_003')));
  }
  const sample={...index.papers[0],id:'paper_'+'f'.repeat(24),aliases:['test:untagged'],title:'Another framing effect study',conceptIds:[]};
  const r=searchSnapshot({...index,papers:[sample]},{query:'框架效应'});
  assert.equal(r.total,1);assert.equal(r.items[0].matchedBy,'concept-alias-content');
  assert.equal(searchSnapshot(index,{capability:'replayable'}).total,0,'imported metadata does not become runnable');
});
test('pagination has stable totals and validation rejects malformed filters',()=>{
  const first=searchSnapshot(index,{offset:0,limit:2}),second=searchSnapshot(index,{offset:2,limit:2});
  assert.equal(first.total,second.total);assert.notEqual(first.items[0].id,second.items[0].id);
  assert.equal(searchSnapshot(index,{offset:100000}).total,index.papers.length);
  for(const q of ['offset=-1','limit=0','limit=101','capability=admin','concept=unsafe%29','offset=1.2'])
    assert.throws(()=>validateResearchQuery(new URLSearchParams(q)));
});
test('unavailable database falls back explicitly, while empty initialized results remain authoritative',async()=>{
  const previous=globalThis.fetch,oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='public-test';
  try {
    globalThis.fetch=async()=>{throw Error('offline')};
    const fallback=await searchResearch({query:'框架效应'});
    assert.equal(fallback.source,'snapshot');assert.equal(fallback.scope,'indexed-corpus');assert.ok(fallback.total>0);
    globalThis.fetch=async()=>new Response(JSON.stringify({items:[],total:0,snapshot:'a'.repeat(64)}));
    const empty=await searchResearch({query:'not-indexed'});assert.equal(empty.source,'database');assert.equal(empty.total,0);
  } finally {
    globalThis.fetch=previous;
    if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;
    if(oldKey===undefined)delete process.env.SUPABASE_PUBLISHABLE_KEY;else process.env.SUPABASE_PUBLISHABLE_KEY=oldKey;
  }
});
test('public search never uses the service-role key',async()=>{
  const previous=globalThis.fetch,saved={...process.env};let called=false;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;delete process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='secret-test';
  try {
    globalThis.fetch=async(url)=>{if(String(url).includes('/rest/v1/'))called=true;throw Error('offline')};
    const result=await searchResearch({query:'framing'});
    assert.equal(called,false);assert.equal(result.source,'snapshot');
  } finally {
    globalThis.fetch=previous;
    for(const k of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_PUBLISHABLE_KEY','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','SUPABASE_ANON_KEY']){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k]}
  }
});


test('library detail resolves a newly listed paper before the database mirror catches up', async () => {
  const {getResearchPaper, searchLibrary} = mod.exports;
  const previous = globalThis.fetch;
  const saved = {url:process.env.SUPABASE_URL,key:process.env.SUPABASE_PUBLISHABLE_KEY};
  process.env.SUPABASE_URL='https://stale.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY='public-test';
  const paper={...index.papers[0],id:'paper_8a4321ea6ba1853fb61c0309',title:'GENIUS',
    aliases:['doi:10.2378/peu2026.art12d'],legacyStudyId:'study_016'};
  const snapshot={...index,papers:[paper]};
  let databaseCalls=0;
  try {
    globalThis.fetch=async url=>{
      if(String(url).includes('/rest/v1/')) {
        databaseCalls++;
        return new Response(JSON.stringify({items:[],total:0,snapshot:'b'.repeat(64)}));
      }
      return new Response(JSON.stringify(snapshot));
    };
    const listing=await searchLibrary({query:'GENIUS'},'all');
    assert.equal(listing.items[0].id,paper.id);
    assert.equal((await getResearchPaper(paper.id)).title,'GENIUS');
    assert.equal((await getResearchPaper(paper.aliases[0])).id,paper.id);
    assert.equal(await getResearchPaper('paper_'+'0'.repeat(24)),null);
    assert.equal(databaseCalls,0,'listing and detail must use the same source');
    globalThis.fetch=async()=>new Response(JSON.stringify({...snapshot,papers:[paper,
      {...paper,id:'paper_'+'f'.repeat(24)}]}));
    assert.equal(await getResearchPaper(paper.aliases[0]),null,'ambiguous aliases cannot select a different paper');
  } finally {
    globalThis.fetch=previous;
    if(saved.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=saved.url;
    if(saved.key===undefined)delete process.env.SUPABASE_PUBLISHABLE_KEY;else process.env.SUPABASE_PUBLISHABLE_KEY=saved.key;
  }
});

test('validation requires maintainer provenance, the signed public revision and runnable scope', () => {
  const {libraryAvailability} = mod.exports;
  const revision = 'b'.repeat(64);
  const protocol = {slug:'reviewed', revision, schemaVersion:'1',
    fidelity:{verdict:'high fidelity',signedBy:['Maintainer']},arms:[{id:'main',runnable:true}]};
  const paper = {currentRevision:revision, assetFiles:[{path:'protocol.json'}], protocol,
    publication:{kind:'maintainer-reviewed-protocol',revision}};
  assert.equal(libraryAvailability(paper).validated,true);
  for (const override of [
    {revision:'a'.repeat(64)}, {schemaVersion:'0.8'}, {arms:[{id:'main',runnable:false}]},
    {fidelity:{verdict:'high fidelity',signedBy:[]}},
  ]) assert.equal(libraryAvailability({...paper,protocol:{...protocol,...override}}).validated,false);
  assert.equal(libraryAvailability({...paper,assetFiles:[{path:'program.json'}]}).validated,false);
  assert.equal(libraryAvailability({...paper,publication:undefined}).validated,false);
  assert.equal(libraryAvailability({...paper,publication:{...paper.publication,revision:'a'.repeat(64)}}).validated,false);
  const user = libraryAvailability({...paper,publication:{kind:'user-submitted',revision}});
  assert.equal(user.validated,false);
  assert.equal(user.userSubmitted,true);
  assert.equal(user.runnable,true);
});

test('library counts match filters and DOI updates keep one paper entry', async () => {
  const {searchLibrary, getResearchPaper, includeDevelopment} = mod.exports;
  const oldFetch = globalThis.fetch;
  const empty = {...index, papers:[]};
  const development = includeDevelopment(empty).papers;
  assert.equal(development.length,20);
  const draft = development.find(p=>p.developmentStage==='draft');
  const currentRevision = 'a'.repeat(64);
  const published = {...draft, id:'paper_'+'f'.repeat(24), aliases:draft.aliases.map(a=>a.toUpperCase()),
    developmentStage:undefined, currentRevision, assetFiles:[{path:'program.json'},{path:'protocol.json'}],
    protocol:{slug:'example',revision:currentRevision,schemaVersion:'1',
      fidelity:{verdict:'high fidelity',signed_by:'Review team'},arms:[{id:'a',runnable:true}]}};
  const reading = {...index.papers[0], currentRevision, assetFiles:[{path:'program.json'}],
    capabilities:{replayable:true}, studyCapabilities:{run:{status:'no'}}};
  try {
    globalThis.fetch = async()=>new Response(JSON.stringify({...empty,papers:[published,reading],
      publications:{[published.id]:{kind:'maintainer-reviewed-protocol',revision:currentRevision}}}));
    const result = await searchLibrary({limit:100},'all');
    assert.deepEqual(result.counts,{all:21,program:2,runnable:1,protocol:1,development:19,indexed:0});
    const validated = await searchLibrary({limit:100}, 'all', true);
    assert.deepEqual(validated.items.map(p => p.id), [published.id]);
    assert.deepEqual((await searchLibrary({query:'no matching paper'}, 'all', true)).items, []);
    const rows = await searchLibrary({limit:100},'development');
    assert.equal(rows.items.length,19);
    assert.equal(rows.items.filter(p=>p.developmentStage==='draft').length,6);
    assert.equal(await getResearchPaper(draft.id),null,'existing catalog paper ID wins over the new DOI placeholder');
    assert.equal((await getResearchPaper(published.id)).currentRevision,currentRevision);
    assert.equal((await getResearchPaper(rows.items[0].id)).doi,rows.items[0].doi);
  } finally {globalThis.fetch=oldFetch;}
});


test('catalog-level provenance takes precedence over contributor-supplied paper metadata', async () => {
  const {getResearchPaper, libraryAvailability, searchLibrary} = mod.exports;
  const oldFetch = globalThis.fetch;
  const revision = 'a'.repeat(64);
  const paper = {...index.papers[0], currentRevision:revision,
    publication:{kind:'maintainer-reviewed-protocol',revision},
    assetFiles:[{path:'program.json'},{path:'protocol.json'}],
    protocol:{slug:'self-signed',schemaVersion:'1',revision,arms:[{id:'main',runnable:true}],
      fidelity:{verdict:'high fidelity',signedBy:['Uploader']}}};
  try {
    const snapshot = {...index,papers:[paper]};
    globalThis.fetch = async()=>new Response(JSON.stringify(snapshot));
    assert.equal((await getResearchPaper(paper.id)).publication,undefined);
    assert.equal((await searchLibrary({},'all',true)).total,0);
    globalThis.fetch = async()=>new Response(JSON.stringify({...snapshot,
      publications:{[paper.id]:{kind:'user-submitted',revision}}}));
    const status = libraryAvailability(await getResearchPaper(paper.id));
    assert.equal(status.userSubmitted,true);
    assert.equal(status.validated,false);
  } finally { globalThis.fetch = oldFetch; }
});
