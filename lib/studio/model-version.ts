import { createHash } from 'node:crypto';
import type { StudySchema } from '@/app/build-preview/study-schema';

function normalize(value:unknown):unknown {
  if(typeof value==='string')return value.trim().replace(/\s+/g,' ');
  if(Array.isArray(value))return value.map(normalize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,normalize(item)]));
  return value;
}
const sourceEvidence=(value:StudySchema['entities'][number]['evidence'])=>({sourceId:value.sourceId,page:value.page,quote:value.quote});
// Scientific content only. Moving a node or selecting a different rectangle is
// a view/evidence-location edit and must not stale a proposal or package.
export function modelFingerprint(model:StudySchema):string {
  const semantic={
    id:model.id,title:model.title,source:model.source,
    entities:model.entities.map(entity=>({id:entity.id,kind:entity.kind,title:entity.title,subtitle:entity.subtitle,description:entity.description,evidence:sourceEvidence(entity.evidence),fields:[...entity.fields].sort((a,b)=>a.name.localeCompare(b.name))})).sort((a,b)=>a.id.localeCompare(b.id)),
    relations:[...model.relations].sort((a,b)=>`${a.from}\0${a.to}\0${a.label}`.localeCompare(`${b.from}\0${b.to}\0${b.label}`)),
    procedure:model.procedure.map(step=>({...step,evidence:sourceEvidence(step.evidence)})),
    variables:[...model.variables].sort((a,b)=>a.id.localeCompare(b.id)),
    reviewIssues:[...(model.reviewIssues||[])].map(issue=>({...issue,...(issue.evidence?{evidence:sourceEvidence(issue.evidence)}:{})})).sort((a,b)=>a.id.localeCompare(b.id)),
  };
  return createHash('sha256').update(JSON.stringify(normalize(semantic))).digest('hex');
}
