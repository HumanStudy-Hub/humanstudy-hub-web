'use client';
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { HumanProgram, ProgramNode } from '@/lib/studio/human-program';
import { programText } from '@/lib/studio/human-program';
import { compareRows, conditionArms, flatFlow, flowActors, presentation, studyArms, studyFlow, studyScreens, wordDiff, type Arm, type FlowItem, type ScreenBlock } from '@/lib/studio/program-view';
import { programGraph } from '@/lib/studio/program-views';
import { ContextGroups, Diagram } from './program-visuals';
import s from './program-views.module.css';

export type ProgramViewKind = 'flow'|'compare'|'screens';
type Props = {
 program:HumanProgram; view:ProgramViewKind; studyId:string; selectedIds:string[];
 issuesFor:(id:string)=>string[]; onPick:(id:string,extend:boolean)=>void; onIssue:(issueId:string)=>void;
 changedIds?:ReadonlySet<string>; onDiscuss?:(id:string,draft?:string)=>void;
};
const designOf=(program:HumanProgram,studyId:string)=>program.nodes.find(n=>n.kind==='design'&&(!n.studyIds.length||n.studyIds.includes(studyId)))?.id??program.nodes[0]?.id??'';

/** Studies that have a procedure come first; analysis-only studies have nothing to draw. */
export function viewStudies(program:HumanProgram){ return program.studies.filter(st=>program.steps.some(step=>step.studyId===st.id)); }

export default function ProgramViews(props:Props){
 const {program,view,studyId}=props;
 const arms=useMemo(()=>conditionArms(program,studyId),[program,studyId]);
 const [focusArm,setFocusArm]=useState('');
 const arm=arms.find(a=>a.id===focusArm);
 const hasSteps=program.steps.some(step=>step.studyId===studyId);
 if(!hasSteps&&view!=='compare')return <div className={s.views}><ContextGroups program={program} studyId={studyId||undefined} selectedIds={props.selectedIds} issueIds={new Set(program.nodes.map(n=>n.id).filter(id=>props.issuesFor(id).length))} onPick={(id,extend)=>props.onPick(id,Boolean(extend))}/><div className={s.empty}><p>The participant flow has not been mapped yet.</p>{props.onDiscuss&&<button onClick={()=>props.onDiscuss!(designOf(program,studyId),'Map the documented participant procedure into explicit steps and connections. Preserve unknown order and conditions as questions rather than inventing them.')}>Ask agent to map the flow ↗</button>}</div></div>;
 return <div className={s.views}>
  {arms.length>=2&&view!=='compare'&&<div className={s.armBar} role="group" aria-label="Conditions">
   <span className={s.barLabel}>{view==='screens'?'Show as':'Conditions'}</span>
   {view==='flow'&&<button aria-pressed={!arm} onClick={()=>setFocusArm('')}>All</button>}
   {arms.map(a=><button key={a.id} className={s.armChip} data-tone={a.tone} aria-pressed={view==='screens'?(arm??arms[0]).id===a.id:arm?.id===a.id} onClick={()=>setFocusArm(view==='flow'&&focusArm===a.id?'':a.id)}><i/>{a.label}</button>)}
   {arms[0].source==='design'&&props.onDiscuss?<button className={s.provenance} title="Inferred from condition labels in the design fields, not from the procedure" onClick={()=>props.onDiscuss!(designOf(program,studyId),`These conditions were inferred from the design fields: ${arms.map(a=>a.label).join(', ')}. Check them against the paper and map each condition to its steps and materials explicitly; flag anything the paper does not state.`)}>inferred · confirm ↗</button>
   :<small className={s.provenance} title={{agent:'Declared by the build agent in extensions.presentation',branch:'Read from the branch steps in the procedure',design:'Inferred from condition labels in the design fields, not from the procedure',study:''}[arms[0].source]}>{{agent:'declared',branch:'from branch steps',design:'inferred',study:''}[arms[0].source]}</small>}
  </div>}
  {view==='flow'&&<FlowView {...props} arms={arms} focus={arm}/>}
  {view==='compare'&&<CompareView {...props} arms={arms}/>}
  {view==='screens'&&<ScreensView {...props} arms={arms} arm={arm??arms[0]}/>}
 </div>;
}

