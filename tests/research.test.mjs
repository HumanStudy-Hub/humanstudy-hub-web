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
