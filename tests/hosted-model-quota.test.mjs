import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
const require=createRequire(import.meta.url), ts=require('typescript');
function load(file,deps={}) { const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>deps[name]??require(name),m,m.exports);return m.exports; }
const user='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222', model='anthropic/claude-haiku-5.5';
const quota=load('lib/hosted-model-quota.ts',{'server-only':{},'./try-online-config':{tryServiceKey:()=> 'fixture'}});
test('quota scope comes only from explicit server release configuration',t=>{
 const keys=['HOSTED_MODEL_QUOTAS','VERCEL_ENV','VERCEL_GIT_COMMIT_REF'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];});
 delete process.env.HOSTED_MODEL_QUOTAS;process.env.VERCEL_ENV='production';assert.equal(quota.hostedQuotaEnvironment(),null);
 process.env.HOSTED_MODEL_QUOTAS='1';assert.equal(quota.hostedQuotaEnvironment(),'production');
 process.env.VERCEL_ENV='preview';process.env.VERCEL_GIT_COMMIT_REF='feature';assert.equal(quota.hostedQuotaEnvironment(),null);
 process.env.VERCEL_GIT_COMMIT_REF='dev';assert.equal(quota.hostedQuotaEnvironment(),'dev');
});
test('enabled route never contacts provider on denied grants or oversized UTF8 and preserves legacy production when disabled',async t=>{
 const keys=['HOSTED_MODEL_QUOTAS','VERCEL_ENV','OPENROUTER_API_KEY'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];});
 let environment='production',allow=false,forwards=0,reserves=0;
 process.env.VERCEL_ENV='production';process.env.HOSTED_MODEL_QUOTAS='1';process.env.OPENROUTER_API_KEY='fixture';
 const bounds=load('lib/try-dev-model-budget.ts',{'./try-online-config':{tryServiceKey:()=> 'fixture'}});
 const route=load('app/api/desktop/v1/chat/completions/route.ts',{
  'next/server':{NextResponse:{json:Response.json}},
  '@/lib/bounded-request':load('lib/bounded-request.ts'),
  '@/lib/desktop-access':{bearer:()=> 'signed',verifyDesktopKey:()=>user,DESKTOP_MODELS:[model]},
  '@/lib/try-dev-models':{isDevPreview:()=>false,devModelAccess:()=>false},
  '@/lib/try-dev-model-budget':bounds,
  '@/lib/hosted-model-quota':{hostedQuotaEnvironment:()=>environment,reserveHostedCompletion:async(account)=>{assert.equal(account,user);reserves++;return allow?'server-request-id':null;}}
 });
 t.mock.method(globalThis,'fetch',async()=>{forwards++;return new Response('{}');});
 const request=(content='small',extra={})=>new Request('https://fixture.test',{method:'POST',body:JSON.stringify({model,messages:[{role:'user',content}],...extra})});
 assert.equal((await route.POST(request())).status,429);assert.equal(forwards,0);
 assert.equal((await route.POST(request('研'.repeat(1400000)))).status,413);assert.equal(reserves,1);assert.equal(forwards,0);
 assert.equal((await route.POST(request('small',{account_id:other,environment:'dev'}))).status,400);assert.equal(forwards,0);
 allow=true;assert.equal((await route.POST(request())).status,200);assert.equal(forwards,1);
 environment=null;delete process.env.HOSTED_MODEL_QUOTAS;assert.equal((await route.POST(request())).status,200);assert.equal(forwards,2);
});
test('atomic pool/account admission, revocation, settlement and privileges; smoke route survives',async()=>{
 const db=new PGlite();
 const reserve=(amount=50,env='dev',who=user,id=randomUUID())=>db.query('select public.online_reserve_account_model_budget($1,$2,$3,$4,$5) as ok',[id,env,who,model,amount]).then(x=>({ok:x.rows[0].ok,id}));
 const settle=(id,amount,env='dev')=>db.query('select public.online_settle_account_model_budget($1,$2,$3) as ok',[id,env,amount]).then(x=>x.rows[0].ok);
 try {
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261112181142_online_dev_model_budget.sql',import.meta.url),'utf8'));
  const migration=fs.readdirSync(new URL('../supabase/migrations/',import.meta.url)).find(x=>x.endsWith('_hosted_account_model_allowances.sql'));
  assert.ok(migration);await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  await db.query('insert into auth.users values($1),($2)',[user,other]);
  await db.query("insert into public.online_dev_model_budget(singleton,user_id,models,expires_at,remaining_microusd,remaining_requests) values(true,$1,array[$2],now()+interval '1 hour',125,5)",[user,model]);
  await db.query("insert into public.online_dev_model_budget(singleton,user_id,models,expires_at,remaining_microusd,remaining_requests,budget_key,environment,scope) values(NULL,NULL,array[$2],now()+interval '1 hour',125,5,'dev:pool','dev','pool'),(NULL,$1,array[$2],now()+interval '1 hour',125,5,'dev:account:'||($1::uuid)::text,'dev','account')",[user,model]);
  await db.exec('set role authenticated');await assert.rejects(reserve(),/permission denied/);await assert.rejects(settle(randomUUID(),0),/permission denied/);await assert.rejects(db.query('select public.online_account_model_access($1,$2)',['dev',user]),/permission denied/);await assert.rejects(db.exec('select * from public.online_model_reservations'),/permission denied/);
  await db.exec('set role service_role');
  await assert.rejects(db.exec("update public.online_dev_model_budget set remaining_requests=101 where singleton"),/model_allowance_requests/);
  await assert.rejects(db.exec("update public.online_dev_model_budget set remaining_microusd=9000001 where singleton"),/model_allowance_amount/);
  assert.deepEqual((await db.query('select public.online_account_model_access($1,$2) as models',['dev',user])).rows[0].models,[model]);
  assert.deepEqual((await db.query('select public.online_account_model_access($1,$2) as models',['production',user])).rows[0].models,[]);
  assert.equal((await reserve(10,'production')).ok,false);assert.equal((await reserve(10,'dev',other)).ok,false);
  const attempts=await Promise.all(Array.from({length:5},()=>reserve()));const admitted=attempts.filter(x=>x.ok);assert.equal(admitted.length,2);
  assert.equal((await db.query("select remaining_microusd from public.online_dev_model_budget where budget_key='dev:pool'")).rows[0].remaining_microusd,25);
  assert.equal((await reserve(1,'dev',user,admitted[0].id)).ok,false);
  assert.equal(await settle(admitted[0].id,10,'production'),false);
  assert.equal(await settle(admitted[0].id,10),true);assert.equal(await settle(admitted[0].id,10),true);assert.equal(await settle(admitted[0].id,9),false);
  assert.equal((await db.query("select remaining_microusd from public.online_dev_model_budget where budget_key='dev:pool'")).rows[0].remaining_microusd,65);
  await db.exec("update public.online_dev_model_budget set revoked=true where scope='account'");assert.equal((await reserve(1)).ok,false);
  assert.deepEqual((await db.query('select public.online_account_model_access($1,$2) as models',['dev',user])).rows[0].models,[]);
  assert.equal(await settle(admitted[1].id,0),true);assert.equal((await reserve(1)).ok,false,'settlement must not restore revoked access');
  await db.exec("reset role;update public.online_dev_model_budget set revoked=false,expires_at=now()-interval '1 second' where scope='account';set role service_role");assert.equal((await reserve(1)).ok,false);
  await db.exec("reset role;update public.online_dev_model_budget set expires_at=now()+interval '1 hour' where scope='account';set role service_role");
  const over=await reserve(1);assert.equal(over.ok,true);assert.equal(await settle(over.id,2),false);assert.equal((await reserve(1)).ok,false,'overrun halts pool');
  assert.equal((await db.query('select public.online_reserve_dev_model_budget($1,$2,10) as ok',[user,model])).rows[0].ok,true);
 } finally {await db.close();}
});