function Issue({ids,onIssue}:{ids:string[];onIssue:(id:string)=>void}){
 if(!ids.length)return null;
 return <button className={s.issue} onClick={e=>{e.stopPropagation();onIssue(ids[0]);}} aria-label={`${ids.length} open ${ids.length===1?'question':'questions'}`} title="Open question">!{ids.length>1?` ${ids.length}`:''}</button>;
}
function Chip({node,props,tone,prefix}:{node?:ProgramNode;props:Props;tone?:number;prefix?:string}){
 if(!node)return null;
 return <span className={`${s.chip} ${props.selectedIds.includes(node.id)?s.picked:''}`} data-tone={tone}><button onClick={e=>props.onPick(node.id,e.shiftKey)} title={node.summary||node.title}>{prefix&&<em>{prefix}</em>}{node.title}</button><Issue ids={props.issuesFor(node.id)} onIssue={props.onIssue}/></span>;
}

/* ---------- Version A · Flow: execution order, actors as lanes, conditions as forks ---------- */

function FlowView(props:Props&{arms:Arm[];focus?:Arm}){
 const {program,studyId,arms,focus}=props;
 const items=studyFlow(program,studyId,arms),actors=flowActors(program,items);
 const node=(id:string)=>program.nodes.find(n=>n.id===id);
 const scoped=(kinds:string[])=>program.nodes.filter(n=>kinds.includes(n.kind)&&(!n.studyIds.length||n.studyIds.includes(studyId)));
 const lanes=actors.length>=2?actors:[];
 const column=(item:FlowItem)=>lanes.length?Math.max(0,lanes.findIndex(a=>item.step.actorIds.includes(a.id))):0;
 const steps=(list:FlowItem[],depth:number):ReactNode=>list.map((item,i)=>{
  const prev=i>0?list[i-1]:undefined;
  return <Fragment key={item.step.id}>
   {prev&&<Connector from={column(prev)} to={column(item)} lanes={Math.max(1,lanes.length)} label={item.step.next.length?undefined:prev.step.next.find(e=>e.to===item.step.id)?.when}/>}
   <div className={s.flowRow} style={{gridTemplateColumns:`repeat(${Math.max(1,lanes.length)},minmax(0,1fr))`}}>
    <div style={{gridColumn:column(item)+1}}><FlowStep item={item} props={props} focus={focus} node={node} depth={depth} render={steps}/></div>
   </div>
  </Fragment>;
 });
 const who=scoped(['participants']);
 const [layout,setLayout]=useState<'cards'|'graph'>('cards');
 const issueIds=new Set(program.nodes.map(n=>n.id).concat(program.steps.map(st=>`flow:${st.id}`)).filter(id=>props.issuesFor(id).length));
 const toggle=<div className={s.segment} role="group" aria-label="Flow layout"><button aria-pressed={layout==='cards'} onClick={()=>setLayout('cards')} title="Steps with their materials, rules and records">Steps</button><button aria-pressed={layout==='graph'} onClick={()=>setLayout('graph')} title="The step graph: splits, joins and loops">Graph</button></div>;
 const context=<ContextGroups program={program} studyId={studyId} selectedIds={props.selectedIds} issueIds={issueIds} onPick={(id,extend)=>props.onPick(id,Boolean(extend))}/>;
 if(layout==='graph'){
  const graph=programGraph(program,studyId);
  // Focusing a condition keeps its own alternatives and everything outside the arms prominent.
  const others=new Set(arms.filter(a=>a.id!==focus?.id).flatMap(a=>a.stepIds??[]));
  const emphasis=focus?.stepIds?new Set(graph.steps.map(st=>st.id).filter(id=>!others.has(id))):undefined;
  return <div className={s.flow}>{context}<div className={s.layoutBar}>{toggle}{graph.wrappers.map(w=><button key={w.id} className={s.wrapperLabel} onClick={e=>props.onPick(`flow:${w.id}`,e.shiftKey)}>{w.kind} · {w.title}</button>)}</div><Diagram graph={graph} program={program} selectedIds={props.selectedIds} changedIds={props.changedIds} issueIds={issueIds} onPick={(id,extend)=>props.onPick(id,Boolean(extend))} emphasis={emphasis}/></div>;
 }
 return <div className={s.flow}>
  {context}
  <div className={s.layoutBar}>{toggle}</div>
  {lanes.length>0&&<div className={s.laneHeads} style={{gridTemplateColumns:`repeat(${lanes.length},minmax(0,1fr))`}}>{lanes.map(a=><button key={a.id} onClick={e=>props.onPick(a.id,e.shiftKey)}><span className={s.avatar}>{a.title.slice(0,1)}</span>{a.title}</button>)}</div>}
  <div className={`${s.flowBody} ${lanes.length?s.swim:''}`} style={{'--lanes':Math.max(1,lanes.length)} as CSSProperties}>
   {who.length>0&&<><div className={s.terminal}><span className={s.barLabel}>Who</span>{who.map(n=><Chip key={n.id} node={n} props={props}/>)}</div><Connector from={0} to={0} lanes={1}/></>}
   {steps(items,0)}
  </div>
 </div>;
}

