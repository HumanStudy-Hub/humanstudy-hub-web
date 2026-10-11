'use client';
import { Fragment, useState } from 'react';
import type { HumanProgram, ProgramField, ProgramNode } from '@/lib/studio/human-program';
import { programText } from '@/lib/studio/human-program';
import { conditionSuggestion, fieldText, flowActors, itemSources, presentationPlan, sourceRefs, studyConditions, studyFlow, wordDiff, type Condition, type FlowItem, type SourceRef } from '@/lib/studio/program-view';
import s from './program-views.module.css';

type Props = {
 program:HumanProgram; studyId:string; selectedIds:string[];
 /** Items cited by the passage currently selected in the source. */
 highlightIds?:ReadonlySet<string>; changedIds?:ReadonlySet<string>;
 issuesFor:(id:string)=>string[]; onPick:(id:string,extend:boolean)=>void; onIssue:(issueId:string)=>void;
 onSource:(id:string,source:SourceRef)=>void; onDiscuss?:(id:string,draft?:string)=>void;
};

/** Studies that have a procedure. Analysis-only studies have nothing to draw. */
export function viewStudies(program:HumanProgram){ return program.studies.filter(st=>program.steps.some(step=>step.studyId===st.id)); }

/** The Human Program as one flow that adapts to the experiment: a single line for a simple
 * procedure, side-by-side columns where it branches, swimlanes when several people act, and a
 * container for repetition. Steps open in place; every item links to its source. */
export default function ProgramFlow(props:Props){
 const {program,studyId}=props;
 const conditions=studyConditions(program,studyId),suggestion=conditionSuggestion(program,studyId);
 const plan=presentationPlan(program);
 const [open,setOpen]=useState(()=>new Set(plan.open)),[folded,setFolded]=useState(()=>new Set(plan.collapsed));
 const [focus,setFocus]=useState('');
 const items=studyFlow(program,studyId),actors=flowActors(program,items);
 const design=program.nodes.find(n=>n.kind==='design'&&(!n.studyIds.length||n.studyIds.includes(studyId)))?.id??'';
 const flip=(id:string)=>(prev:Set<string>)=>{const next=new Set(prev);if(next.has(id))next.delete(id);else next.add(id);return next;};
 const ctx:Ctx={...props,conditions,focus,open,folded,lanes:actors.length>=2?actors:[],toggleOpen:id=>setOpen(flip(id)),toggleFold:id=>setFolded(flip(id))};
 return <div className={s.program}>
  {conditions.length>=2&&<div className={s.legend} role="group" aria-label="Conditions"><span className={s.label}>Conditions</span>{conditions.map(c=><button key={c.id} data-tone={c.tone} aria-pressed={focus===c.id} title="Show only this condition's path" onClick={()=>setFocus(focus===c.id?'':c.id)}><i/>{c.label}</button>)}</div>}
  {suggestion&&<p className={s.suggestion}><b>Conditions not stated.</b> Possibly {suggestion.labels.join(' / ')}, from {suggestion.basis}. {props.onDiscuss&&<button onClick={()=>props.onDiscuss!(design,`The program does not state its experimental conditions. They may be ${suggestion.labels.join(', ')} (from ${suggestion.basis}). Check the paper, add a condition node for each, and set conditionIds on the steps and materials that belong to it. Mark anything the paper does not state as missing.`)}>Confirm with agent ↗</button>}</p>}
  <Context {...props}/>
  {!items.length?<div className={s.empty}><p>The participant flow has not been mapped yet.</p>{props.onDiscuss&&<button onClick={()=>props.onDiscuss!(design,'Map the documented participant procedure into explicit steps and next connections. Preserve unknown order and conditions as questions rather than inventing them.')}>Ask agent to map the flow ↗</button>}</div>
  :<>{ctx.lanes.length>0&&<div className={s.laneHeads} style={{gridTemplateColumns:`repeat(${ctx.lanes.length},minmax(0,1fr))`}}>{ctx.lanes.map(a=><button key={a.id} onClick={e=>props.onPick(a.id,e.shiftKey)}>{a.title}</button>)}</div>}
   <Steps items={items} ctx={ctx} top/></>}
 </div>;
}

