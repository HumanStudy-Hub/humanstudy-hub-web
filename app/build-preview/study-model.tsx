"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { study as exampleStudy, type StudySchema, type Evidence } from "./study-schema";
import { modelOverview, modelIssues, prioritizeReviewIssues, type ModelAnchor, type ReviewResponse } from "./model-review";
import s from "./study-model.module.css";
import { useT } from "./ui";
import { programText } from "@/lib/studio/human-program";
import ProgramDetails from "@/components/studio/program-details";
import Materials from "@/components/studio/materials";
import ProgramDocument,{viewStudies} from "@/components/studio/program-document";
import { itemSources, type SourceRef } from "@/lib/studio/program-view";
import { viewTemplates } from "@/lib/studio/views";
import ViewArtifact,{ useViewGeneration, type GeneratedView } from "@/components/studio/view-artifact";
import type { StudioArtifact } from "@/lib/studio/types";
import { modelChanges } from "@/lib/studio/model-diff";

type Props = {
  /** Program items cited by the passage selected in the source, and that passage's page. */
  support?: { ids: string[]; page: number } | null;
  workspaceActions?:ReactNode;
  focusArtifactId?:string;
  onClearArtifactFocus?:()=>void;
  model?:StudySchema;
  previewModel?:StudySchema;
  artifacts?:StudioArtifact[];
  onDiscussArtifact?:(artifact:StudioArtifact)=>void;
  busy?:boolean;
  selected: string;
  anchor: ModelAnchor | null;
  responses: Record<string, ReviewResponse>;
  onSelect: (anchor: ModelAnchor | null) => void;
  onSource: (id: string, evidence?: Evidence) => void;
  onDiscuss: (anchor: ModelAnchor, draft?: string) => void;
  onRespond: (id: string, text: string) => void;
};