function Connector({from,to,lanes,label}:{from:number;to:number;lanes:number;label?:string}){
 const x=(c:number)=>(c+0.5)/lanes*100;
 return <div className={s.connector} aria-hidden><svg viewBox="0 0 100 24" preserveAspectRatio="none"><path d={from===to?`M${x(from)} 0V24`:`M${x(from)} 0V8H${x(to)}V24`} vectorEffect="non-scaling-stroke"/></svg><span style={{left:`${x(to)}%`}}>▾</span>{label&&<em style={{left:`${x(to)}%`}}>{label}</em>}</div>;
}

function FlowStep({item,props,focus,node,depth,render}:{item:FlowItem;props:Props;focus?:Arm;node:(id:string)=>ProgramNode|undefined;depth:number;render:(items:FlowItem[],depth:number)=>ReactNode}){
 const {step}=item,id=`flow:${step.id}`;
 const rule=step.rule&&step.rule.value!==null?`${step.rule.label}: ${programText(step.rule.value)}`:'';
 const records=step.outputIds.map(node).filter((n):n is ProgramNode=>Boolean(n)&&['variable','record'].includes(n!.kind));
 const card=<div className={`${s.step} ${props.selectedIds.includes(id)?s.picked:''} ${step.rule&&['missing','decision'].includes(step.rule.state)?s.unresolved:''}`} data-model-id={id}>
  <button className={s.stepHead} onClick={e=>props.onPick(id,e.shiftKey)}>
   <span className={s.kind} data-kind={step.kind}>{kindMark[step.kind]??'•'}</span>
   <strong>{step.title}</strong>
   {step.actorIds.length>0&&<small>{step.actorIds.map(a=>node(a)?.title??a).join(', ')}</small>}
  </button>
  <Issue ids={props.issuesFor(id)} onIssue={props.onIssue}/>
  {rule&&<p className={s.rule}>{rule}</p>}
  {step.rule&&step.rule.value===null&&<p className={s.gapLine}>{step.rule.label}: not specified</p>}
  {item.splits&&step.kind!=='branch'&&<ArmHeads arms={conditionArms(props.program,props.studyId)} focus={focus}/>}
  {item.lanes.length>0&&<div className={s.lanes} style={{gridTemplateColumns:`repeat(${item.lanes.length},minmax(0,1fr))`}}>{item.lanes.map(l=><div key={l.arm.id} className={`${s.lane} ${focus&&focus.id!==l.arm.id?s.dim:''}`} data-tone={l.arm.tone}><span className={s.laneLabel}><i/>{l.arm.label}</span>{l.nodeIds.map(nid=><Chip key={nid} node={node(nid)} props={props} tone={l.arm.tone}/>)}</div>)}</div>}
  {item.shared.length>0&&<div className={s.io}><span>{step.visibleIds.length?'Sees':'Uses'}</span>{item.shared.map(nid=><Chip key={nid} node={node(nid)} props={props}/>)}</div>}
  {records.length>0&&records.length<=4&&<div className={s.io}><span>Records</span>{records.map(n=><Chip key={n.id} node={n} props={props}/>)}</div>}
  {records.length>4&&<details className={s.ioMore} open={records.some(n=>props.selectedIds.includes(n.id))}><summary><span>Records</span>{records.length} measures</summary><div className={s.io}>{records.map(n=><Chip key={n.id} node={n} props={props}/>)}</div></details>}
 </div>;
 if(!item.children.length)return card;
 // Branch alternatives run side by side, one column per arm; the shared continuation follows below.
 if(step.kind==='branch'&&item.children.length>=2)return <div className={s.branch}>{card}<div className={s.alternatives} style={{gridTemplateColumns:`repeat(${item.children.length},minmax(0,1fr))`}}>{item.children.map(child=><div key={child.step.id} className={`${s.alternative} ${focus&&child.arm&&focus.id!==child.arm.id?s.dim:''}`} data-tone={child.arm?.tone}>{child.arm&&<span className={s.laneLabel}><i/>{child.arm.label}</span>}{render([child],depth+1)}</div>)}</div></div>;
 return <div className={s.container} data-kind={step.kind}>{card}<div className={s.nested}>{render(item.children,depth+1)}</div>{step.kind==='repeat'&&<span className={s.loopBack} aria-hidden>↻ repeat</span>}</div>;
}
const kindMark:Record<string,string>={action:'▸',sequence:'⋯',repeat:'↻',branch:'⑂',parallel:'⫴',interaction:'⇄',custom:'◆'};
function ArmHeads({arms,focus}:{arms:Arm[];focus?:Arm}){
 return <div className={s.forkArms}><span>splits into</span>{arms.map(a=><b key={a.id} data-tone={a.tone} className={focus&&focus.id!==a.id?s.dim:''}><i/>{a.label}</b>)}</div>;
}

