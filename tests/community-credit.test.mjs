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