type Ctx = Props & { conditions:Condition[]; focus:string; open:Set<string>; folded:Set<string>; lanes:ProgramNode[]; toggleOpen:(id:string)=>void; toggleFold:(id:string)=>void };

function Steps({items,ctx,top}:{items:FlowItem[];ctx:Ctx;top?:boolean}){
 const lane=(item:FlowItem)=>Math.max(0,ctx.lanes.findIndex(a=>item.step.actorIds.includes(a.id)));
 return <ol className={s.steps}>{items.map((item,i)=><li key={item.step.id} className={s.item}>
  {i>0&&(item.linked?<span className={s.arrow} aria-label="then"/>:<span className={s.unordered}>order not stated</span>)}
  {top&&ctx.lanes.length?<div className={s.laneRow} style={{gridTemplateColumns:`repeat(${ctx.lanes.length},minmax(0,1fr))`}}><div style={{gridColumn:lane(item)+1}}><Step item={item} ctx={ctx}/></div></div>:<Step item={item} ctx={ctx}/>}
 </li>)}</ol>;
}

function Step({item,ctx}:{item:FlowItem;ctx:Ctx}){
 const {step}=item,id=`flow:${step.id}`,program=ctx.program;
 const isOpen=ctx.open.has(step.id),isFolded=ctx.folded.has(step.id);
 const own=step.conditionIds?.length?ctx.conditions.filter(c=>step.conditionIds!.includes(c.id)):[];
 const offPath=Boolean(ctx.focus&&own.length&&!own.some(c=>c.id===ctx.focus));
 const row=<div className={`${s.row} ${ctx.selectedIds.includes(id)?s.picked:''} ${ctx.highlightIds?.has(id)?s.cited:''} ${ctx.changedIds?.has(id)?s.changed:''}`} data-model-id={id}>
  <button className={s.head} aria-expanded={isOpen} onClick={e=>{ctx.onPick(id,e.shiftKey);if(!e.shiftKey)ctx.toggleOpen(step.id);}}>
   <span className={s.kind} data-kind={step.kind} aria-hidden>{kindMark[step.kind]??'•'}</span>
   <strong>{step.title}</strong>
   {own.map(c=><em key={c.id} className={s.tag} data-tone={c.tone}><i/>{c.label}</em>)}
  </button>
  <Source id={id} refs={itemSources(program,id)} ctx={ctx}/>
  <Issue ids={ctx.issuesFor(id)} ctx={ctx}/>
 </div>;
 const body=isOpen&&<StepDetail item={item} ctx={ctx}/>;
 if(!item.children.length)return <div className={offPath?s.off:''}>{row}{body}</div>;
 return <div className={`${s.container} ${offPath?s.off:''}`} data-kind={step.kind}>
  {row}{body}
  {step.kind==='repeat'&&<p className={s.repeat}>↻ repeats{step.rule&&step.rule.value!==null?` · ${programText(step.rule.value)}`:''}</p>}
  <button className={s.fold} onClick={()=>ctx.toggleFold(step.id)}>{isFolded?`Show ${item.children.length} steps`:'Fold'}</button>
  {!isFolded&&(item.columns?<div className={s.columns} style={{gridTemplateColumns:`repeat(${item.children.length},minmax(0,1fr))`}}>{item.children.map(child=>{
   const cs=ctx.conditions.filter(c=>child.step.conditionIds?.includes(c.id));
   return <div key={child.step.id} className={`${s.column} ${ctx.focus&&cs.length&&!cs.some(c=>c.id===ctx.focus)?s.off:''}`} data-tone={cs[0]?.tone}><Steps items={[child]} ctx={ctx}/></div>;
  })}</div>:<div className={s.nested}><Steps items={item.children} ctx={ctx}/></div>)}
 </div>;
}