/* ---------- Version B · Compare: aligned facts per condition, only differences by default ---------- */

function CompareView(props:Props&{arms:Arm[]}){
 const {program,arms}=props;
 const studies=studyArms(program);
 const [mode,setMode]=useState<'conditions'|'studies'>(arms.length>=2?'conditions':'studies');
 const [all,setAll]=useState(false);
 const columns=mode==='conditions'&&arms.length>=2?arms:studies;
 const [hidden,setHidden]=useState<string[]>([]);
 const shown=columns.filter(c=>!hidden.includes(c.id));
 const rows=useMemo(()=>compareRows(program,shown),[program,shown]);
 if(columns.length<2)return <div className={s.empty}><p>No conditions are mapped in this study, and there is no second study to compare.</p>{props.onDiscuss&&<button onClick={()=>props.onDiscuss!(designOf(program,props.studyId),'Check whether this study has different conditions. Map only the documented conditions and their step paths, and flag missing assignments.')}>Check with agent ↗</button>}</div>;
 const differing=rows.filter(r=>!r.same),same=rows.filter(r=>r.same);
 const groups=[...new Set((all?rows:differing).map(r=>r.group))];
 return <div className={s.compare}>
  <div className={s.compareBar}>
   {arms.length>=2&&studies.length>=2&&<div className={s.segment} role="group" aria-label="Compare"><button aria-pressed={mode==='conditions'} onClick={()=>{setMode('conditions');setHidden([]);}}>Conditions</button><button aria-pressed={mode==='studies'} onClick={()=>{setMode('studies');setHidden([]);}}>Studies</button></div>}
   {columns.length>2&&columns.map(c=><label key={c.id} className={s.armChip} data-tone={c.tone}><input type="checkbox" checked={!hidden.includes(c.id)} disabled={!hidden.includes(c.id)&&shown.length<=2} onChange={()=>setHidden(h=>h.includes(c.id)?h.filter(x=>x!==c.id):[...h,c.id])}/><i/>{c.label}</label>)}
   <span className={s.tally}><b>{differing.length}</b> of {rows.length} differ</span>
   <label className={s.toggle}><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>Show identical</label>
  </div>
  <div className={s.table} style={{gridTemplateColumns:`minmax(84px,.55fr) repeat(${shown.length},minmax(150px,1fr))`}} role="table">
   <div className={s.th} role="columnheader"/>{shown.map(c=><div key={c.id} role="columnheader" className={s.th} data-tone={c.tone}><i/>{c.label}</div>)}
   {groups.map(group=><Fragment key={group}>
    <div className={s.group} role="rowheader">{group}</div>
    {(all?rows:differing).filter(r=>r.group===group).map(row=><Fragment key={row.key}>
     <div className={s.rowLabel} role="rowheader">{row.label}</div>
     {row.same?<button className={`${s.cell} ${s.sameCell}`} style={{gridColumn:`span ${shown.length}`}} onClick={e=>row.cells[0].nodeId&&props.onPick(row.cells[0].nodeId,e.shiftKey)}><span><small>Same in all</small> {row.cells[0].text}</span></button>
     :shown.map((c,i)=>{const cell=row.cells.find(x=>x.armId===c.id),other=row.cells.find(x=>x.armId===shown[i===0?1:0].id);
      return <button key={c.id} className={`${s.cell} ${cell?.nodeId&&props.selectedIds.includes(cell.nodeId)?s.picked:''}`} data-tone={c.tone} onClick={e=>cell?.nodeId&&props.onPick(cell.nodeId,e.shiftKey)}>{cell?<span><Diff text={cell.text} against={other?.text}/></span>:<span className={s.absent}>Not present</span>}</button>;})}
    </Fragment>)}
   </Fragment>)}
  </div>
  {!all&&same.length>0&&<button className={s.sameSummary} onClick={()=>setAll(true)}><b>Identical in all {shown.length}:</b> {same.map(r=>r.group==='Procedure'?r.cells[0].text.split(' · ')[0]:`${r.group} · ${r.label}`).join(' · ')}</button>}
 </div>;
}
function Diff({text,against}:{text:string;against?:string}){
 if(against===undefined)return <>{text}</>;
 return <>{wordDiff(text,against).map((part,i)=>part.changed?<mark key={i}>{part.text}</mark>:<Fragment key={i}>{part.text}</Fragment>)}</>;
}

