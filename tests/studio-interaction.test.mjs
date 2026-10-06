import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const requireLocal=createRequire(import.meta.url),ts=requireLocal('typescript'),React=requireLocal('react');
const {renderToStaticMarkup}=requireLocal('react-dom/server');
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 const compiled=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const loadedModule={exports:{}};
 new Function('require','module','exports',compiled)(id=>{
  if(id.endsWith('.css'))return new Proxy({},{get:(_,key)=>key});
  if(id==='@/app/build-preview/ui')return {useT:()=>text=>text};
  if(id.startsWith('@/')||id.startsWith('.')){
   const base=id.startsWith('@/')?id.slice(2):path.join(path.dirname(file),id);
   const target=['.ts','.tsx'].map(extension=>base+extension).find(candidate=>fs.existsSync(path.join(root,candidate)));
   return load(target);
  }
  return requireLocal(id);
 },loadedModule,loadedModule.exports);
 cache.set(file,loadedModule.exports);return loadedModule.exports;
}
const ReviewGuide=load('components/studio/review-guide.tsx').default;
const ProposalCard=load('components/studio/proposal-card.tsx').default;
const noop=()=>{};
test('the decision guide presents one unanswered blocking item and distinguishes saved answers from applied changes',()=>{
 const issues=[{id:'check',title:'Check units',severity:'check',reason:'Verify units'}, {id:'decision',title:'Choose allocation',severity:'decision',reason:'Choose rule'}, {id:'blocking',title:'Missing assignment rule',severity:'blocking',reason:'No source rule'}];
 const props={issues,responses:{},onDiscuss:noop,onAnswer:noop,onSource:noop};
 const first=renderToStaticMarkup(React.createElement(ReviewGuide,props));
 assert.equal((first.match(/>Give a decision</g)||[]).length,1);
 assert.match(first,/<strong>Missing assignment rule<\/strong>/);
 const saved=renderToStaticMarkup(React.createElement(ReviewGuide,{...props,responses:Object.fromEntries(issues.map(issue=>[issue.id,{text:'Saved answer',savedAt:'2026-10-06'}]))}));
 assert.match(saved,/Answers saved · awaiting changes/);
 assert.match(saved,/before they become part of the study/);
 assert.doesNotMatch(saved,/All review questions answered/);
});
test('proposal review shows changed objects rather than repeating an entire study',()=>{
 const entity=id=>({id,kind:'procedure',title:id,subtitle:'',description:'Stable',fields:[],evidence:{page:1,rects:[],quote:''},x:0,y:0,w:1,h:1});
 const model={id:'study',title:'Study',source:{title:'',authors:'',filename:''},entities:[entity('Affected flow'),entity('Untouched object')],relations:[],procedure:[],variables:[]};
 const next={...model,entities:model.entities.map(item=>item.id==='Affected flow'?{...item,description:'Adds a control condition'}:item)};
 const html=renderToStaticMarkup(React.createElement(ProposalCard,{proposal:{id:'proposal',model:next,summary:'Add a control condition',status:'pending'},model,previewing:false,onPreview:noop,onDecision:noop,onDiscuss:noop}));
 assert.match(html,/Affected flow/);
 assert.match(html,/Adds a control condition/);
 assert.doesNotMatch(html,/Untouched object/);
 assert.match(html,/Preview changes/);
 assert.match(html,/Accept changes/);
});
