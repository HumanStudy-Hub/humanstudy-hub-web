import type { StudioDocument, ProgramVersion } from './types';
import { modelFingerprint } from './model-version';

/** Record accepted scientific changes, independently of autosave revisions.
 * Proposal snapshots already persist in messages, so only the baseline needs a model copy. */
export function acceptedProgramVersions(document:StudioDocument, proposalId:string, now:string):ProgramVersion[] {
 const proposal=document.conversations.flatMap(c=>c.messages).find(m=>m.proposal?.id===proposalId)?.proposal;
 const versions=[...(document.programVersions||[])];
 if(!proposal||proposal.changesModel===false||modelFingerprint(proposal.model)===modelFingerprint(document.model))return versions;
 const fingerprint=modelFingerprint(document.model);
 let base=[...versions].reverse().find(v=>v.fingerprint===fingerprint);
 if(!base){
  base={id:crypto.randomUUID(),createdAt:now,label:versions.length?'Saved program':'Initial program',fingerprint,model:document.model,...(versions.length?{parentId:versions.at(-1)!.id}:{})};
  versions.push(base);
 }
 versions.push({id:crypto.randomUUID(),parentId:base.id,createdAt:now,label:proposal.summary.slice(0,200)||'Accepted changes',fingerprint:modelFingerprint(proposal.model),proposalId});
 return versions;
}
