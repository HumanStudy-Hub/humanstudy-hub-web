import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.argv[2]||'playwright');
const root=process.cwd();
const output=process.env.COMMUNITY_PREVIEW_OUTPUT||'/tmp/humanstudy-community-review';
const servers=[];
let browser;
async function start(environment){
  const server=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','0'],{
    cwd:root,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'production',VERCEL_ENV:environment,NEXT_TELEMETRY_DISABLED:'1'},
  });
  servers.push(server);let logs='';
  server.stdout.on('data',data=>logs+=data);server.stderr.on('data',data=>logs+=data);
  for(let i=0;i<100;i++){
    assert.equal(server.exitCode,null,logs);
    const origin=logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if(origin && logs.includes('Ready'))return origin;
    await delay(100);
  }
  throw Error('Server did not start: '+logs);
}
try{
  await mkdir(output,{recursive:true});
  const production=await start('production');
  assert.equal((await fetch(production+'/review/community')).status,404);
  const origin=await start('preview');
  browser=await chromium.launch({headless:true,executablePath:process.argv[3]});
  const context=await browser.newContext();
  const requests=[];
  context.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/community/'))requests.push(request.url());});
  const page=await context.newPage();
  await page.setViewportSize({width:1280,height:1000});
  await page.goto(origin+'/review/community');
  await page.getByRole('heading',{name:'Community UI review',exact:true}).waitFor();
  const section=page.getByRole('region',{name:'Paper credit example'});
  await section.getByRole('button',{name:'Helpful',exact:true}).click();
  await section.getByText('13 helpful',{exact:true}).waitFor();
  await section.getByRole('button',{name:'Remove helpful vote',exact:true}).click();
  await section.getByText('12 helpful',{exact:true}).waitFor();
  const history=page.getByRole('region',{name:'My contributions',exact:true});
  await history.getByRole('button',{name:'Check status',exact:true}).click();
  assert.equal(await history.getByRole('link',{name:'View your public contribution credit'}).getAttribute('href'),'#contributor');
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({path:join(output,'community-review-desktop.png')});
  await page.setViewportSize({width:390,height:900});
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(output,'community-review-mobile.png')});
  // Even a logged-in viewer must keep the example controls entirely local.
  await context.addCookies([{name:'studio_access',value:'example-session-not-a-real-account',url:origin}]);
  await page.reload();
  await section.getByText('12 helpful',{exact:true}).waitFor();
  await section.getByRole('button',{name:'Helpful',exact:true}).click();
  await section.getByText('13 helpful',{exact:true}).waitFor();
  await history.getByRole('button',{name:'Check status',exact:true}).click();
  assert.deepEqual(requests,[],'Example controls must never request the community API');
  console.log('Preview production404, local vote/recheck, reload reset, mobile width and zero community API calls passed. '+output);
}finally{
  if(browser)await browser.close();
  for(const server of servers){
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(3000)]);
    if(server.exitCode===null)server.kill('SIGKILL');
  }
}