/** What a step involves, opened in place. Condition-specific materials sit side by side with
 * their differing words marked, so a manipulation is checked where it happens in the flow. */
function StepDetail({item,ctx}:{item:FlowItem;ctx:Ctx}){
 const {step}=item,program=ctx.program;
 const nodes=(ids:string[])=>ids.map(id=>program.nodes.find(n=>n.id===id)).filter((n):n is ProgramNode=>Boolean(n));
 const specific=(n:ProgramNode)=>Boolean(n.conditionIds?.some(c=>ctx.conditions.some(x=>x.id===c)));
 const seen=nodes(step.visibleIds),used=nodes(step.inputIds.filter(i=>!step.visibleIds.includes(i)));
 const byCondition=ctx.conditions.map(c=>({c,nodes:[...seen,...used].filter(n=>n.conditionIds?.includes(c.id))})).filter(g=>g.nodes.length);
 const records=nodes(step.outputIds);
 return <div className={s.detail}>
  {step.rule&&<FieldRow id={`flow:${step.id}`} field={step.rule} ctx={ctx}/>}
  {byCondition.length>=2&&<div className={s.compare} style={{gridTemplateColumns:`repeat(${byCondition.length},minmax(0,1fr))`}}>{byCondition.map(({c,nodes:list},gi)=>{
   const other=byCondition[gi===0?1:0].nodes;
   return <section key={c.id} data-tone={c.tone} className={ctx.focus&&ctx.focus!==c.id?s.off:''}><header><i/>{c.label}</header>{list.map(n=><div key={n.id} data-model-id={n.id}>
    <NodeChip node={n} ctx={ctx}/>
    {n.fields.map(f=>{const peer=other.flatMap(o=>o.fields).find(x=>x.id===f.id);return <FieldRow key={f.id} id={n.id} field={f} against={peer&&fieldText(peer.value)} ctx={ctx}/>;})}
   </div>)}</section>;
  })}</div>}
  <Chips label="Participant sees" list={seen.filter(n=>!(byCondition.length>=2&&specific(n)))} ctx={ctx}/>
  <Chips label="Uses" list={used.filter(n=>!(byCondition.length>=2&&specific(n)))} ctx={ctx}/>
  {records.length>4?<details className={s.more}><summary>Records · {records.length} measures</summary><Chips label="" list={records} ctx={ctx}/></details>:<Chips label="Records" list={records} ctx={ctx}/>}
  {item.jumps.map(j=><p key={j.to} className={s.jump}>{j.back?'↩ back to':'→ continues to'} <button onClick={e=>ctx.onPick(`flow:${j.to}`,e.shiftKey)}>{j.title}</button>{j.when?` · ${j.when}`:''}</p>)}
  {!step.rule&&!seen.length&&!used.length&&!records.length&&!item.jumps.length&&<p className={s.none}>No rule, materials or records are recorded for this step.</p>}
 </div>;
}

const origins:Partial<Record<ProgramField['origin'],string>>={derived:'derived',researcher:'researcher',implementation:'implementation choice',unknown:'origin unknown'};
function FieldRow({id,field,against,ctx}:{id:string;field:ProgramField;against?:string;ctx:Ctx}){
 const text=field.value===null?'':fieldText(field.value),refs=sourceRefs(ctx.program,field.evidenceIds);
 const unresolved=field.state==='missing'||field.state==='decision';
 return <div className={`${s.field} ${unresolved?s.unresolved:''}`}>
  <span className={s.fieldLabel}>{field.label}{origins[field.origin]&&<em>{origins[field.origin]}</em>}</span>
  <span className={s.fieldValue}>{unresolved&&!text?'Not specified':against!==undefined&&text!==against?wordDiff(text,against).map((p,i)=>p.changed?<mark key={i}>{p.text}</mark>:<Fragment key={i}>{p.text}</Fragment>):text}</span>
  {(field.origin==='verbatim'||field.origin==='reported'||refs.length>0)&&<Source id={id} refs={refs} ctx={ctx}/>}
 </div>;
}

