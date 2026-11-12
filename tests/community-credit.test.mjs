import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const ts = require('typescript');
const owner = '11111111-1111-4111-8111-111111111111';
const voter = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';
const paperId = 'paper_' + 'a'.repeat(24);
const commit = 'b'.repeat(40);
const head = 'c'.repeat(40);
const files = [{path:'program.json',sha256:'d'.repeat(64)}];
const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const currentRevision = 'e'.repeat(64);
const paperKey = 'doi:10.0000/fixture';

test('real PostgreSQL: private rows, exact revision, no self-vote, concurrent upserts and removal', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      insert into auth.users values ('${owner}'), ('${voter}'), ('${other}');`);
    for (const file of ['20261012120000_contributions.sql', '20261111233809_community_credits.sql']) {
      await db.exec(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
    await db.query("insert into public.contributions(id, owner_id, paper_key, folder, slug) values ($1::uuid,$2,$3,$1::uuid::text,'fixture')", [id, owner, paperKey]);

    await db.exec('set role service_role');
    const register = (name, rev = revision) => db.query('select public.register_community_credit($1,$2,$3,$4,$5,$6)',
      [id, paperId, 'Fixture paper', rev, commit, name]);
    const vote = async (user, desired, rev = revision) => (await db.query(
      'select public.set_community_helpful($1,$2,$3,$4) as state', [id, rev, user, desired],
    )).rows[0].state;
    await register('Public Contributor');
    await register('A different name', currentRevision);
    const [entry] = (await db.query('select * from public.community_credit_totals')).rows;
    assert.equal(entry.display_name,'Public Contributor');
    assert.equal(entry.revision, revision);
    assert.notEqual(entry.contributor_id, owner);
    assert.ok(!('owner_id' in entry) && !('voter_id' in entry));
    assert.equal(await vote(voter, true, currentRevision), null);
    assert.deepEqual(await vote(owner, true), {canVote:false,voted:false,helpful:0});
    await Promise.all(Array.from({length:8}, () => vote(voter, true)));
    assert.deepEqual(await vote(voter, null), {canVote:true,voted:true,helpful:1});
    await assert.rejects(db.query('insert into public.community_helpful_votes values ($1,$2)',[id,voter]), /duplicate key/);
    assert.deepEqual(await vote(other, true), {canVote:true,voted:true,helpful:2});
    assert.deepEqual(await vote(voter, false), {canVote:true,voted:false,helpful:1});
    assert.equal((await db.query('select helpful from public.community_contributor_totals')).rows[0].helpful, 1);

    for (const role of ['anon','authenticated']) {
      await db.exec('set role ' + role);
      await assert.rejects(db.query('select * from public.community_helpful_votes'), /permission denied/);
      await assert.rejects(db.query('select * from public.community_contributors'), /permission denied/);
      await assert.rejects(vote(voter, true), /permission denied/);
      await assert.rejects(register('Forged'), /permission denied/);
    }
  } finally { await db.close(); }
});

function load(file, deps = {}) {
  const js = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  new Function('require', 'module', 'exports', js)(key => deps[key] ?? require(key), m, m.exports);
  return m.exports;
}

test('credit follows the accepted immutable revision even after a newer one becomes current', async () => {
  const lib = load('lib/community-credit.ts', { './community-store': {} });
  const branch = 'community/' + id;
  const row = {id, paper_key:paperKey, pr_number:42, branch, status:'merged'};
  const review = {status:'accepted',proposalId:id,paperKey,revision,headCommit:head};
  const replies = new Map([
    ['/git/ref/heads/main',{object:{sha:commit}}],
    ['/research_index.json',{schemaVersion:1,papers:[{id:paperId,paperKey,title:'Fixture paper',currentRevision}]}],
    ['/reviews/' + id + '.json',review],
    ['/proposals/' + id + '/CONTRIBUTION.json',{proposalId:id,paperKey,contributor:{name:'Public Contributor'}}],
    ['/pulls/42',{head:{ref:branch,sha:head}}],
    ['/revisions/' + revision + '/manifest.json',{revision,files}],
  ]);
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      const entry = [...replies.entries()].find(([suffix]) => String(url).endsWith(suffix));
      if (!entry) return new Response(null, {status:404});
      if (String(url).includes('raw.githubusercontent.com')) assert.ok(String(url).includes('/' + commit + '/'));
      return Response.json(entry[1]);
    };
    const verified = await lib.verifyCommunityCredit(row);
    assert.equal(verified.accepted_revision,revision);
    assert.equal(verified.public_name,'Public Contributor');
    const movedPaper = {id:paperId,paperKey:'doi:10.0000/new-key',aliases:['community:' + paperKey],title:'Fixture paper',currentRevision};
    replies.set('/research_index.json',{schemaVersion:1,papers:[movedPaper]});
    assert.equal((await lib.verifyCommunityCredit(row)).accepted_revision,revision);
    replies.set('/research_index.json',{schemaVersion:1,papers:[movedPaper,{...movedPaper,id:'paper_'+'f'.repeat(24)}]});
    assert.equal(await lib.verifyCommunityCredit(row),null,'ambiguous historical aliases never assign credit');
    replies.set('/research_index.json',{schemaVersion:1,papers:[movedPaper]});
    replies.set('/reviews/' + id + '.json',{...review,status:'unchanged'});
    assert.equal(await lib.verifyCommunityCredit(row),null);
    replies.set('/reviews/' + id + '.json',review);
    replies.set('/pulls/42',{head:{ref:branch,sha:'f'.repeat(40)}});
    assert.equal(await lib.verifyCommunityCredit(row),null);
    replies.set('/pulls/42',{head:{ref:branch,sha:head}});
    replies.set('/revisions/' + revision + '/manifest.json',{revision,files:[{...files[0],sha256:'f'.repeat(64)}]});
    assert.equal(await lib.verifyCommunityCredit(row),null);
  } finally { globalThis.fetch = oldFetch; }
});

test('an owned submission recheck uses the current GitHub pull state', async () => {
  const lib = load('lib/community-credit.ts', { './community-store': {} });
  const branch = 'community/' + id;
  const row = { id, branch, pr_number: 42, status: 'checks_failed' };
  const oldFetch = globalThis.fetch;
  let pull = { head: { ref: branch }, state: 'open', labels: [{ name: 'community:needs-review' }] };
  try {
    globalThis.fetch = async () => Response.json(pull);
    assert.equal(await lib.readCommunitySubmissionStatus(row), 'pr_open');
    pull = { ...pull, labels: [] };
    assert.equal(await lib.readCommunitySubmissionStatus({ ...row, status: 'changes_requested' }), 'pr_open');
    pull = { ...pull, state: 'closed' };
    assert.equal(await lib.readCommunitySubmissionStatus(row), 'rejected');
    pull = { ...pull, merged: true };
    assert.equal(await lib.readCommunitySubmissionStatus(row), 'merged');
    pull = { ...pull, head: { ref: 'another-branch' } };
    await assert.rejects(lib.readCommunitySubmissionStatus(row), /could not be verified/);
  } finally { globalThis.fetch = oldFetch; }
});


test('owned history pagination and receipt recheck cannot access another user', async () => {
  const { NextResponse } = require('next/server');
  let pageSeen, ownerSeen, refreshed, reconciled = 0;
  const row = {id,paper_key:paperKey,status:'pr_open',owner_id:owner,created_at:'2026-11-11T00:00:00Z'};
  const auth = {requireHubUser:async () => ({id:owner}),fail:(status,error,message)=>NextResponse.json({error,message},{status})};
  const route = load('app/api/community/mine/route.ts', {
    '@/lib/community-auth':auth,
    '@/lib/community-credit':{UUID:/^[a-f0-9-]{36}$/,reconcileCommunityCredit:async () => {reconciled++;return null;},
      readCommunitySubmissionStatus:async () => 'merged'},
    '@/lib/community-store':{CONTRIBUTIONS_PAGE_SIZE:25,getIdentity:async()=>null,
      listMine:async (account,page) => {ownerSeen=account;pageSeen=page;return Array.from({length:26},()=>row);},
      findOwnedContribution:async (submission,account)=>submission===id&&account===owner?row:null,
      refreshOwnedContributionStatus:async (record,status)=>{refreshed=record;return status;}},
  });
  const response=await route.GET(new Request('https://hub.test/api/community/mine?page=2&owner_id='+voter));
  const result=await response.json();
  assert.equal(ownerSeen,owner);assert.equal(pageSeen,2);assert.equal(result.contributions.length,25);assert.equal(result.hasMore,true);
  assert.ok(!('owner_id' in result.contributions[0]));
  assert.equal((await route.GET(new Request('https://hub.test/api/community/mine?page=-1'))).status,400);
  const post=body=>route.POST(new Request('https://hub.test/api/community/mine',{method:'POST',body:JSON.stringify(body)}));
  assert.equal((await post({id:voter})).status,404);assert.equal(reconciled,0);
  assert.deepEqual(await (await post({id})).json(),{status:'merged',contributorId:null});assert.equal(reconciled,1);
  assert.equal(refreshed,row);
});

test('cookie-authenticated reads work without Origin but writes retain origin protection', async () => {
  let originChecks=0;
  const auth=load('lib/community-auth.ts',{
    './desktop-access':{bearer:()=>null},
    './studio/auth':{requireStudioUser:async()=>({user:{id:owner}})},
    './studio/http':{assertSameOrigin:request=>{originChecks++;if(request.headers.get('origin')!=='https://hub.test')throw Error('origin');}},
  });
  assert.equal((await auth.requireHubUser(new Request('https://hub.test/api/community/mine'))).id,owner);
  assert.equal(originChecks,0);
  assert.equal((await auth.requireHubUser(new Request('https://hub.test/api/community/mine',{method:'POST'}))).status,401);
  assert.equal((await auth.requireHubUser(new Request('https://hub.test/api/community/mine',{method:'POST',headers:{Origin:'https://evil.test'}}))).status,401);
  assert.equal((await auth.requireHubUser(new Request('https://hub.test/api/community/mine',{method:'POST',headers:{Origin:'https://hub.test'}}))).id,owner);
  assert.equal(originChecks,3);
});
