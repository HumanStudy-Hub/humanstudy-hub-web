"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { study as exampleStudy, type StudySchema, type Evidence } from "./study-schema";
import { intersectsPolygon, modelOverview, modelIssues, prioritizeReviewIssues, type ModelAnchor, type Point, type ReviewResponse } from "./model-review";
import s from "./study-model.module.css";
import { UiIcon, useT } from "./ui";
import Materials from "@/components/studio/materials";
import type { StudioArtifact } from "@/lib/studio/types";
import { modelChanges } from "@/lib/studio/model-diff";

type Props = {
  workspaceActions?:ReactNode;
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

export default function StudyModel({ workspaceActions, model, previewModel, artifacts=[], onDiscussArtifact, busy, selected, anchor, responses, onSelect, onSource, onDiscuss }: Props) {
  const approvedModel=model||exampleStudy;
  const study=previewModel||approvedModel;
  const preview=previewModel?modelChanges(approvedModel,previewModel):null;
  const changedIds=new Set(preview?.changedEntityIds||[]);
  const pageNumber=(n:number)=>study.id===exampleStudy.id?1160+n:n;
  // A revised example study keeps its ID, but its displayed content must come from the revision.
  const displayModel=study.id===exampleStudy.id&&modelChanges(exampleStudy,study).hasChanges?{...study,id:`${study.id}:revision`}:study;
  const overview=modelOverview(displayModel), reviewIssues=prioritizeReviewIssues(modelIssues(displayModel),responses);
  const [materialsOpen,setMaterialsOpen]=useState(false);
  const [tool, setTool] = useState<"select" | "circle">("select");
  const [ink, setInk] = useState<Point[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [inspect, setInspect] = useState(false);
  const t=useT();
  const canvas = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const drawing = useRef<Point[] | null>(null);
  const suppressClick = useRef(false);
  const needsInput = reviewIssues.filter(i => !responses[i.id]);
  const selectedIds = anchor?.entityIds || [];
  const focused = study.entities.find(e => e.id === (selectedIds.includes(selected)?selected:anchor?.entityIds[0] || selected));
  const path = ink.length ? ink : anchor?.kind === "lasso" ? anchor.points || [] : [];

  useEffect(()=>{
    if(!anchor?.entityIds[0])return;
    const frame=requestAnimationFrame(()=>canvas.current?.querySelector<HTMLElement>(`[data-model-id="${anchor.entityIds[0]}"]`)?.scrollIntoView({block:"nearest",behavior:"smooth"}));
    return()=>cancelAnimationFrame(frame);
  },[anchor]);

  function pick(id: string, extend = false) {
    if (tool === "circle" || suppressClick.current) return;
    const ids = extend ? selectedIds.includes(id) ? selectedIds.filter(v => v !== id) : [...selectedIds, id] : [id];
    onSelect(ids.length ? { kind: "objects", entityIds: ids } : null);
    setInspect(ids.length>0);
  }
  function openIssue(id: string) {
    const next = reviewIssues.find(i => i.id === id)!;
    const nextAnchor:ModelAnchor={ kind: "issue", entityIds: next.entity ? [next.entity] : [], issueId: id };
    onSelect(nextAnchor);
    onDiscuss(nextAnchor);
    setInspect(false);
    setReviewOpen(false);
    if(next.entity)requestAnimationFrame(() => canvas.current?.querySelector<HTMLElement>(`[data-model-id="${next.entity}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }
  function position(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)), y: Math.max(0, Math.min(100, (event.clientY - rect.top) / rect.height * 100)) };
  }
  function startCircle(event: PointerEvent<HTMLDivElement>) {
    if (tool !== "circle" || event.button !== 0 || busy) return;
    event.preventDefault();
    drawing.current = [position(event)]; setInk(drawing.current); suppressClick.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveCircle(event: PointerEvent<HTMLDivElement>) {
    if (!drawing.current) return;
    const p = position(event), last = drawing.current.at(-1)!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < .25) return;
    drawing.current = [...drawing.current.slice(-510), p]; setInk(drawing.current);
  }
  function finishCircle(event: PointerEvent<HTMLDivElement>) {
    if (!drawing.current || !canvas.current) return;
    const points = [...drawing.current, position(event)]; drawing.current = null;
    if (points.length >= 3) {
      const bounds = canvas.current.getBoundingClientRect();
      const ids = Array.from(canvas.current.querySelectorAll<HTMLElement>("[data-model-id]")).filter(node => {
        const r = node.getBoundingClientRect();
        return intersectsPolygon(points, { x: (r.left - bounds.left) / bounds.width * 100, y: (r.top - bounds.top) / bounds.height * 100, w: r.width / bounds.width * 100, h: r.height / bounds.height * 100 });
      }).map(node => node.dataset.modelId!);
      const next:ModelAnchor={ kind: "lasso", entityIds: ids, points };
      onSelect(next);
      setInspect(false);
      onDiscuss(next);
    }
    setTool("select"); setInk([]);
    // The pointer-up is followed by a click; do not turn a lasso into a single selection.
    setTimeout(() => { suppressClick.current = false; }, 0);
  }

  return <section data-event="model.panel" className={s.model} aria-label="Human Program">
    <header className={s.heading}><div><strong>{t("Human Program")}</strong></div><div className={s.headerActions}>{onDiscussArtifact&&<button aria-pressed={materialsOpen} onClick={()=>setMaterialsOpen(!materialsOpen)}>{t("Materials")} <span>{artifacts.length}</span></button>}<button className={s.needsInput} aria-expanded={reviewOpen} onClick={() => {setMaterialsOpen(false);setReviewOpen(!reviewOpen);}}><span>{needsInput.length}</span> {t("Questions")}</button>{workspaceActions}</div></header>
    {materialsOpen&&onDiscussArtifact?<Materials artifacts={artifacts} onDiscuss={onDiscussArtifact}/>:<>
    <div className={s.toolbar}><div><button aria-label={t("Select objects")} title={t("Select objects")} aria-pressed={tool === "select"} className={tool === "select" ? s.activeTool : ""} onClick={() => setTool("select")}><UiIcon name="selection"/>{t("Select")}</button><button aria-label={t("Circle selection")} title={t("Circle selection")} aria-pressed={tool === "circle"} className={tool === "circle" ? s.activeTool : ""} onClick={() => { setTool("circle"); setInspect(false); }}><UiIcon name="circle"/>{t("Circle")}</button></div><button title={t("Return to full study overview")} aria-label={t("Return to full study overview")} onClick={() => { onSelect(null); setReviewOpen(false); setTool("select"); scroll.current?.scrollTo({ top: 0, behavior: "smooth" }); }}>{t("Overview")}</button></div>
    {reviewOpen && <div className={s.reviewList} aria-label="All study questions"><div><strong>{t("All study questions")}</strong><button aria-label={t("Close questions")} onClick={() => setReviewOpen(false)}>×</button></div>{reviewIssues.map(i => <button key={i.id} onClick={() => openIssue(i.id)}><span className={responses[i.id] ? s.responded : s.issueDot}>{responses[i.id] ? "✓" : "!"}</span><span><strong>{t(i.title)}</strong><small><b className={`${s.severity} ${i.severity === "blocking" ? s.blocking : ""}`}>{t(i.severity === "blocking" ? "Blocking" : i.severity === "decision" ? "Decision" : "Check")}</b> · {responses[i.id] ? t("Response saved · pending application") : i.entity ? t(overview.cards[i.entity]?.title||i.entity) : [i.study,i.field].filter(Boolean).join(" · ")}</small></span><span>↗</span></button>)}</div>}
    <div className={s.scroll} ref={scroll}>
      <div className={s.overviewHeading}><h1>{t(overview.question)}</h1>{preview&&preview.hasChanges&&<div className={s.previewSummary}><strong>{t("Proposed changes")}</strong>{preview.changedEntityIds.length>0&&<span> · {preview.changedEntityIds.length} {t("affected parts")}</span>}{preview.sections.filter(section=>section!=="entities").length>0&&<span> · {preview.sections.filter(section=>section!=="entities").map(section=>t(section==="study"?"Study details":section==="reviewIssues"?"Review questions":section[0].toUpperCase()+section.slice(1))).join(", ")}</span>}{preview.removedEntityIds.length>0&&<small>{t("Removed")}: {preview.entities.filter(item=>item.kind==="removed").map(item=>t(item.title)).join(", ")}</small>}</div>}</div>
      {study.entities.length===0&&<p className={s.gestureHint}>{t("Upload a paper, then ask the agent to build the first model.")}</p>}
      <div data-event="model.canvas" ref={canvas} className={`${s.canvas} ${tool === "circle" ? s.circling : ""}`} onPointerDown={startCircle} onPointerMove={moveCircle} onPointerUp={finishCircle} onPointerCancel={() => { drawing.current = null; setInk([]); suppressClick.current = false; setTool("select"); }}>
        {overview.stages.map((stage) => <section key={stage.id} className={s.stage} aria-label={t(stage.title)}>
          <div className={s.stageLabel}><div><h2>{t(stage.title)}</h2></div></div>
          <div className={s.cards}>{stage.nodes.map(id => {
            const card = overview.cards[id];
            const problems = reviewIssues.filter(i => i.entity === id && !responses[i.id]);
            return <div key={id} data-model-id={id} data-event={`model.object.${id}`} className={`${s.card} ${["procedure","record"].includes(study.entities.find(entity=>entity.id===id)?.kind||"") || id === "manipulation" ? s.wide : ""} ${selectedIds.includes(id) ? s.selectedCard : ""} ${problems.length ? s.flagged : ""} ${changedIds.has(id) ? s.previewCard : ""}`}>
              <button className={s.cardBody} aria-label={`Inspect ${t(card.title)}`} aria-pressed={selectedIds.includes(id)} onClick={e => pick(id, e.shiftKey)}><span className={s.cardTitle}><strong>{t(card.title)}</strong>{changedIds.has(id)&&<em className={s.changeBadge}>{preview?.addedEntityIds.includes(id)?t("Added"):t("Changed")}</em>}</span><p>{t(card.text)}</p></button>
              {problems.length>0&&<button className={s.cardIssue} onClick={() => { if (tool !== "circle" && !suppressClick.current) openIssue(problems[0].id); }} aria-label={`${problems.length} ${t("questions for")} ${t(card.title)}`}><span>!</span>{problems.length} {t(problems.length===1?"question":"questions")}<span>↗</span></button>}
            </div>;
          })}</div>
        </section>)}
        <svg className={s.ink} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{path.length > 1 && <polygon points={path.map(p => `${p.x},${p.y}`).join(" ")} vectorEffect="non-scaling-stroke"/>}</svg>
      </div>
    </div>
    {anchor && anchor.kind!=="issue" && <div className={`${s.dock} ${!inspect?s.compactDock:""}`} aria-label="Human Program selection">
      <div className={s.dockHeader}><span>{`${t(anchor.kind === "lasso" ? "Circled region" : "Model selection")} · ${selectedIds.length} ${t("objects")}`}</span><button aria-label={t("Clear model selection")} onClick={() => onSelect(null)}>×</button></div>
      {inspect&&<div className={s.selectedNames}>{selectedIds.length ? selectedIds.map(id => <button key={id} disabled={!study.entities.find(e=>e.id===id)?.evidence.quote.trim()&&!study.entities.find(e=>e.id===id)?.evidence.rects.length} onClick={() => onSource(id, study.entities.find(e=>e.id===id)?.evidence)} title={t("Locate original evidence")}>{t(overview.cards[id]?.title||id)} <span>↗</span></button>) : <span>{t("Canvas region · your drawing is attached")}</span>}</div>}
      <div className={s.selectionActions}>{selectedIds.length > 0 && <button aria-expanded={inspect} onClick={() => setInspect(!inspect)}>{inspect ? t("Hide details ↑") : t("Inspect details ↓")}</button>}<button onClick={() => { onDiscuss(anchor,t("I think there is an error here: ")); }}>{t("Flag an error")}</button></div>
        {inspect && focused && <div className={s.inspector}>
          {selectedIds.length > 1 && <p>{t("Details")} · {t(overview.cards[focused.id].title)}</p>}
          <h3>{t(overview.cards[focused.id].title)}</h3><p>{t(focused.description)}</p>
          {preview?.entities.find(item=>item.id===focused.id)&&<div className={s.changeDetail}><strong>{t("Proposed change")}</strong><ul>{preview.entities.find(item=>item.id===focused.id)!.details.map(detail=><li key={detail}>{t(detail)}</li>)}</ul></div>}
          <dl>{focused.fields.map(f => <div key={t(f.name)}><dt>{t(f.name)}</dt><dd>{f.value}<small>{f.status === "reported" ? t("Reported in source") : f.status === "implementation" ? t("Implementation proposal") : t("Needs review")}</small></dd></div>)}</dl>
          {focused.kind === "procedure" && <div className={s.stepDetails}><h4>{t("Steps")}</h4>{study.procedure.map((step,i) => <div key={step.id}><button disabled={!step.evidence.quote.trim()&&!step.evidence.rects.length} onClick={() => onSource(focused.id, step.evidence)}>{i+1}. {t(step.name)} ↗</button><dl><dt>{t("Input")}</dt><dd>{t(step.input)}</dd><dt>{t("Person")}</dt><dd>{t(step.actor)}</dd><dt>{t("Output")}</dt><dd>{t(step.output)}</dd></dl></div>)}</div>}
          <details><summary>{t("Variables used here")} ({study.variables.filter(v => v.entity === focused.id).length})</summary>{study.variables.filter(v => v.entity === focused.id).map(v => <div className={s.variable} key={v.id}><code>{v.name}</code><p>{v.role} · {v.type} · {v.unit}</p><small>{v.producedBy} → {v.usedBy}</small><p>{v.definition}</p></div>)}</details>
          <blockquote>{focused.evidence.quote||t("Source not located")}</blockquote><button className={s.sourceLink} disabled={!focused.evidence.quote.trim()&&!focused.evidence.rects.length} onClick={() => onSource(focused.id, focused.evidence)}>{t("Source")} · p. {pageNumber(focused.evidence.page)} ↗</button>
        </div>}

    </div>}
  </>}
  </section>;
}