function Chips({label,list,ctx}:{label:string;list:ProgramNode[];ctx:Ctx}){
 if(!list.length)return null;
 return <div className={s.chips}>{label&&<span className={s.label}>{label}</span>}{list.map(n=><NodeChip key={n.id} node={n} ctx={ctx}/>)}</div>;
}
function NodeChip({node,ctx}:{node:ProgramNode;ctx:Props}){
 return <span className={`${s.chip} ${ctx.selectedIds.includes(node.id)?s.picked:''} ${ctx.highlightIds?.has(node.id)?s.cited:''}`} data-model-id={node.id}>
  <button onClick={e=>ctx.onPick(node.id,e.shiftKey)} title={node.summary||node.title}>{node.title}</button>
  <Source id={node.id} refs={itemSources(ctx.program,node.id)} ctx={ctx} compact/>
  <Issue ids={ctx.issuesFor(node.id)} ctx={ctx}/>
 </span>;
}

/** The link back to the paper. Without a cited source the item says so, so it never reads as
 * settled as a stated fact. */
function Source({id,refs,ctx,compact}:{id:string;refs:SourceRef[];ctx:Props;compact?:boolean}){
 const ref=refs[0];
 if(!ref)return <span className={s.unsourced} title="No source is cited for this. Check it with the agent.">{compact?'?':'no source'}</span>;
 const label=ref.page?`p. ${ref.page}`:'file';
 return <button className={`${s.source} ${ref.verified?'':s.unverified}`} title={`${ref.verified?'Open the cited passage':'Cited passage, not yet matched on the page'}${ref.quote?`: “${ref.quote.slice(0,160)}${ref.quote.length>160?'…':''}”`:''}${ref.file?` (${ref.file})`:''}`} onClick={e=>{e.stopPropagation();ctx.onSource(id,ref);}}>{label}{ref.verified?'':'?'}</button>;
}
function Issue({ids,ctx}:{ids:string[];ctx:Props}){
 if(!ids.length)return null;
 return <button className={s.issue} onClick={e=>{e.stopPropagation();ctx.onIssue(ids[0]);}} aria-label={`${ids.length} open ${ids.length===1?'question':'questions'}`} title="Open question">!{ids.length>1?` ${ids.length}`:''}</button>;
}
const kindMark:Record<string,string>={action:'▸',sequence:'⋯',repeat:'↻',branch:'⑂',parallel:'⫴',interaction:'⇄',custom:'◆'};

const groups=[
 {title:'Background & hypotheses',kinds:['background','hypothesis']},
 {title:'Study design',kinds:['design','participants','condition','material','procedure']},
 {title:'Data & findings',kinds:['record','variable','analysis','result']},
];
/** Every non-step node in scope, folded by group. Items the selected passage cites are pulled out next to their group, so the panel does not unfold. */
function Context(props:Props){
 const {program,studyId}=props;
 const scoped=program.nodes.filter(n=>!studyId||!n.studyIds.length||n.studyIds.includes(studyId));
 const known=new Set(groups.flatMap(g=>g.kinds)),other=[...new Set(scoped.filter(n=>!known.has(n.kind)).map(n=>n.kind))];
 const all=[...groups,...(other.length?[{title:'Other details',kinds:other}]:[])].map(g=>({...g,items:scoped.filter(n=>g.kinds.includes(n.kind))})).filter(g=>g.items.length);
 const cited=scoped.filter(n=>props.highlightIds?.has(n.id));
 return <div className={s.context}>{all.map(g=><details key={g.title} className={g.items.some(n=>props.highlightIds?.has(n.id))?s.citedGroup:''}><summary>{g.title}<span>{g.items.length}</span></summary><div>{g.items.map(n=><NodeChip key={n.id} node={n} ctx={props}/>)}</div></details>)}
  {cited.length>0&&<div className={s.citedList}>{cited.map(n=><NodeChip key={n.id} node={n} ctx={props}/>)}</div>}</div>;
}

