import type { StudySchema } from '@/app/build-preview/study-schema';
import type { ProgramVersion, StudioConversation, StudioMessageRef } from './types';
import { modelChanges } from './model-diff';

export type ProgramHistoryNode = { id:string; parentId?:string; label:string; createdAt?:string; status:'current'|'accepted'|'pending'|'rejected'|'earlier'; model?:StudySchema; reference?:StudioMessageRef; proposalId?:string };

/** Build lineage from recorded acceptance and proposal base fingerprints.
 * Missing legacy parents remain explicitly unavailable, never invented snapshots. */
export function programHistory(model:StudySchema, versions:ProgramVersion[], conversations:StudioConversation[]):ProgramHistoryNode[] {
 const proposals=new Map(conversations.flatMap(c=>c.messages.filter(m=>m.proposal&&m.proposal.changesModel!==false).map(m=>[m.proposal!.id,{proposal:m.proposal!,reference:{conversationId:c.id,messageId:m.id},createdAt:m.createdAt}] as const)));
 const nodes:ProgramHistoryNode[]=versions.map(v=>({id:v.id,parentId:v.parentId,label:v.label,createdAt:v.createdAt,status:'accepted',model:v.model||proposals.get(v.proposalId||'')?.proposal.model,reference:proposals.get(v.proposalId||'')?.reference,proposalId:v.proposalId}));
 const byFingerprint=new Map(versions.map(v=>[v.fingerprint,v.id]));
 const known=new Set(versions.map(v=>v.proposalId));
 for(const [id,{proposal,reference,createdAt}] of proposals){
  if(known.has(id))continue;
  let parentId=proposal.baseModelFingerprint?byFingerprint.get(proposal.baseModelFingerprint):undefined;
  if(proposal.baseModelFingerprint&&!parentId){
   parentId=`earlier-${proposal.baseModelFingerprint}`;
   if(!nodes.some(n=>n.id===parentId))nodes.push({id:parentId,label:'Earlier program',status:'earlier'});
  }
  nodes.push({id:`proposal-${id}`,parentId,label:proposal.summary||'Proposed changes',createdAt,status:proposal.status==='applied'?'accepted':proposal.status==='pending'?'pending':'rejected',model:proposal.model,reference,proposalId:id});
 }
 const current=[...nodes].reverse().find(n=>n.status==='accepted'&&n.model&&n.model.id===model.id&&!modelChanges(n.model,model).hasChanges);
 if(current)current.status='current';
 else nodes.push({id:'current-program',label:'Current program',status:'current',model});
 // Parents precede children even when a long-running proposal arrives later.
 const sorted:ProgramHistoryNode[]=[],seen=new Set<string>();
 const add=(node:ProgramHistoryNode)=>{if(seen.has(node.id))return;seen.add(node.id);const parent=nodes.find(n=>n.id===node.parentId);if(parent)add(parent);sorted.push(node);};
 nodes.forEach(add);
 return sorted;
}
