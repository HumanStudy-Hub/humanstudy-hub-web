import type { StudioDocument, StudioSource } from './types';
import { sourceSpec, sourceStoragePath } from './resources';

export function emptyStudy(title:string):StudioDocument {
 return {version:1,title,model:{id:crypto.randomUUID(),title,source:{title:'',authors:'',filename:''},entities:[],relations:[],procedure:[],variables:[]},sources:[],annotations:[],conversations:[],reviewResponses:{}};
}

/** Preserve scientific IDs and conversation references, but never reuse remote job authority. */
export function forkDocument(document:StudioDocument,ownerId:string,newId:string,from:{workspaceId:string;revision:number}):StudioDocument {
 const next=structuredClone(document);
 next.title=`${document.title.slice(0,153)} (fork)`;
 next.project={forkedFrom:from,copyState:'preparing'};
 delete next.pipeline;delete next.discussion;delete next.acceptedPackage;delete next.programVersions;
 next.sources=next.sources.map(source=>({...source,path:sourceStoragePath(ownerId,newId,source.id,sourceSpec(source.name)!.extension)}));
 next.conversations=next.conversations.map(c=>({...c,messages:c.messages.map(m=>{
  if(!m.proposal)return m;
  const proposal={...m.proposal};delete proposal.jobId;
  if(proposal.status==='pending')proposal.status='rejected';
  return {...m,proposal};
 })}));
 return next;
}

export function sourceCopyPairs(original:StudioSource[],copied:StudioSource[]) {
 return copied.map(destination=>{
  const source=original.find(s=>s.id===destination.id&&s.name===destination.name&&s.size===destination.size);
  if(!source)throw new Error('Source changed. Create a new fork from the current project.');
  return {source,destination};
 });
}
