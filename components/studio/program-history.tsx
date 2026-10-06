"use client";
import type { StudySchema } from '@/app/build-preview/study-schema';
import { useT } from '@/app/build-preview/ui';
import type { ProgramVersion, StudioConversation } from '@/lib/studio/types';
import { programHistory, type ProgramHistoryNode } from '@/lib/studio/program-history';
import s from '@/app/build-preview/workspace.module.css';

export default function ProgramHistory({model,versions=[],conversations,selectedId,onPreview,onCurrent}:{model:StudySchema;versions?:ProgramVersion[];conversations:StudioConversation[];selectedId?:string;onPreview:(node:ProgramHistoryNode)=>void;onCurrent:()=>void}){
 const t=useT(),nodes=programHistory(model,versions,conversations);
 const rowHeight=76;
 const x=(node:ProgramHistoryNode)=>node.status==='pending'||node.status==='rejected'?36:14;
 const position=new Map(nodes.map((node,index)=>[node.id,{x:x(node),y:index*rowHeight+22}]));
 return <div className={s.versionGraph} aria-label={t('Program version graph')}>
  <svg width="48" height={nodes.length*rowHeight} aria-hidden="true">{nodes.filter(node=>node.parentId).map(node=>{const parent=position.get(node.parentId!),child=position.get(node.id)!;return parent?<path key={node.id} d={`M${parent.x} ${parent.y} C${parent.x} ${parent.y+28},${child.x} ${child.y-28},${child.x} ${child.y}`} className={node.status==='pending'||node.status==='rejected'?s.proposalEdge:undefined}/>:null;})}{nodes.map(node=>{const p=position.get(node.id)!;return <circle key={node.id} cx={p.x} cy={p.y} r={node.status==='current'?5:4} className={node.status==='pending'||node.status==='rejected'?s.proposalNode:undefined}/>;})}</svg>
  <ol>{nodes.map(node=><li key={node.id}><button disabled={!node.model} aria-pressed={selectedId?selectedId===node.id:node.status==='current'} onClick={()=>{if(node.status==='current')onCurrent();else onPreview(node);}}><span><strong>{t(node.status==='current'?'Current program':node.status==='pending'?'Proposed changes':node.status==='rejected'?'Set aside':node.status==='earlier'?'Earlier program':'Accepted version')}</strong>{node.createdAt&&<time dateTime={node.createdAt}>{new Date(node.createdAt).toLocaleDateString()}</time>}</span><p>{node.label!=='Current program'&&t(node.label)}</p>{!node.model&&<small>{t('Snapshot unavailable')}</small>}</button></li>)}</ol>
 </div>;
}
