"use client";
import type { StudioMessage } from "@/lib/studio/types";
import type { StudySchema } from "@/app/build-preview/study-schema";
import { modelChanges } from "@/lib/studio/model-diff";
import { useT } from "@/app/build-preview/ui";
import s from "@/app/build-preview/workspace.module.css";

export default function ProposalCard({proposal,model,busy,previewing,onPreview,onDecision,onDiscuss}:{
 proposal:NonNullable<StudioMessage["proposal"]>;model:StudySchema;busy?:boolean;previewing:boolean;
 onPreview:()=>void;onDecision:(decision:"apply"|"reject")=>void;onDiscuss:()=>void;
}){
 const t=useT(),diff=modelChanges(model,proposal.model);
 const affected=diff.changedEntityIds;
 return <section className={s.proposal} aria-label={t("Proposed changes")}>
  <strong>{t(proposal.status==="pending"?"Proposed changes":proposal.status==="applied"?"Changes accepted":"Changes set aside")}</strong>
  <p>{proposal.summary}</p>
  {proposal.status==="pending"&&<>
   <div className={s.affectedObjects}>{affected.slice(0,4).map(id=><span key={id}>{proposal.model.entities.find(item=>item.id===id)?.title||model.entities.find(item=>item.id===id)?.title||id}{diff.removedEntityIds.includes(id)?` · ${t("Removed")}`:""}</span>)}{affected.length>4&&<span>+{affected.length-4}</span>}</div>
   {proposal.changesModel!==false&&<button type="button" className={s.previewButton} aria-pressed={previewing} onClick={onPreview}>{t(previewing?"Return to current study":"Preview changes")} ↗</button>}
   <details><summary>{t("What changes")}</summary><ul>{diff.sections.map(section=><li key={section}>{t(section)}</li>)}</ul>{affected.map(id=>{const before=model.entities.find(item=>item.id===id),after=proposal.model.entities.find(item=>item.id===id);return <section key={id}><strong>{after?.title||before?.title}</strong>{before&&after&&before.description!==after.description&&<p>{after.description}</p>}{after?.fields.filter(field=>!before?.fields.some(old=>old.name===field.name&&old.value===field.value&&old.status===field.status)).map((field,index)=><p key={index}><strong>{field.name}</strong>: {field.value}</p>)}{after?.evidence.quote&&<blockquote>{after.evidence.quote} · p. {after.evidence.page}</blockquote>}</section>;})}</details>
  </>}
  {!!proposal.artifacts?.length&&<details><summary>{t("Materials")} · {proposal.artifacts.length}</summary>{proposal.artifacts.map(artifact=><section key={artifact.id}><strong>{artifact.title}</strong><small>{artifact.filename}</small><pre>{artifact.content}</pre></section>)}</details>}
  {proposal.status==="pending"&&<div><button type="button" disabled={busy} onClick={()=>onDecision("apply")}>{t("Accept changes")}</button><button type="button" onClick={onDiscuss}>{t("Continue discussing")}</button><button type="button" disabled={busy} onClick={()=>onDecision("reject")}>{t("Set aside")}</button></div>}
 </section>;
}
