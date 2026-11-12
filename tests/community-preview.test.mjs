import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const deps = {
  'next/link': {default: ({children,...props})=>React.createElement('a',props,children)},
  'next/navigation': {notFound:()=>{throw Error('not-found');}},
  '@/components/folio-page.module.css': {default: {}},
};
function load(file) {
  const output=ts.transpileModule(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const m={exports:{}};
  new Function('require','module','exports',output)(name=>{
    if(deps[name])return deps[name];
    if(name.startsWith('@/components/'))return load(name.replace('@/','')+'.tsx');
    if(name.startsWith('./'))return load('components/'+name.slice(2)+'.tsx');
    return require(name);
  },m,m.exports);
  return m.exports;
}
test('community review exists only on preview deployments and uses explicit no-save controls',()=>{
  const page=load('app/review/community/page.tsx').default;
  const previous=process.env.VERCEL_ENV;
  try {
    for(const env of ['production','development','']){
      process.env.VERCEL_ENV=env;assert.throws(()=>page(),/not-found/);
    }
    process.env.VERCEL_ENV='preview';
    const html=renderToStaticMarkup(page());
    assert.match(html,/Example data/);assert.match(html,/nothing is saved or submitted/);
    assert.match(html,/Helpful/);assert.match(html,/My contributions/);assert.match(html,/User submitted/);
    assert.doesNotMatch(html,/Community leaderboard|View accepted revision|href="\/contributors\/example/);
    for(const href of ['/blog','/studies','/contribute'])assert.ok(html.includes('href="'+href+'"'));
  }finally{if(previous===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous;}
});