test('quota discovery exposes only allowed models and database failures deny admission',async t=>{
 const keys=['HOSTED_MODEL_QUOTAS','VERCEL_ENV','SUPABASE_URL'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];});
 process.env.HOSTED_MODEL_QUOTAS='1';process.env.VERCEL_ENV='production';process.env.SUPABASE_URL='https://db.test';
 t.mock.method(globalThis,'fetch',async()=>{throw Error('unavailable');});
 assert.equal(await quota.reserveHostedCompletion(user,model,10,new AbortController().signal),null);
 assert.deepEqual(await quota.hostedModelsForAccount(user),[]);
 const route=load('app/api/desktop/v1/models/route.ts',{
  'next/server':{NextResponse:{json:Response.json}},
  '@/lib/desktop-access':{bearer:()=> 'signed',verifyDesktopKey:()=>user,DESKTOP_MODELS:[model,'unpriced/model']},
  '@/lib/try-dev-model-budget':{BOUNDED_HOSTED_MODELS:[model]},
  '@/lib/hosted-model-quota':{hostedQuotaEnvironment:()=> 'production',hostedModelsForAccount:async id=>{assert.equal(id,user);return [model,'unpriced/model'];}}
 });
 const response=await route.GET(new Request('https://fixture.test'));assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual((await response.json()).data.map(x=>x.id),[model]);
});


test('quota config never silently replaces an unpriced default model; legacy config is unchanged',async t=>{
 const keys=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];});
 process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_PUBLISHABLE_KEY='public-fixture';
 let enabled='production';
 const route=load('app/api/desktop/config/route.ts',{
  'next/server':{NextResponse:{json:Response.json}},
  '@/lib/desktop-access':{DESKTOP_DEFAULT_MODEL:'anthropic/claude-sonnet-5.5',DESKTOP_MODELS:['anthropic/claude-sonnet-5.5',model]},
  '@/lib/try-dev-model-budget':{BOUNDED_HOSTED_MODELS:[model]},
  '@/lib/hosted-model-quota':{hostedQuotaEnvironment:()=> enabled},
 });
 assert.equal((await route.GET()).status,503);
 enabled=null;const response=await route.GET();assert.equal(response.status,200);assert.equal((await response.json()).defaultModel,'anthropic/claude-sonnet-5.5');
});
