import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(file) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module = {exports:{}};
  new Function('module','exports', compiled)(module,module.exports);
  return module.exports;
}
const lib = load('../lib/paper-workspace.ts');
const auth = load('../lib/studio/auth-policy.ts');
const target = {paper:'paper_'+'a'.repeat(24),revision:'b'.repeat(64),intent:'run'};
test('selected paper survives account and email continuation, without widening redirect policy', () => {
  const path = lib.paperWorkspacePath(target);
  const signIn = new URL(lib.paperWorkspaceSignIn(target),'https://humanstudy-hub.com');
  assert.equal(auth.accountReturnTo(signIn.searchParams.get('returnTo')),path);
  assert.equal(auth.emailCallbackReturnTo({returnTo:path},'confirm'),path);
  assert.equal(auth.emailCallbackReturnTo({returnTo:path},'reset'),path);
  assert.equal(auth.accountReturnTo('/try'),'/try');
  for (const value of ['//evil.test/try','/try?paper=x',path+'&redirect=https://evil.test',path+'&paper='+target.paper,path+'#x','/try/../account']) assert.equal(auth.accountReturnTo(value),undefined,value);
});
test('handoff accepts catalog identities, never URLs, commands or incomplete revisions', () => {
  assert.deepEqual(lib.paperWorkspace(target),target);
  for (const patch of [{paper:'https://evil.test/a.pdf'},{paper:['a']},{revision:'HEAD'},{intent:'execute'},{revision:null}]) assert.equal(lib.paperWorkspace({...target,...patch}),null);
});
test('launcher keeps its session token while attaching only the selected catalog identity', () => {
  const url = new URL(lib.workspacePaperUrl('https://workspace.example/?t=secret',target));
  assert.equal(url.searchParams.get('t'),'secret');
  for(const [key,value] of Object.entries(target)) assert.equal(url.searchParams.get(key),value);
  assert.equal(lib.workspacePaperUrl('https://workspace.example/?t=secret',null),'https://workspace.example/?t=secret');
});
