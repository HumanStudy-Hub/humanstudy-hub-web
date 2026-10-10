import type { HumanProgram, JsonValue, ProgramField, ProgramNode, ProgramStep } from './human-program';
import { programText } from './human-program';

/** Display structure derived from a Human Program. Nothing here is a scientific claim:
 * the views only rearrange program objects, and every displayed value is read from a field.
 * An agent may author `extensions.presentation` to state conditions and screens explicitly;
 * without it, conditions and screens are inferred conservatively from the program. */

export type Arm = { id:string; label:string; nodeIds:string[]; studyId?:string; tone:number; source:'agent'|'design'|'study' };
export type FlowItem = { step:ProgramStep; children:FlowItem[]; lanes:{arm:Arm;nodeIds:string[]}[]; shared:string[]; splits:boolean };
export type ScreenBlock =
 | { type:'text'; nodeId:string; fieldId:string; text:string; origin:ProgramField['origin'] }
 | { type:'question'; nodeId:string; fieldId:string; text:string; options:string[]; scale:boolean; origin:ProgramField['origin'] }
 | { type:'gap'; text:string; issueId?:string }
 | { type:'records'; nodeIds:string[] };
export type Screen = { step:ProgramStep; depth:number; blocks:ScreenBlock[]; continues:boolean };
export type CompareRow = { key:string; group:string; label:string; cells:{armId:string;text:string;nodeId?:string}[]; same:boolean };

type PresentationBlock = { node?:string; field?:string; item?:number; gap?:string };
export type ProgramPresentation = {
 conditions?:{ id:string; label:string; studyIds?:string[]; nodeIds:string[] }[];
 screens?:{ stepId:string; blocks:PresentationBlock[] }[];
};

const isRecord=(v:unknown):v is Record<string,JsonValue>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const tokens=(s:string)=>s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const inStudy=(n:{studyIds:string[]},studyId:string)=>!n.studyIds.length||n.studyIds.includes(studyId);

export function presentation(program:HumanProgram):ProgramPresentation {
 const raw=program.extensions?.presentation;
 if(!isRecord(raw))return {};
 const nodes=new Set(program.nodes.map(n=>n.id)),steps=new Set(program.steps.map(s=>s.id));
 const strings=(v:JsonValue|undefined)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'):[];
 const conditions=Array.isArray(raw.conditions)?raw.conditions.filter(isRecord).filter(c=>typeof c.id==='string'&&typeof c.label==='string').map(c=>({id:c.id as string,label:c.label as string,studyIds:strings(c.studyIds),nodeIds:strings(c.nodeIds).filter(id=>nodes.has(id))})):undefined;
 const screens=Array.isArray(raw.screens)?raw.screens.filter(isRecord).filter(s=>typeof s.stepId==='string'&&steps.has(s.stepId)).map(s=>({stepId:s.stepId as string,blocks:(Array.isArray(s.blocks)?s.blocks:[]).filter(isRecord).map(b=>({...(typeof b.node==='string'?{node:b.node}:{}),...(typeof b.field==='string'?{field:b.field}:{}),...(typeof b.item==='number'?{item:b.item}:{}),...(typeof b.gap==='string'?{gap:b.gap}:{})}))})):undefined;
 return {...(conditions?.length?{conditions}:{}),...(screens?.length?{screens}:{})};
}

/** Between-condition arms of one study. Agent-declared conditions win; otherwise the arms come
 * from a design/manipulation field listing condition labels, matched to nodes by name. */
