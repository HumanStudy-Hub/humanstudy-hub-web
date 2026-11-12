import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const m={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(new URL('../lib/provider-usage-settlement.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m,m.exports);
const {withProviderUsageSettlement:wrap}=m.exports, enc=new TextEncoder();
const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0.0001234};
const frame=(extra={})=>({id:'gen-test',choices:[{index:0,delta:{content:''},finish_reason:'stop'}],...extra});
const event=x=>'data: '+(typeof x==='string'?x:JSON.stringify(x))+'\n\n';
const good=event(frame({usage}))+event('[DONE]');
function harness(text,{streaming=true,status=200,headers={},split=Infinity,settleResult=true}={}) {
 const bytes=enc.encode(text),parts=[];
 for(let i=0;i<bytes.length;i+=split)parts.push(bytes.slice(i,i+split));
 let index=0;
 const upstream=new Response(new ReadableStream({pull(c){if(index<parts.length)c.enqueue(parts[index++]);else c.close();}}),{status,headers:{'content-type':streaming?'text/event-stream':'application/json',...headers}});
 const calls=[],reports=[],abort=new AbortController();
 const body=wrap(upstream,{streaming,signal:abort.signal,settle:async amount=>{calls.push(amount);return settleResult;},report:o=>reports.push(o)});
 return {body,calls,reports,abort,bytes};
}
test('split UTF8/SSE passes bytes unchanged, repeated final usage settles exactly once',async()=>{
 const text=': keepalive\r\n\r\n'+event(frame({choices:[{index:0,delta:{content:'研究'},finish_reason:null}]})).replaceAll('\n','\r\n')+event(frame({usage}))+event(frame({usage}))+event('[DONE]');
 const h=harness(text,{split:1,headers:{'x-generation-id':'gen-test'}});
 assert.deepEqual(new Uint8Array(await new Response(h.body).arrayBuffer()),h.bytes);
 assert.deepEqual(h.calls,[124]);assert.equal(h.reports[0].state,'settled');
});
test('nonstream complete cost zero settles; length and tool_calls are accounting completion only',async()=>{
 for(const reason of ['stop','length','tool_calls']) {
  const text=JSON.stringify(frame({choices:[{index:0,message:{content:'x'.repeat(100000)},finish_reason:reason}],usage:{...usage,cost:0}}));
  const h=harness(text,{streaming:false,split:8192});assert.equal(await new Response(h.body).text(),text);assert.deepEqual(h.calls,[0]);
 }
});
test('missing, conflicting, malformed or incomplete accounting never refunds',async()=>{
 const variants=[
  event(frame())+event('[DONE]'), event(frame({usage})),
  event(frame({usage:{...usage,cost:'0.1'}}))+event('[DONE]'),
  event(frame({usage:{...usage,cost:-1}}))+event('[DONE]'),
  event(frame({usage}))+event(frame({usage:{...usage,cost:0.2}}))+event('[DONE]'),
  event(frame({usage}))+event(frame({choices:[{index:0,delta:{content:'later'},finish_reason:'stop'}]}))+event('[DONE]'),
  event(frame({usage}))+event('[DONE]')+event('[DONE]'),
  event(frame({usage}))+event({error:{message:'failed'},choices:[{finish_reason:'error'}]})+event('[DONE]'),
  event(frame({choices:[{index:0,delta:{content:'{"usage":{"cost":0}}'},finish_reason:'stop'}]}))+event('[DONE]'),
  event(frame({usage})).slice(0,-2),
 ];
 for(const text of variants){const h=harness(text);assert.equal(await new Response(h.body).text(),text);assert.equal(h.calls.length,0);assert.equal(h.reports[0].state,'retained');}
 for(const options of [{status:500},{headers:{'x-generation-id':'other'}}]){const h=harness(good,options);await new Response(h.body).text();assert.equal(h.calls.length,0);}
});
test('bounded observers retain reservation without clipping huge SSE or JSON',async()=>{
 for(const streaming of [true,false]){
  const value=frame({usage,choices:[{index:0,delta:{content:'x'.repeat(streaming?70000:1100000)},finish_reason:'stop'}]});
  const text=streaming?event(value)+event('[DONE]'):JSON.stringify(value);
  const h=harness(text,{streaming,split:2048});assert.equal(await new Response(h.body).text(),text);assert.equal(h.calls.length,0);assert.match(h.reports[0].reason,/too_large/);
 }
});
test('cancellation and aborted lookahead keep reservations',async()=>{
 let cancelled=false;
 const upstream=new Response(new ReadableStream({start(c){c.enqueue(enc.encode(event(frame({usage}))));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 const calls=[],reports=[],abort=new AbortController();
 const body=wrap(upstream,{streaming:true,signal:abort.signal,settle:async n=>{calls.push(n);return true;},report:r=>reports.push(r)});
 const reader=body.getReader();await reader.read();await reader.cancel();assert.equal(cancelled,true);assert.equal(calls.length,0);assert.equal(reports[0].reason,'cancelled');
 const upstream2=new Response(new ReadableStream({start(c){c.enqueue(enc.encode(good));}}),{headers:{'content-type':'text/event-stream'}});
 const abort2=new AbortController();const r=wrap(upstream2,{streaming:true,signal:abort2.signal,settle:async n=>{calls.push(n);return true;},report:()=>{}}).getReader();
 const reading=r.read();abort2.abort();await reading;assert.equal(calls.length,0);
});
test('terminal lookahead is bounded; previously read bytes survive the following read error',async()=>{
 const hanging=new Response(new ReadableStream({start(c){c.enqueue(enc.encode(good));}}),{headers:{'content-type':'text/event-stream'}});
 const calls=[],reports=[];
 const reader=wrap(hanging,{streaming:true,signal:new AbortController().signal,settle:async n=>{calls.push(n);return true;},report:r=>reports.push(r)}).getReader();
 assert.equal(new TextDecoder().decode((await reader.read()).value),good);await reader.cancel();assert.equal(calls.length,0);assert.equal(reports[0].reason,'terminal_eof_timeout');
 let reads=0;
 const broken=new Response(new ReadableStream({pull(c){if(!reads++)c.enqueue(enc.encode(good));else c.error(new Error('upstream broke'));}}),{headers:{'content-type':'text/event-stream'}});
 const r=wrap(broken,{streaming:true,signal:new AbortController().signal,settle:async n=>{calls.push(n);return true;},report:()=>{}}).getReader();
 assert.equal(new TextDecoder().decode((await r.read()).value),good);await assert.rejects(r.read(),/upstream broke/);assert.equal(calls.length,0);
});
test('overrun or failed settlement does not claim a refund; actual provider cost is passed once',async()=>{
 const h=harness(good,{settleResult:false});assert.equal(await new Response(h.body).text(),good);assert.deepEqual(h.calls,[124]);assert.equal(h.reports[0].state,'retained');assert.match(h.reports[0].reason,/unconfirmed_or_overrun/);
});


test('OpenAI-style empty choices usage and OpenRouter repeated finish frames both settle',async()=>{
 const text=event(frame())+event(frame({choices:[],usage}))+': OPENROUTER PROCESSING\n\n'+event('[DONE]');
 const h=harness(text,{split:7});assert.equal(await new Response(h.body).text(),text);assert.deepEqual(h.calls,[124]);
});
test('redirected or bodyless responses cannot supply authoritative accounting',async()=>{
 const calls=[],reports=[];const upstream=new Response(good,{headers:{'content-type':'text/event-stream'}});
 Object.defineProperty(upstream,'redirected',{value:true});
 const options={streaming:true,signal:new AbortController().signal,settle:async n=>{calls.push(n);return true;},report:r=>reports.push(r)};
 assert.equal(await new Response(wrap(upstream,options)).text(),good);assert.equal(calls.length,0);
 assert.equal(wrap(new Response(null,{status:204}),options),null);assert.equal(reports.at(-1).reason,'missing_response_body');
});