/* ---------- Version C · Screens: what one participant sees, assembled from verbatim fields ---------- */

function ScreensView(props:Props&{arms:Arm[];arm?:Arm}){
 const {program,studyId,arms,arm}=props;
 const [contrast,setContrast]=useState(true);
 const screens=studyScreens(program,studyId,arm);
 const other=arms.length>=2?studyScreens(program,studyId,arms.find(a=>a.id!==arm?.id)):[];
 const authored=Boolean(presentation(program).screens?.some(sc=>program.steps.find(st=>st.id===sc.stepId)?.studyId===studyId));
 const node=(id:string)=>program.nodes.find(n=>n.id===id);
 let number=0;
 return <div className={s.screens} data-tone={arm?.tone}>
  <div className={s.screensMeta}><small className={s.provenance} title={authored?'The build agent chose which verbatim fields appear on each screen':'Inferred from each step’s visible inputs'}>{authored?'Screen layout by build agent':'Screen layout inferred'} · text is verbatim from the program</small>{other.length>0&&<label className={s.toggle}><input type="checkbox" checked={contrast} onChange={e=>setContrast(e.target.checked)}/>Mark words that differ from {arms.find(a=>a.id!==arm?.id)?.label}</label>}</div>
  {screens.map((screen,i)=>{
   const step=screen.step,id=`flow:${step.id}`,issues=props.issuesFor(id);
   const flow=flatFlow(studyFlow(program,studyId,arms)).find(f=>f.item.step.id===step.id)?.item;
   if(flow?.splits)return <div key={step.id} className={s.assignment}><button onClick={e=>props.onPick(id,e.shiftKey)}>{step.title}</button>{arm?<b data-tone={arm.tone}><i/>{arm.label}</b>:null}<small>not shown to participant</small><Issue ids={[...issues,...program.nodes.filter(n=>n.kind==='design'&&(!n.studyIds.length||n.studyIds.includes(studyId))).flatMap(n=>props.issuesFor(n.id))]} onIssue={props.onIssue}/></div>;
   if(step.children.length&&!screen.blocks.some(b=>b.type!=='records'))return <div key={step.id} className={s.loopHead} style={{marginLeft:screen.depth*14}}><button onClick={e=>props.onPick(id,e.shiftKey)}>{kindMark[step.kind]??'•'} {step.title}{step.rule&&step.rule.value!==null?` · ${step.rule.label} ${programText(step.rule.value)}`:''}</button></div>;
   number++;
   const peer=other[i];
   return <article key={step.id} className={`${s.screen} ${props.selectedIds.includes(id)?s.picked:''}`} style={{marginLeft:screen.depth*14}} data-model-id={id}>
    <header><button onClick={e=>props.onPick(id,e.shiftKey)}><span>{number}</span>{step.title}</button>{step.actorIds.length>0&&<small>{step.actorIds.map(a=>node(a)?.title??a).join(', ')}</small>}<Issue ids={issues} onIssue={props.onIssue}/></header>
    <div className={s.page}>
     {screen.continues&&<p className={s.continues}>Same screen as before; the participant responds here.</p>}
     {screen.blocks.map((block,b)=><Block key={b} block={block} props={props} against={contrast?peer?.blocks.filter(x=>x.type===block.type)[screen.blocks.filter(x=>x.type===block.type).indexOf(block)]:undefined}/>)}
     {!screen.blocks.length&&!screen.continues&&<p className={s.continues}>No participant-facing content recorded for this step.</p>}
    </div>
   </article>;
  })}
 </div>;
}
function Block({block,props,against}:{block:ScreenBlock;props:Props;against?:ScreenBlock}){
 const ref=(b?:ScreenBlock)=>b&&(b.type==='text'||b.type==='question')?b.text:undefined;
 if(block.type==='text')return <button className={s.verbatim} onClick={e=>props.onPick(block.nodeId,e.shiftKey)}>{block.text.split(/\n{2,}/).map((para,i)=><p key={i}><Diff text={para} against={ref(against)!==undefined?ref(against)!.split(/\n{2,}/)[i]??'':undefined}/></p>)}</button>;
 if(block.type==='question')return <button className={s.question} onClick={e=>props.onPick(block.nodeId,e.shiftKey)}><p><Diff text={block.text} against={ref(against)}/></p><span className={block.scale?s.scale:s.options}>{block.options.map(o=><span key={o}>{block.scale?o:<><i/>{o}</>}</span>)}</span></button>;
 if(block.type==='gap')return <button className={s.gap} onClick={()=>block.issueId&&props.onIssue(block.issueId)}><b>Not specified</b> {block.text}</button>;
 return <p className={s.records}>Records → {block.nodeIds.map(id=>props.program.nodes.find(n=>n.id===id)?.title??id).join(', ')}</p>;
}