export function conditionArms(program:HumanProgram,studyId:string):Arm[] {
 const declared=presentation(program).conditions;
 if(declared)return declared.filter(c=>!c.studyIds?.length||c.studyIds.includes(studyId)).map((c,tone)=>({id:c.id,label:c.label,nodeIds:c.nodeIds.filter(id=>{const n=program.nodes.find(n=>n.id===id);return n&&inStudy(n,studyId);}),studyId,tone,source:'agent'}));
 const listed=program.nodes.filter(n=>inStudy(n,studyId)&&(n.kind==='design'||n.kind==='variable')).flatMap(n=>n.fields.filter(f=>Array.isArray(f.value)&&(/condition|arm|treatment|level/i.test(`${f.id} ${f.label}`)||n.kind==='variable'&&n.fields.some(r=>r.id==='role'&&/manipulat/i.test(programText(r.value))))).map(f=>(f.value as JsonValue[]).filter((v):v is string=>typeof v==='string')))
  .find(labels=>labels.length>=2&&labels.length<=8);
 if(!listed)return [];
 const specific=program.nodes.filter(n=>inStudy(n,studyId)&&!['design','variable','background','hypothesis','analysis','result'].includes(n.kind));
 return listed.map((label,tone)=>({id:label,label,studyId,tone,source:'design' as const,nodeIds:specific.filter(n=>{const words=new Set([...tokens(n.id),...tokens(n.title)]);return tokens(label).every(t=>words.has(t));}).map(n=>n.id)}));
}

/** Columns for the comparison view: conditions within a study, or sibling studies. */
export function studyArms(program:HumanProgram):Arm[] {
 return program.studies.filter(s=>s.type!=='analysis'&&program.steps.some(step=>step.studyId===s.id)).map((s,tone)=>({id:s.id,label:s.title,studyId:s.id,tone,source:'study' as const,nodeIds:program.nodes.filter(n=>n.studyIds.length===1&&n.studyIds[0]===s.id).map(n=>n.id)}));
}

/** Top-level execution order: roots first, then `next` edges breadth-first. Nested steps stay under their container. */
export function studyFlow(program:HumanProgram,studyId:string,arms:Arm[]=conditionArms(program,studyId)):FlowItem[] {
 const steps=program.steps.filter(s=>s.studyId===studyId),byId=new Map(steps.map(s=>[s.id,s]));
 const nested=new Set(steps.flatMap(s=>s.children)),targets=new Set(steps.flatMap(s=>s.next.map(e=>e.to)));
 const top=steps.filter(s=>!nested.has(s.id)),order:ProgramStep[]=[],seen=new Set<string>();
 const queue=[...top.filter(s=>!targets.has(s.id)),...top];
 while(queue.length){const s=queue.shift()!;if(seen.has(s.id)||nested.has(s.id))continue;seen.add(s.id);order.push(s);queue.unshift(...s.next.map(e=>byId.get(e.to)).filter((x):x is ProgramStep=>Boolean(x)));}
 const armNodes=new Set(arms.flatMap(a=>a.nodeIds));
 const manipulations=new Set(program.nodes.filter(n=>n.kind==='variable'&&n.fields.some(f=>f.id==='role'&&/manipulat/i.test(programText(f.value)))).map(n=>n.id));
 const item=(step:ProgramStep,path:Set<string>):FlowItem=>{
  const shown=[...new Set([...step.inputIds,...step.visibleIds])];
  const lanes=arms.map(arm=>({arm,nodeIds:shown.filter(id=>arm.nodeIds.includes(id))}));
  return {step,lanes:lanes.filter(l=>l.nodeIds.length).length>=2?lanes:[],shared:shown.filter(id=>!armNodes.has(id)&&!manipulations.has(id)),splits:arms.length>=2&&step.outputIds.some(id=>manipulations.has(id)),
   children:step.children.filter(id=>!path.has(id)).map(id=>byId.get(id)).filter((x):x is ProgramStep=>Boolean(x)).map(child=>item(child,new Set([...path,step.id])))};
 };
 return order.map(step=>item(step,new Set([step.id])));
}
export function flatFlow(items:FlowItem[],depth=0):{item:FlowItem;depth:number}[] { return items.flatMap(item=>[{item,depth},...flatFlow(item.children,depth+1)]); }

/** Actors in order of first appearance; two or more means the flow is drawn as swimlanes. */
export function flowActors(program:HumanProgram,items:FlowItem[]):ProgramNode[] {
 const ids=[...new Set(flatFlow(items).flatMap(({item})=>item.step.actorIds))];
 return ids.map(id=>program.nodes.find(n=>n.id===id)).filter((n):n is ProgramNode=>Boolean(n));
}

