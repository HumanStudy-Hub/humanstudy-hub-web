import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { PGlite } = require('@electric-sql/pglite');
const { chromium } = require(process.argv[2] || 'playwright');
const root = process.cwd();
const output = process.env.COMMUNITY_CREDIT_TEST_OUTPUT || '/tmp/humanstudy-credit-preview';
const owner = '11111111-1111-4111-8111-111111111111';
const voter = '22222222-2222-4222-8222-222222222222';
const id = '44444444-4444-4444-8444-444444444444';
const paper = 'paper_' + 'a'.repeat(24);
const revision = 'b'.repeat(64);
const service = 'local-community-credit-test-only';
const db = new PGlite();
let next;
let browser;
let upstream;

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    insert into auth.users values ('${owner}'), ('${voter}');`);
  for (const file of ['20261012120000_contributions.sql', '20261111233809_community_credits.sql']) {
    await db.exec(await readFile(join(root, 'supabase/migrations', file), 'utf8'));
  }
  await db.query("insert into public.contributions(id,owner_id,paper_key,folder,slug) values ($1::uuid,$2,'doi:10.0000/fixture',$1::uuid::text,'fixture')",[id,owner]);
  await db.query("update public.contributions set status='merged',pr_url='https://github.com/HumanStudy-Hub/HumanStudy-Bench/pull/42' where id=$1",[id]);
  for(let index=0;index<26;index++) await db.query(
    "insert into public.contributions(id,owner_id,paper_key,folder,slug,created_at) values ($1::uuid,$2,$3,$1::uuid::text,'older','2020-01-01')",
    ['55555555-5555-4555-8555-'+String(index).padStart(12,'0'),owner,'doi:10.0000/older-'+index]);
  await db.query("insert into public.contributions(id,owner_id,paper_key,folder,slug) values ($1,$2,'doi:10.0000/other-private','other','other')",['66666666-6666-4666-8666-666666666666',voter]);
  await db.exec('set role service_role');
  await db.query('select public.register_community_credit($1,$2,$3,$4,$5,$6)',
    [id,paper,'Fixture Study',revision,'c'.repeat(40),'Fixture Contributor']);
  const profile = (await db.query('select id from public.community_contributor_totals')).rows[0].id;

  // The local HTTP adapter exposes only fixture auth and forwards the actual SQL to PGlite.
  upstream = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {'Content-Type':'application/json'});
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://fixture.test');
      if (url.pathname === '/index') {
        return send(200, {schemaVersion:1,snapshot:'d'.repeat(64),taxonomyVersion:'test',taxonomy:{concepts:[]},
          papers:[{id:paper,title:'Fixture Study',authors:['Fixture Paper Author'],year:2025,aliases:[],
            conceptIds:[],currentRevision:revision,capabilities:{},searchText:'',studies:[],resources:[]}]});
      }
      if (url.pathname === '/auth/v1/user') {
        const account = {'Bearer fixture-owner':owner,'Bearer fixture-voter':voter}[request.headers.authorization];
        return account ? send(200,{id:account}) : send(401,{error:'invalid fixture session'});
      }
      if (request.headers.authorization !== 'Bearer ' + service) return send(401,{});
      if (url.pathname === '/rest/v1/rpc/set_community_helpful') {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const result = await db.query('select public.set_community_helpful($1,$2,$3,$4) as state',
          [body.submission_id,body.accepted_revision,body.account,body.desired]);
        return send(200,result.rows[0].state);
      }
      const view = url.pathname.split('/').at(-1);
      if(view === 'github_identities') return send(200,[]);
      if(view === 'contributions') {
        const account=url.searchParams.get('owner_id')?.slice(3);
        if(!account) return send(400,{});
        const submission=url.searchParams.get('id')?.slice(3);
        return send(200,(await db.query('select * from public.contributions where owner_id=$1'+
          (submission?' and id=$2':'')+' order by created_at desc,id desc limit '+Number(url.searchParams.get('limit')||26)+
          ' offset '+Number(url.searchParams.get('offset')||0),submission?[account,submission]:[account])).rows);
      }
      if (view === 'community_credit_totals' || view === 'community_contributor_totals') {
        const fields = ['id','paper_id','contributor_id','revision'].filter(key => url.searchParams.has(key));
        const predicates = fields.map((field,index) => field + ' = $' + (index + 1));
        const order = view === 'community_credit_totals' ? 'helpful desc, submitted_at desc, id' : 'helpful desc, contributions desc, id';
        const query = 'select * from public.' + view +
          (predicates.length ? ' where ' + predicates.join(' and ') : '') + ' order by ' + order;
        return send(200,(await db.query(query,fields.map(key => url.searchParams.get(key).slice(3)))).rows);
      }
      return send(404,{});
    } catch (error) { return send(500,{error:error.message}); }
  });
  await new Promise((resolve, reject) => upstream.once('error',reject).listen(0,'127.0.0.1',resolve));
  const fixture = 'http://127.0.0.1:' + upstream.address().port;
  next = spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','0'],{
    cwd:root,stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH, HOME:process.env.HOME, TMPDIR:process.env.TMPDIR, NODE_ENV:'production',
      NEXT_TELEMETRY_DISABLED:'1',SUPABASE_URL:fixture,SUPABASE_PUBLISHABLE_KEY:'fixture-publishable',
      SUPABASE_SERVICE_ROLE_KEY:service,ACCESS_COOKIE_SECRET:'local-fixture-access',RESEARCH_INDEX_URL:fixture+'/index'},
  });
  let log = '';
  next.stdout.on('data', chunk => log += chunk);
  next.stderr.on('data', chunk => log += chunk);
  let origin;
  for (let attempt=0; attempt<100 && !origin; attempt++) {
    assert.equal(next.exitCode,null,log);
    origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!origin) await delay(100);
  }
  assert.ok(origin,log);

  const vote = (session, desired, rev=revision, source=origin) => fetch(origin+'/api/community/credits/'+id+'/helpful',{
    method:'POST',headers:{Origin:source,'Content-Type':'application/json',
      ...(session ? {Cookie:'studio_access='+session} : {})},body:JSON.stringify({revision:rev,helpful:desired}),
  });
  assert.equal((await vote(null,true)).status,401);
  assert.equal((await vote('fixture-voter',true,revision,'https://other.test')).status,401);
  assert.equal((await vote('fixture-owner',true)).status,403);
  assert.equal((await vote('fixture-voter',true,'e'.repeat(64))).status,404);
  const votes = await Promise.all(Array.from({length:8},()=>vote('fixture-voter',true)));
  assert.ok(votes.every(response=>response.status===200));
  assert.equal((await (await vote('fixture-voter')).json()).helpful,1);
  assert.equal((await (await vote('fixture-voter',false)).json()).helpful,0);

  await mkdir(output,{recursive:true});
  browser = await chromium.launch({headless:true,executablePath:process.argv[3]});
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  await context.addCookies([{name:'studio_access',value:'fixture-voter',url:origin,httpOnly:true}]);
  const page = await context.newPage();
  await page.goto(origin+'/studies/'+paper);
  await page.getByRole('heading',{name:'Fixture Study'}).waitFor();
  assert.ok(await page.getByText('Fixture Paper Author · 2025',{exact:true}).isVisible());
  assert.ok(await page.getByText(/Contributed by/).isVisible());
  assert.ok(await page.getByText(/User submitted/).isVisible());
  assert.equal(await page.getByText('Validated protocol',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Helpful',exact:true}).click();
  await page.getByText('1 helpful',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'paper-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:900});
  await page.screenshot({path:join(output,'paper-mobile.png'),fullPage:true});
  await page.getByRole('link',{name:'Fixture Contributor',exact:true}).click();
  await page.waitForURL(origin+'/contributors/'+profile);
  await page.getByRole('heading',{name:'Fixture Contributor'}).waitFor();
  assert.ok(await page.getByText('1 helpful vote received · 1 accepted',{exact:true}).isVisible());
  await page.screenshot({path:join(output,'profile-mobile.png'),fullPage:true});
  await page.goto(origin+'/community');
  await page.getByRole('heading',{name:'Community leaderboard'}).waitFor();
  assert.ok(await page.getByRole('link',{name:'Fixture Study',exact:true}).isVisible());
  await page.getByRole('link',{name:'Contributors',exact:true}).click();
  await page.getByText('1 helpful · 1 accepted',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'leaderboard-mobile.png'),fullPage:true});
  console.log('Existing page checks passed; checking history');
  await context.addCookies([{name:'studio_access',value:'fixture-owner',url:origin,httpOnly:true}]);
  await page.goto(origin+'/contribute');
  const history=page.getByRole('region',{name:'My contributions'});
  await history.getByText('10.0000/fixture',{exact:true}).waitFor();
  assert.equal(await history.getByRole('listitem').count(),25);
  assert.equal(await history.getByText('10.0000/other-private').count(),0);
  await history.getByRole('button',{name:'Next',exact:true}).click();
  await history.getByText('Page 2',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('[aria-labelledby="my-contributions"] li').length===2);
  await page.reload();
  await history.getByText('10.0000/fixture',{exact:true}).waitFor();
  await history.getByRole('listitem').filter({hasText:'10.0000/fixture'}).getByRole('button',{name:'Check status',exact:true}).click();
  await history.getByRole('link',{name:'View your public contribution credit'}).waitFor();
  assert.equal(await history.getByRole('link',{name:'View your public contribution credit'}).getAttribute('href'),'/contributors/'+profile);
  await page.screenshot({path:join(output,'my-contributions-mobile.png'),fullPage:true});
  console.log('History reload, pagination, owned recheck, Local API authorization, concurrent voting, paper attribution, profile and leaderboard passed. Screenshots: '+output);
} finally {
  if (browser) await browser.close();
  if (next) next.kill('SIGTERM');
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve=>upstream.close(resolve)); }
  await db.close();
}
