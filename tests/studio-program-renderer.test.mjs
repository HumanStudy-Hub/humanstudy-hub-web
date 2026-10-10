import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(file,deps={}){const js=ts.transpileModule(fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;const m={exports:{}};new Function('require','module','exports',js)(id=>deps[id]??require(id),m,m.exports);return m.exports;}
const contract=JSON.parse(fs.readFileSync(new URL('../lib/studio/human-program.schema.json',import.meta.url),'utf8'));
const hp=load('lib/studio/human-program.ts',{'./human-program.schema.json':contract});
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/human-program-v2.json',import.meta.url),'utf8'));
const sample=id=>structuredClone(fixtures.cases.find(c=>c.id===id).program);
const css={default:new Proxy({},{get:(_,key)=>String(key)})};
const details=load('components/studio/program-details.tsx',{'@/lib/studio/human-program':hp,'./program-details.module.css':css}).default;
const schema=load('app/build-preview/study-schema.ts'),review=load('app/build-preview/model-review.ts',{'./study-schema':schema}),diff=load('lib/studio/model-diff.ts'),ui=load('app/build-preview/ui.tsx');
const modelView=load('app/build-preview/study-model.tsx',{'./study-schema':schema,'./model-review':review,'./study-model.module.css':css,'./ui':ui,'@/components/studio/program-details':{default:details},'@/lib/studio/human-program':hp,'@/lib/studio/model-diff':diff,'@/components/studio/materials':{default:()=>null}}).default;
const noop=()=>{};
test('actual React renderer shows scoped study choices and repeat/interaction objects',()=>{
 const p=sample('study_012'),model=hp.projectHumanProgram(p);
 const html=renderToStaticMarkup(React.createElement(modelView,{model,selected:'',anchor:null,responses:{},onSelect:noop,onSource:noop,onDiscuss:noop,onRespond:noop}));
 assert.doesNotMatch(html,/Circle to ask|aria-label="Circle"|Circle selection/);assert.match(html,/Study scope/);assert.match(html,/No History Treatment/);assert.match(html,/Social History Treatment/);assert.match(html,/Send money/);assert.match(html,/Return money/);
 const game=hp.projectHumanProgram(sample('study_009'));
 const gameHtml=renderToStaticMarkup(React.createElement(modelView,{model:game,selected:'',anchor:null,responses:{},onSelect:noop,onSource:noop,onDiscuss:noop,onRespond:noop}));
 assert.match(gameHtml,/Four rounds/);assert.match(gameHtml,/repeat/);assert.match(gameHtml,/Submit a number/);
});
test('typed extension contents render and Comment delivers a stable field reference',()=>{
 const p=sample('exploratory-extension');let anchor;
 const tree=details({program:p,id:'coding',onDiscuss:value=>anchor=value,onInspect:noop,onSource:noop});
 const walk=element=>{if(!element||typeof element!=='object')return; if(element.props?.['aria-label']==='Comment on Categories')element.props.onClick();React.Children.forEach(element.props?.children,walk);};walk(tree);
 assert.deepEqual(anchor,{kind:'objects',entityIds:['coding'],fieldId:'categories'});
 const html=renderToStaticMarkup(tree);assert.match(html,/multipleCodes/);assert.match(html,/uncertainty/);assert.match(html,/agency/);
});

test('locating long evidence sends a bounded source selection while retaining the original quote',()=>{
 const p=sample('exploratory-extension');p.evidence=[{id:'e1',sourceId:'paper',locator:{page:1},quote:'🧪'.repeat(9000),verification:'verified'}];p.nodes[0].fields[0].evidenceIds=['e1'];let evidence;
 const tree=details({program:p,id:'coding',onDiscuss:noop,onInspect:noop,onSource:(_,e)=>evidence=e});
 const walk=element=>{if(!element||typeof element!=='object')return;if(element.props?.['aria-label']==='Locate evidence for Categories')element.props.onClick();React.Children.forEach(element.props?.children,walk);};walk(tree);
 assert.equal([...evidence.quote].length,8000);assert.equal([...p.evidence[0].quote].length,9000);
});