const questionOf=(v:JsonValue)=>isRecord(v)&&typeof v.question==='string'?{text:v.question,options:Array.isArray(v.options)?v.options.map(o=>programText(o)):[]}:null;
const isScale=(options:string[])=>options.length>=3&&options.every(o=>/^-?\d+$/.test(o.trim()));
function blocksFor(node:ProgramNode,field:ProgramField,item?:number):ScreenBlock[] {
 const values=Array.isArray(field.value)?field.value:[field.value];
 const picked=item===undefined?values:values[item]===undefined?[]:[values[item]];
 return picked.flatMap((v):ScreenBlock[]=>{
  const q=questionOf(v);
  if(q)return [{type:'question',nodeId:node.id,fieldId:field.id,text:q.text,options:q.options,scale:isScale(q.options),origin:field.origin}];
  if(typeof v==='string'&&v.trim()&&field.origin==='verbatim')return [{type:'text',nodeId:node.id,fieldId:field.id,text:v,origin:field.origin}];
  return [];
 });
}

/** What one participant in `arm` sees, step by step. Only verbatim text and transcribed
 * questions are shown; unresolved step rules become visible gaps, never filler text. */
export function studyScreens(program:HumanProgram,studyId:string,arm?:Arm):Screen[] {
 const arms=conditionArms(program,studyId),flow=flatFlow(studyFlow(program,studyId,arms));
 const authored=new Map((presentation(program).screens??[]).map(s=>[s.stepId,s.blocks]));
 const otherArms=new Set(arms.filter(a=>a.id!==arm?.id).flatMap(a=>a.nodeIds));
 const nodes=new Map(program.nodes.map(n=>[n.id,n])),shown=new Set<string>();
 return flow.map(({item,depth})=>{
  const step=item.step,visible=[...new Set([...step.visibleIds,...step.inputIds])].filter(id=>!otherArms.has(id)).map(id=>nodes.get(id)).filter((n):n is ProgramNode=>Boolean(n));
  const blocks:ScreenBlock[]=[];
  const spec=authored.get(step.id);
  if(spec)for(const b of spec){
   if(b.gap){const issue=program.issues.find(i=>i.id===b.gap);blocks.push({type:'gap',text:issue?.title??b.gap,...(issue?{issueId:issue.id}:{})});continue;}
   // A field reference without a node resolves against this arm's visible nodes, so one spec serves every condition.
   const candidates=b.node?[nodes.get(b.node)].filter((n):n is ProgramNode=>Boolean(n)):visible;
   for(const n of candidates){const f=n.fields.find(f=>f.id===b.field);if(f){blocks.push(...blocksFor(n,f,b.item));break;}}
  }
  else for(const n of visible)for(const f of n.fields){const key=`${n.id}.${f.id}`;if(shown.has(key))continue;const next=blocksFor(n,f);if(next.length){shown.add(key);blocks.push(...next);}}
  if(step.rule&&['missing','decision'].includes(step.rule.state)){const issue=program.issues.find(i=>i.stepId===step.id);blocks.push({type:'gap',text:`${step.rule.label}: ${issue?.title??'not reported'}`,...(issue?{issueId:issue.id}:{})});}
  const records=step.outputIds.filter(id=>nodes.get(id)?.kind==='variable'||nodes.get(id)?.kind==='record');
  if(records.length)blocks.push({type:'records',nodeIds:records});
  return {step,depth,blocks,continues:!spec&&!blocks.some(b=>b.type==='text'||b.type==='question')&&visible.length>0};
 });
}

const baseTitle=(n:ProgramNode,arm:Arm)=>{const drop=new Set(tokens(arm.label));const words=n.title.split(/(\s*[·:—-]\s*|\s+)/).filter(w=>w.trim()&&!/^[·:—-]$/.test(w.trim())&&!(tokens(w).length&&tokens(w).every(t=>drop.has(t))));return words.join(' ').trim()||n.kind;};
/** Structured values read as indented `key: value` lines rather than JSON, so a diff marks words, not punctuation. */
export function plainText(v:JsonValue,indent=''):string {
 if(v===null)return `${indent}—`;
 if(Array.isArray(v))return v.map(item=>isRecord(item)||Array.isArray(item)?`${indent}•\n${plainText(item,indent+'  ')}`:`${indent}• ${programText(item)}`).join('\n');
 if(isRecord(v))return Object.entries(v).map(([k,item])=>item!==null&&typeof item==='object'?`${indent}${k.replace(/_/g,' ')}:\n${plainText(item,indent+'  ')}`:`${indent}${k.replace(/_/g,' ')}: ${programText(item)}`).join('\n');
 return `${indent}${programText(v)}`;
}
const cellText=(v:JsonValue)=>{const q=questionOf(v);return q?[q.text,q.options.length?`[${q.options.join(' / ')}]`:''].filter(Boolean).join(' '):plainText(v);};

