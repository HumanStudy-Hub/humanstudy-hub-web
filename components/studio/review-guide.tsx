"use client";
import { useState } from "react";
import { prioritizeReviewIssues, type ReviewIssue, type ReviewResponse } from "@/app/build-preview/model-review";
import { useT } from "@/app/build-preview/ui";
import s from "@/app/build-preview/workspace.module.css";

export default function ReviewGuide({issues,responses,onDiscuss,onAnswer,onSource,busy,focusedIssueId}:{
 issues:ReviewIssue[];responses:Record<string,ReviewResponse>;busy?:boolean;
 focusedIssueId?:string;
 onDiscuss:(issue:ReviewIssue)=>void;onAnswer:(issue:ReviewIssue)=>void;onSource:(issue:ReviewIssue)=>void;
}){
 const t=useT();
 const [deferred,setDeferred]=useState<string[]>([]),[chosen,setChosen]=useState<string>();
 const ordered=prioritizeReviewIssues(issues,responses);
 const unanswered=ordered.filter(issue=>!responses[issue.id]);
 const issue=ordered.find(item=>item.id===(chosen||focusedIssueId)&&!deferred.includes(item.id))||unanswered.find(item=>!deferred.includes(item.id));
 if(!issues.length)return null;
 return <section className={s.reviewGuide} aria-label={t("Next decision")}>
  <div className={s.guideHeading}><span>{t(unanswered.length?"Next decision":"Answers saved · awaiting changes")}</span><small>{unanswered.length}/{issues.length}</small></div>
  {issue?<><strong>{t(issue.title)}</strong>{(issue.reason||issue.question)&&<p>{t(issue.reason||issue.question||"")}</p>}
   {responses[issue.id]&&<small>{t("Answered · not yet applied")}</small>}
   <details><summary>{t("Why this needs a decision")}</summary>{issue.impact&&<p>{t(issue.impact)}</p>}{(issue.suggestedAction||issue.suggestion)&&<p>{t(issue.suggestedAction||issue.suggestion||"")}</p>}{issue.evidence?.quote&&<blockquote>{issue.evidence.quote}</blockquote>}{issue.sourcePointer&&<small>{issue.sourcePointer}</small>}{issue.evidence&&<button type="button" onClick={()=>onSource(issue)}>{t("View source")} ↗</button>}</details>
   <div className={s.guideActions}><button type="button" disabled={busy} onClick={()=>onAnswer(issue)}>{t("Give a decision")}</button><button type="button" onClick={()=>onDiscuss(issue)}>{t("Discuss")}</button><button type="button" onClick={()=>{setDeferred(previous=>[...previous,issue.id]);setChosen(undefined);}}>{t("Later")}</button></div>
  </>:<p>{t(unanswered.length?"You can return to these decisions whenever you are ready.":"Your answers are saved. Review the agent’s proposed changes before they become part of the study.")}</p>}
  <details className={s.guideQueue}><summary>{t("All decisions")} · {issues.length}</summary>{ordered.map(item=><button type="button" key={item.id} onClick={()=>{setDeferred(previous=>previous.filter(id=>id!==item.id));setChosen(item.id);}}><span>{t(item.title)}</span><small>{t(responses[item.id]?"Answered · not yet applied":item.severity==="blocking"?"Blocking":item.severity==="decision"?"Decision":"Check")}</small></button>)}</details>
 </section>;
}