export default function StudyModel({ support, focusArtifactId, onClearArtifactFocus, workspaceActions, model, previewModel, artifacts=[], onDiscussArtifact, selected, anchor, responses, onSelect, onSource, onDiscuss }: Props) {
  const approvedModel=model||exampleStudy;
  const study=previewModel||approvedModel;
  const preview=previewModel?modelChanges(approvedModel,previewModel):null;
  const changedIds=new Set(preview?.changedEntityIds||[]);
  const pageNumber=(n:number)=>study.id===exampleStudy.id?1160+n:n;
  // A revised example study keeps its ID, but its displayed content must come from the revision.
  const displayModel=study.id===exampleStudy.id&&modelChanges(exampleStudy,study).hasChanges?{...study,id:`${study.id}:revision`}:study;
  const [activeStudy,setActiveStudy]=useState("");
  const selectedScope=study.entities.find(e=>e.id===anchor?.entityIds[0])?.studyIds;
  const studyScope=activeStudy&&selectedScope?.length===1&&!selectedScope.includes(activeStudy)?selectedScope[0]:activeStudy;
  const overview=modelOverview(displayModel,studyScope), reviewIssues=prioritizeReviewIssues(modelIssues(displayModel),responses);
  const [materialsOpen,setMaterialsOpen]=useState(false);
  const showingMaterials=Boolean(focusArtifactId)||materialsOpen;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [inspect, setInspect] = useState(false);
  const drawable=study.program?viewStudies(study.program):[];
  const programView=Boolean(study.program);
  const viewStudy=drawable.find(item=>item.id===studyScope)?.id??drawable[0]?.id??"";
  // Generated views live with the panel; each one streams once and then renders in an isolated frame.
  const [views,setViews]=useState<GeneratedView[]>([]),[activeView,setActiveView]=useState("");
  const updateView=useCallback((id:string,patch:Partial<GeneratedView>)=>setViews(list=>list.map(v=>v.id===id?{...v,...patch}:v)),[]);
  useViewGeneration(views,updateView,{program:study.program,studyId:viewStudy||undefined});
  const view=views.find(v=>v.id===activeView);
  function retryView(old:GeneratedView){const id=crypto.randomUUID();setViews(list=>list.map(v=>v.id===old.id?{...old,id,done:false,error:undefined,html:"",note:"",title:""}:v));setActiveView(id);}
  function makeView(template:string){const t=viewTemplates.find(x=>x.id===template)!;const id=crypto.randomUUID();setViews(list=>[...list,{id,template,label:t.label,note:"",title:"",html:"",done:false}]);setActiveView(id);setMaterialsOpen(false);onClearArtifactFocus?.();}
  const t=useT();
  const canvas = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const needsInput = reviewIssues.filter(i => !responses[i.id]);
  const selectedIds = anchor?.entityIds || [];
  const focused = study.entities.find(e => e.id === (selectedIds.includes(selected)?selected:anchor?.entityIds[0] || selected));

  useEffect(()=>{
    if(!anchor?.entityIds[0])return;
    const frame=requestAnimationFrame(()=>{
      const target=scroll.current?.querySelector<HTMLElement>(`[data-model-id="${anchor.entityIds[0]}"]`);
      let parent=target?.parentElement;
      while(parent&&parent!==scroll.current){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}
      target?.scrollIntoView({block:"nearest",behavior:"smooth"});
    });
    return()=>cancelAnimationFrame(frame);
  },[anchor,study.entities]);

  function pick(id: string, extend = false, showDetails = false) {
    const ids = extend ? selectedIds.includes(id) ? selectedIds.filter(v => v !== id) : [...selectedIds, id] : [id];
    onSelect(ids.length ? { kind: "objects", entityIds: ids } : null);
    setInspect(ids.length>0&&showDetails);
  }
  /** Page citations open the paper at the quote; a citation to a material file opens the item's details instead. */
  function openSource(id: string, ref: SourceRef) {
    if(ref.page)onSource(id,{sourceId:ref.sourceId,page:ref.page,quote:ref.quote,rects:[]});
    else pick(id,false,true);
  }
  const focusedSource=study.program&&focused?itemSources(study.program,focused.id)[0]:undefined;
  function openIssue(id: string) {
    const next = reviewIssues.find(i => i.id === id)!;
    const nextAnchor:ModelAnchor={ kind: "issue", entityIds: next.entity ? [next.entity] : [], issueId: id };
    onSelect(nextAnchor);
    onDiscuss(nextAnchor);
    setInspect(false);
    setReviewOpen(false);
    if(next.entity)requestAnimationFrame(() => scroll.current?.querySelector<HTMLElement>(`[data-model-id="${next.entity}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  return <section data-event="model.panel" className={s.model} aria-label="Human Program">
    <header className={s.heading}><div className={s.artifactTabs} role="tablist" aria-label={t("Artifacts")}><button role="tab" aria-selected={!showingMaterials&&!view} onClick={()=>{onClearArtifactFocus?.();setMaterialsOpen(false);setActiveView("");}}>{t(study.program?"Protocol":"Human Program")}</button>{views.map(v=><button key={v.id} role="tab" aria-selected={!showingMaterials&&activeView===v.id} onClick={()=>{onClearArtifactFocus?.();setMaterialsOpen(false);setActiveView(v.id);}}>{v.title||v.label}{!v.done&&!v.error?" …":""}</button>)}{onDiscussArtifact&&<button role="tab" aria-selected={showingMaterials} onClick={()=>{onClearArtifactFocus?.();setMaterialsOpen(true);setActiveView("");}}>{t("Materials")} <span>{artifacts.length}</span></button>}{study.program&&<details className={s.visualize}><summary>{t("Visualize")} ▾</summary><div>{viewTemplates.map(v=><button key={v.id} onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");makeView(v.id);}}><strong>{t(v.label)}</strong><small>{t(v.hint)}</small></button>)}</div></details>}</div><div className={s.headerActions}><button className={s.needsInput} aria-expanded={reviewOpen} onClick={() => {onClearArtifactFocus?.();setMaterialsOpen(false);setReviewOpen(!reviewOpen);}}><span>{needsInput.length}</span> {t("Questions")}</button>{workspaceActions}</div></header>
    {view&&!showingMaterials&&study.program?<ViewArtifact key={view.id} view={view} knownIds={new Set([...study.program.nodes.map(n=>n.id),...study.program.steps.map(st=>`flow:${st.id}`)])} onPick={id=>{setActiveView("");pick(id);}} onRetry={()=>retryView(view)}/>
    :showingMaterials&&onDiscussArtifact?<Materials key={focusArtifactId||'materials'} activeId={focusArtifactId} artifacts={artifacts} onDiscuss={onDiscussArtifact}/>:<>
    {!study.program?<div className={s.toolbar}><button title={t("Return to full study overview")} aria-label={t("Return to full study overview")} onClick={() => { onSelect(null); setReviewOpen(false); scroll.current?.scrollTo({ top: 0, behavior: "smooth" }); }}>{t("Overview")}</button></div>
    :drawable.length>1&&<div className={s.toolbar}><div className={s.studyTabs} role="tablist" aria-label="Study scope">{drawable.map(scope=><button key={scope.id} role="tab" title={scope.title} aria-selected={viewStudy===scope.id} onClick={()=>{setActiveStudy(scope.id);setInspect(false);onSelect(null);}}>{scope.title}</button>)}</div></div>}
    {support&&study.program&&<div className={s.support} role="status">{support.ids.length?<><span>{t("Selected passage")} · p. {pageNumber(support.page)} {t("supports")}</span>{support.ids.map(id=><button key={id} onClick={()=>pick(id)}>{t(overview.cards[id]?.title||study.entities.find(e=>e.id===id)?.title||id)}</button>)}</>:<span>{t("No program item cites this passage.")}</span>}</div>}
    {reviewOpen && <div className={s.reviewList} aria-label="All study questions"><div><strong>{t("All study questions")}</strong><button aria-label={t("Close questions")} onClick={() => setReviewOpen(false)}>×</button></div>{reviewIssues.map(i => <button key={i.id} onClick={() => openIssue(i.id)}><span className={responses[i.id] ? s.responded : s.issueDot}>{responses[i.id] ? "✓" : "!"}</span><span><strong>{t(i.title)}</strong><small><b className={`${s.severity} ${i.severity === "blocking" ? s.blocking : ""}`}>{t(i.severity === "blocking" ? "Blocking" : i.severity === "decision" ? "Decision" : "Check")}</b> · {responses[i.id] ? t("Response saved · pending application") : i.entity ? t(overview.cards[i.entity]?.title||i.entity) : [i.study,i.field].filter(Boolean).join(" · ")}</small></span><span>↗</span></button>)}</div>}
    <div className={s.scroll} ref={scroll}>
      <div className={`${s.overviewHeading} ${programView?s.compactHeading:""}`}><h1>{t(overview.question)}</h1>{preview&&preview.hasChanges&&<div className={s.previewSummary}><strong>{t("Proposed changes")}</strong>{preview.changedEntityIds.length>0&&<span> · {preview.changedEntityIds.length} {t("affected parts")}</span>}{preview.sections.filter(section=>section!=="entities").length>0&&<span> · {preview.sections.filter(section=>section!=="entities").map(section=>t(section==="study"?"Study details":section==="reviewIssues"?"Review questions":section[0].toUpperCase()+section.slice(1))).join(", ")}</span>}{preview.removedEntityIds.length>0&&<small>{t("Removed")}: {preview.entities.filter(item=>item.kind==="removed").map(item=>t(item.title)).join(", ")}</small>}</div>}</div>
      {programView&&study.program?<ProgramDocument key={viewStudy} program={study.program} studyId={viewStudy} selectedIds={selectedIds} highlightIds={new Set(support?.ids??[])} issuesFor={id=>reviewIssues.filter(i=>i.entity===id&&!responses[i.id]).map(i=>i.id)} changedIds={changedIds} onPick={pick} onIssue={openIssue} onSource={openSource} onAsk={(id,fieldId,draft)=>onDiscuss({kind:"objects",entityIds:id?[id]:[],...(fieldId?{fieldId}:{})},draft)}/>:<>
      {study.entities.length===0&&<p className={s.gestureHint}>{t("Upload a paper, then ask the agent to build the first model.")}</p>}
      <div data-event="model.canvas" ref={canvas} className={s.canvas}>
        {overview.stages.map((stage) => <section key={stage.id} className={s.stage} aria-label={t(stage.title)}>
          <div className={s.stageLabel}><div><h2>{t(stage.title)}</h2></div></div>
          <div className={s.cards}>{stage.nodes.map(id => {
            const card = overview.cards[id];
            const problems = reviewIssues.filter(i => i.entity === id && !responses[i.id]);
            return <div key={id} data-model-id={id} data-event={`model.object.${id}`} className={`${s.card} ${["procedure","record"].includes(study.entities.find(entity=>entity.id===id)?.kind||"") || id === "manipulation" ? s.wide : ""} ${selectedIds.includes(id) ? s.selectedCard : ""} ${problems.length ? s.flagged : ""} ${changedIds.has(id) ? s.previewCard : ""}`}>
              <button className={s.cardBody} aria-label={`Inspect ${t(card.title)}`} aria-pressed={selectedIds.includes(id)} onClick={e => pick(id, e.shiftKey, true)}><span className={s.cardTitle}><strong>{t(card.title)}</strong>{changedIds.has(id)&&<em className={s.changeBadge}>{preview?.addedEntityIds.includes(id)?t("Added"):t("Changed")}</em>}</span><p>{t(card.text)}</p></button>
              {problems.length>0&&<button className={s.cardIssue} onClick={() => openIssue(problems[0].id)} aria-label={`${problems.length} ${t("questions for")} ${t(card.title)}`}><span>!</span>{problems.length} {t(problems.length===1?"question":"questions")}<span>↗</span></button>}
            </div>;
          })}</div>
        </section>)}

      </div>
      </>}
      {!programView&&study.program?.extensions&&<details className={s.programExtensions}><summary>Additional study data</summary><pre>{programText(study.program.extensions)}</pre></details>}
    </div>
    {anchor && anchor.kind!=="issue" && <div className={`${s.dock} ${!inspect?s.compactDock:""}`} aria-label="Human Program selection">
      <div className={s.dockHeader}><span>{`${t("Program selection")} · ${selectedIds.length} ${t("objects")}`}</span><button aria-label={t("Clear model selection")} onClick={() => onSelect(null)}>×</button></div>
      {inspect&&selectedIds.length>1&&<div className={s.selectedNames}>{selectedIds.map(id => <button key={id} onClick={()=>pick(id,false,true)}>{t(overview.cards[id]?.title||id)}</button>)}</div>}
      <div className={s.selectionActions}>{selectedIds.length > 0 && <button aria-expanded={inspect} onClick={() => setInspect(!inspect)}>{inspect ? t("Hide details") : t("Details")}</button>}{focusedSource?.page?<button onClick={()=>openSource(focused!.id,focusedSource)}>{t("Source")} · p. {pageNumber(focusedSource.page)} ↗</button>:study.program&&focused&&!focusedSource&&<span className={s.noSource}>{t("No source cited")}</span>}<button onClick={() => onDiscuss(anchor)}>{t("Ask agent")}</button></div>
        {inspect && focused && <div className={s.inspector}>
          {selectedIds.length > 1 && <p>{t("Details")} · {t(overview.cards[focused.id].title)}</p>}
          <h3>{t(overview.cards[focused.id].title)}</h3><p>{t(focused.description)}</p>
          {preview?.entities.find(item=>item.id===focused.id)&&<div className={s.changeDetail}><strong>{t("Proposed change")}</strong><ul>{preview.entities.find(item=>item.id===focused.id)!.details.map(detail=><li key={detail}>{t(detail)}</li>)}</ul></div>}
          {study.program?<ProgramDetails program={study.program} id={focused.id} fieldId={anchor?.fieldId} onDiscuss={onDiscuss} onInspect={id=>pick(id,false,true)} onSource={onSource}/>:<>
          <dl>{focused.fields.map((f,i) => <div key={f.id||i}><dt>{t(f.name)} <button className={s.fieldComment} aria-label={`Comment on ${f.name}`} onClick={()=>onDiscuss({kind:"objects",entityIds:[focused.id],fieldId:f.id??`field-${i+1}`})}>{t("Comment")}</button></dt><dd>{f.value}<small>{f.status === "reported" ? t("Reported in source") : f.status === "implementation" ? t("Implementation proposal") : t("Needs review")}</small></dd></div>)}</dl>
          {focused.kind === "procedure" && <div className={s.stepDetails}><h4>{t("Steps")}</h4>{study.procedure.filter(step=>!step.entity||step.entity===focused.id).map((step,i) => <div key={step.id}><button disabled={!step.evidence.quote.trim()&&!step.evidence.rects.length} onClick={() => onSource(focused.id, step.evidence)}>{i+1}. {t(step.name)} ↗</button><dl><dt>{t("Input")}</dt><dd>{t(step.input)}</dd><dt>{t("Person")}</dt><dd>{t(step.actor)}</dd><dt>{t("Output")}</dt><dd>{t(step.output)}</dd></dl></div>)}</div>}
          </>}
          <details><summary>{t("Variables used here")} ({study.variables.filter(v => v.entity === focused.id).length})</summary>{study.variables.filter(v => v.entity === focused.id).map(v => <div className={s.variable} key={v.id}><code>{v.name}</code><p>{v.role} · {v.type} · {v.unit}</p><small>{v.producedBy} → {v.usedBy}</small><p>{v.definition}</p></div>)}</details>
          <blockquote>{focused.evidence.quote||t("Source not located")}</blockquote><button className={s.sourceLink} disabled={!focused.evidence.quote.trim()&&!focused.evidence.rects.length} onClick={() => onSource(focused.id, focused.evidence)}>{t("Source")} · p. {pageNumber(focused.evidence.page)} ↗</button>
        </div>}

    </div>}
  </>}
  </section>;
}