/** Aligned facts per arm. Identical rows collapse, so the reader sees what actually differs. */
export function compareRows(program:HumanProgram,arms:Arm[]):CompareRow[] {
 const rows=new Map<string,CompareRow>();
 const put=(key:string,group:string,label:string,armId:string,text:string,nodeId?:string)=>{const row=rows.get(key)??{key,group,label,cells:[],same:false};row.cells.push({armId,text,...(nodeId?{nodeId}:{})});rows.set(key,row);};
 const names=(ids:string[])=>ids.map(id=>program.nodes.find(n=>n.id===id)?.title??id).join(', ');
 for(const arm of arms){
  const studyId=arm.studyId??program.studies[0]?.id;
  if(studyId)flatFlow(studyFlow(program,studyId)).forEach(({item},i)=>put(`step:${i}`,'Procedure',`Step ${i+1}`,arm.id,[item.step.title,item.step.actorIds.length?`by ${names(item.step.actorIds)}`:'',item.step.rule&&item.step.rule.value!==null?`${item.step.rule.label}: ${programText(item.step.rule.value)}`:''].filter(Boolean).join(' · '),`flow:${item.step.id}`));
  for(const id of arm.nodeIds){
   const n=program.nodes.find(n=>n.id===id);if(!n)continue;
   const base=baseTitle(n,arm);
   for(const f of n.fields){
    if(Array.isArray(f.value)&&f.value.length&&f.value.every(v=>questionOf(v)))f.value.forEach((v,i)=>put(`${n.kind}:${base}:${f.id}:${i}`,base,`${f.label} ${i+1}`,arm.id,cellText(v),n.id));
    else put(`${n.kind}:${base}:${f.id}`,base,f.label,arm.id,cellText(f.value),n.id);
   }
  }
 }
 return [...rows.values()].map(row=>({...row,same:row.cells.length===arms.length&&row.cells.every(c=>c.text===row.cells[0].text)}));
}

/** Word-level diff against a reference text, marking the words that are not shared.
 * Long texts fall back to whole lines. When most of a text differs nothing is marked:
 * highlighting everything carries no information. */
export function wordDiff(text:string,reference:string):{text:string;changed:boolean}[] {
 const words=(v:string)=>v.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)??[],lines=(v:string)=>v.match(/[^\n]*\n|[^\n]+$/g)??[];
 let a=words(text),b=words(reference);
 if(a.length*b.length>250_000){a=lines(text);b=lines(reference);}
 if(a.length*b.length>250_000)return [{text,changed:false}];
 const lcs=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)lcs[i][j]=a[i]===b[j]?lcs[i+1][j+1]+1:Math.max(lcs[i+1][j],lcs[i][j+1]);
 const out:{text:string;changed:boolean}[]=[];let i=0,j=0;
 // Whitespace is never marked, so a highlight hugs the changed words.
 const push=(t:string,changed:boolean)=>{const mark=changed&&Boolean(t.trim()),last=out.at(-1);if(last&&last.changed===mark)last.text+=t;else out.push({text:t,changed:mark});};
 while(i<a.length){if(j<b.length&&a[i]===b[j]){push(a[i],false);i++;j++;}else if(j<b.length&&lcs[i][j+1]>=lcs[i+1][j])j++;else{push(a[i],true);i++;}}
 const count=(v:string)=>v.split(/\s+/).filter(Boolean).length,marked=out.filter(p=>p.changed).reduce((n,p)=>n+count(p.text),0);
 if(marked/Math.max(1,count(text))>0.6)return [{text,changed:false}];
 return out;
}
