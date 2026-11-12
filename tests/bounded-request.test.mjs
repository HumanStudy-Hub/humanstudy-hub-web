import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const m={exports:{}};
new Function('exports','module',ts.transpileModule(fs.readFileSync(new URL('../lib/bounded-request.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m);
const {readBoundedText}=m.exports;
test('byte cap preserves exact-boundary ASCII and UTF8 split across chunks',async()=>{
 assert.equal(await readBoundedText(new Request('https://x.test',{method:'POST',body:'x'.repeat(12)}),12),'x'.repeat(12));
 const bytes=new TextEncoder().encode('研究');
 const stream=new ReadableStream({start(c){c.enqueue(bytes.slice(0,2));c.enqueue(bytes.slice(2));c.close();}});
 assert.equal(await readBoundedText(new Request('https://x.test',{method:'POST',body:stream,duplex:'half'}),6),'研究');
});
test('multibyte over-limit cancels unread stream and never returns partial text',async()=>{
 let cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('研究'));},cancel(){cancelled=true;}});
 assert.equal(await readBoundedText(new Request('https://x.test',{method:'POST',body:stream,duplex:'half'}),5),null);
 assert.equal(cancelled,true);
});
