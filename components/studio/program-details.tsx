'use client';
import type { HumanProgram, ProgramField } from '@/lib/studio/human-program';
import { programText } from '@/lib/studio/human-program';
import type { Evidence } from '@/app/build-preview/study-schema';
import type { ModelAnchor } from '@/app/build-preview/model-review';
import s from './program-details.module.css';

export default function ProgramDetails({program,id,fieldId,onDiscuss,onInspect,onSource}:{program:HumanProgram;id:string;fieldId?:string;onDiscuss:(anchor:ModelAnchor)=>void;onInspect:(id:string)=>void;onSource:(id:string,evidence:Evidence)=>void}){
 const node=program.nodes.find(n=>n.id===id),step=program.steps.find(step=>`flow:${step.id}`===id);
 const names=(ids:string[])=>ids.map(id=>program.nodes.find(n=>n.id===id)?.title??id).join(', ');
 const fields=node?.fields??(step?.rule?[step.rule]:[]);
 const evidenceIds=[...new Set([...(node?.evidenceIds??step?.evidenceIds??[]),...fields.flatMap(f=>f.evidenceIds)])];
 const field=(f:ProgramField)=>{const citation=f.evidenceIds.map(id=>program.evidence.find(e=>e.id===id)).filter(e=>e?.sourceId&&e.locator.page&&e.locator.page<=10000).sort((a,b)=>Number(b?.verification==='verified')-Number(a?.verification==='verified'))[0];return <div key={f.id} data-program-field-id={f.id} className={`${s.field} ${fieldId===f.id?s.selected:''}`}><dt><span>{f.label}</span>{citation&&<button type="button" aria-label={`${citation.verification==='verified'?'Locate evidence':'Review source'} for ${f.label}`} onClick={()=>onSource(id,{sourceId:citation.sourceId,page:citation.locator.page!,quote:[...(citation.quote??'')].slice(0,8000).join(''),rects:[]})}>{citation.verification==='verified'?'Source':'Review source'}</button>}<button type="button" data-event={`program.field.${id}.${f.id}`} aria-label={`Comment on ${f.label}`} onClick={()=>onDiscuss({kind:'objects',entityIds:[id],fieldId:f.id})}>Comment</button></dt><dd>{typeof f.value==='object'&&f.value!==null?<details><summary>{Array.isArray(f.value)?`${f.value.length} items`:'Structured data'}</summary><pre>{programText(f.value)}</pre></details>:<p>{programText(f.value)}</p>}<small>{f.origin} · {f.state}</small>{f.derivation&&<details><summary>Derivation</summary><p>{f.derivation}</p></details>}</dd></div>;};
 const connections=program.relations.filter(r=>r.from===id||r.to===id);
 const extensions=node?.extensions??step?.extensions;
 return <div className={s.details}>
  <dl>{fields.map(field)}</dl>
  {step&&<><dl>{[['Actors',names(step.actorIds)],['Input',names(step.inputIds)],['Output',names(step.outputIds)],['Visible information',names(step.visibleIds)]].filter(([,v])=>v).map(([k,v])=><div className={s.field} key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>{step.children.length>0&&<div className={s.connections}>{step.children.map(child=><button key={child} onClick={()=>onInspect(`flow:${child}`)}>{program.steps.find(s=>s.id===child)?.title??child} ↗</button>)}</div>}{step.next.length>0&&<div className={s.connections}>{step.next.map(next=><button key={next.to} onClick={()=>onInspect(`flow:${next.to}`)}>{next.when||'Next'} → {program.steps.find(s=>s.id===next.to)?.title??next.to}</button>)}</div>}</>}
  {connections.length>0&&<details><summary>Connections ({connections.length})</summary><div className={s.connections}>{connections.map(r=>{const target=r.from===id?r.to:r.from;return <button key={r.id} onClick={()=>onInspect(target)}>{r.label??r.type} · {names([target])} ↗</button>;})}</div></details>}
  {extensions&&Object.keys(extensions).length>0&&<details><summary>Additional details</summary><pre>{programText(extensions)}</pre></details>}
  {evidenceIds.length>0&&<details><summary>Evidence ({evidenceIds.length})</summary>{evidenceIds.map(id=>{const e=program.evidence.find(e=>e.id===id)!;return <div key={id}><small>{e.path||e.sourceId||e.url} · {programText(e.locator)} · {e.verification??'unverified'}</small>{e.quote&&<blockquote>{e.quote}</blockquote>}</div>;})}</details>}
 </div>;
}
