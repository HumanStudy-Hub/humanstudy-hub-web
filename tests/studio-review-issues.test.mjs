import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal=createRequire(import.meta.url);
const ts=requireLocal("typescript");
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
function load(file,dependencies={}){
  const source=fs.readFileSync(path.join(root,file),"utf8");
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const loaded={exports:{}};
  new Function("require","module","exports",compiled)(id=>dependencies[id]??requireLocal(id),loaded,loaded.exports);
  return loaded.exports;
}
const schema=load("app/build-preview/study-schema.ts");
const {modelIssues,prioritizeReviewIssues}=load("app/build-preview/model-review.ts",{"./study-schema":schema});

test("explicit issues retain severity and audit text, ordered by priority then saved response",()=>{
  const issues=[
    {id:"check",title:"Check source",severity:"check",reason:"Verify phrase",impact:"",suggestedAction:""},
    {id:"block",title:"Missing rule",severity:"blocking",reason:"Rule absent",impact:"Cannot run",suggestedAction:"Define it"},
    {id:"choice",title:"Choose",severity:"decision",reason:"Two options",impact:"Changes arm",suggestedAction:"Decide"},
  ];
  const model={...schema.study,id:"other",entities:[],reviewIssues:issues};
  assert.deepEqual(modelIssues(model),issues);
  assert.deepEqual(prioritizeReviewIssues(issues,{}).map(item=>item.id),["block","choice","check"]);
  assert.deepEqual(prioritizeReviewIssues(issues,{block:{text:"Answer",savedAt:new Date().toISOString()}}).map(item=>item.id),["choice","check","block"]);
});

test("explicit review issues do not hide unrelated unresolved fields",()=>{
  const model={...schema.study,id:"mixed",reviewIssues:[
    {id:"allocation",title:"Version allocation",entity:"inputs",field:"Version allocation",severity:"blocking",reason:"Unspecified",impact:"Cannot assign",suggestedAction:"Decide"},
  ]};
  const issues=modelIssues(model);
  assert.equal(issues.filter(item=>item.title==="Version allocation").length,1);
  assert.ok(issues.some(item=>item.title==="Execution contract"&&item.severity==="check"));
});

test("legacy unresolved fields remain reviewable without invented audit impact",()=>{
  const model={...schema.study,id:"legacy"};
  const issue=modelIssues(model).find(item=>item.title==="Version allocation");
  assert.equal(issue?.severity,"check");
  assert.equal(issue?.impact,"");
  assert.equal(issue?.suggestedAction,"");
});
