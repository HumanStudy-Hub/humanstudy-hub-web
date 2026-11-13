import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Execute the actual launcher handlers/effects with deterministic hooks and timers.
// This does not contact the provider or render a substitute implementation.
function fixture(states) {
  const slots = []; let index = 0; let effects = []; const timers = []; const calls = [];
  const React = {
    useState(initial) { const i=index++; if (!(i in slots)) slots[i]=initial; return [slots[i], next=>{ slots[i]=typeof next==='function'?next(slots[i]):next; }]; },
    useRef(initial) { const i=index++; if (!(i in slots)) slots[i]={current:initial}; return slots[i]; },
    useEffect(fn) { effects.push(fn); },
  };
  const jsx = (type, props) => ({type,props});
  const loaded = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../app/try/launcher.tsx',import.meta.url),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const fetch = async (_, options={}) => {
    calls.push(options.method || 'GET');
    return {ok:true,status:200,json:async()=>options.method==='DELETE'?{pending:false}:{status:states.shift() || 'transition'}};
  };
  new Function('require','module','exports','fetch','setTimeout','clearTimeout',code)(name=>{
    if(name==='react')return React;
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='next/link')return {default:'a'};
    if(name.includes('paper-workspace'))return {};
    if(name.endsWith('.css'))return {default:{}};
    throw Error(name);
  },loaded,loaded.exports,fetch,fn=>{timers.push(fn);return fn;},fn=>{const i=timers.indexOf(fn);if(i>=0)timers.splice(i,1);});
  const render=()=>{index=0;effects=[];return loaded.exports.default({needsCode:false,sessionMinutes:45});};
  const button=(tree,label)=>{
    if(!tree||typeof tree!=='object')return null;
    if(tree.type==='button'&&tree.props.children===label)return tree;
    return [tree.props?.children].flat(Infinity).map(x=>button(x,label)).find(Boolean);
  };
  return {render,button,calls,timers,slots,effects:()=>effects};
}

test('DELETE success waits for confirmed stop, polls without repeating DELETE, and then enables resume', async()=>{
  const f=fixture(['running','transition','transition','stopped']);
  f.render(); f.effects()[0](); await tick();
  await f.button(f.render(),'Stop workspace').props.onClick(); await tick();
  assert.equal(f.slots[3],'saving');
  f.render(); const cleanup=f.effects()[1](); await tick();
  assert.equal(f.slots[3],'saving');
  await f.timers.shift()(); await tick();
  await f.timers.shift()(); await tick();
  assert.equal(f.slots[3],'idle'); assert.equal(f.slots[2],'stopped');
  assert.ok(f.button(f.render(),'Resume workspace'));
  assert.equal(f.calls.filter(x=>x==='DELETE').length,1);
  cleanup();
});

test('slow stop ends bounded polling with manual status available and no false stopped claim', async()=>{
  const f=fixture(['running']);f.render();f.effects()[0]();await tick();
  await f.button(f.render(),'Stop workspace').props.onClick();await tick();
  f.render();const cleanup=f.effects()[1]();await tick();
  for(let i=0;i<17;i++){await f.timers.shift()();await tick();}
  assert.equal(f.timers.length,0);assert.equal(f.slots[3],'idle');assert.equal(f.slots[2],'transition');
  assert.match(f.slots[5],/taking longer/);assert.ok(f.button(f.render(),'Check status'));
  assert.equal(f.calls.filter(x=>x==='DELETE').length,1);cleanup();
});

test('leaving the launcher cancels scheduled stop-status checks', async()=>{
  const f=fixture(['running']);f.render();f.effects()[0]();await tick();
  await f.button(f.render(),'Stop workspace').props.onClick();await tick();
  f.render();const cleanup=f.effects()[1]();await tick();assert.equal(f.timers.length,1);
  cleanup();assert.equal(f.timers.length,0);
});
