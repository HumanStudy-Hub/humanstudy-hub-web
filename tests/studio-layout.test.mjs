import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compiled=ts.transpileModule(fs.readFileSync(new URL('../lib/studio/panel-layout.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const loaded={exports:{}};
new Function('module','exports',compiled)(loaded,loaded.exports);
const {resizePanePair,validPaneWeights,defaultPaneWeights}=loaded.exports;

test('resizing a visible pair preserves its combined share and leaves the third panel alone',()=>{
 const next=resizePanePair(defaultPaneWeights,'agent','model',280,600,120);
 assert.equal(next.source,defaultPaneWeights.source);
 assert.ok(Math.abs(next.agent+next.model-defaultPaneWeights.agent-defaultPaneWeights.model)<1e-9);
 assert.ok(Math.abs(next.agent/(next.agent+next.model)-400/880)<1e-9);
});
test('panel widths remain reachable at both drag extremes and in a tight viewport',()=>{
 for(const delta of [-10000,10000]){
  const next=resizePanePair(defaultPaneWeights,'source','model',400,500,delta);
  const share=next.source+next.model;
  assert.ok(next.source/share*900>=239.999);
  assert.ok(next.model/share*900>=239.999);
 }
 const tight=resizePanePair(defaultPaneWeights,'agent','source',150,180,500);
 assert.equal(tight.agent,tight.source);
});
test('saved layout rejects invalid or zero panel weights',()=>{
 assert.equal(validPaneWeights(defaultPaneWeights),true);
 for(const input of [null,{}, {...defaultPaneWeights,model:0},{...defaultPaneWeights,source:Infinity},{...defaultPaneWeights,agent:'1'}])assert.equal(validPaneWeights(input),false);
});
