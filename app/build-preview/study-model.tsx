"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { study as exampleStudy, type StudySchema, type Evidence } from "./study-schema";
import { intersectsPolygon, modelOverview, modelIssues, type ModelAnchor, type Point, type ReviewResponse } from "./model-review";
import s from "./study-model.module.css";
import { useT } from "./ui";
import Materials from "@/components/studio/materials";
import type { StudioArtifact } from "@/lib/studio/types";

type Props = {
  model?:StudySchema;
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

export default function StudyModel({ model, artifacts=[], onDiscussArtifact, busy, selected, anchor, responses, onSelect, onSource, onDiscuss, onRespond }: Props) {
  const study=model||exampleStudy;
  const pageNumber=(n:number)=>study.id===exampleStudy.id?1160+n:n;
  const overview=modelOverview(study), reviewIssues=modelIssues(study);
  const [materialsOpen,setMaterialsOpen]=useState(false);
  const [tool, setTool] = useState<"select" | "circle">("select");
  const [ink, setInk] = useState<Point[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [inspect, setInspect] = useState(false);
  const t=useT();
  const [replyDrafts, setReplyDrafts] = useState<Record<string,string>>({});
  const [notice, setNotice] = useState("");
  const canvas = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const drawing = useRef<Point[] | null>(null);
  const suppressClick = useRef(false);
  const needsInput = reviewIssues.filter(i => !responses[i.id]);
  const issue = reviewIssues.find(i => i.id === anchor?.issueId);
  const reply=issue?(replyDrafts[issue.id]??responses[issue.id]?.text??""):"";
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
    setInspect(false); setNotice("");
  }
  function openIssue(id: string) {
    const next = reviewIssues.find(i => i.id === id)!;
    onSelect({ kind: "issue", entityIds: [next.entity], issueId: id });
    setInspect(false); setNotice("");
    setReviewOpen(false);
    requestAnimationFrame(() => canvas.current?.querySelector<HTMLElement>(`[data-model-id="${next.entity}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
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
      setInspect(false); setNotice("");
      onDiscuss(next);
    }
    setTool("select"); setInk([]);
    // The pointer-up is followed by a click; do not turn a lasso into a single selection.
    setTimeout(() => { suppressClick.current = false; }, 0);
  }

  return <section data-event="model.panel" className={s.model} aria-label="Study model and data schema">
    <header className={s.heading}><div><strong>{t("Study model")}</strong><small>{t("Overview · source-linked draft")}</small></div><div className={s.headerActions}>{onDiscussArtifact&&<button aria-pressed={materialsOpen} onClick={()=>setMaterialsOpen(!materialsOpen)}>{t("Materials")} <span>{artifacts.length}</span></button>}<button className={s.needsInput} aria-expanded={reviewOpen} onClick={() => {setMaterialsOpen(false);setReviewOpen(!reviewOpen);}}><span>{needsInput.length}</span> {t("Need input")}</button></div></header>
    {materialsOpen&&onDiscussArtifact?<Materials artifacts={artifacts} onDiscuss={onDiscussArtifact}/>:<>
    <div className={s.toolbar}><div><button aria-pressed={tool === "select"} className={tool === "select" ? s.activeTool : ""} onClick={() => setTool("select")}>{t("↖ Select")}</button><button aria-pressed={tool === "circle"} className={tool === "circle" ? s.activeTool : ""} onClick={() => { setTool("circle"); setInspect(false); }}>{t("◯ Circle to ask")}</button></div><button aria-label={t("Return to full study overview")} onClick={() => { onSelect(null); setReviewOpen(false); setTool("select"); scroll.current?.scrollTo({ top: 0, behavior: "smooth" }); }}>{t("⌂ Overview")}</button></div>
    {reviewOpen && <div className={s.reviewList} aria-label="Study review queue"><div><strong>{t("What needs your judgment")}</strong><button aria-label={t("Close review queue")} onClick={() => setReviewOpen(false)}>×</button></div><p>{t("Questions linked to the affected part of the study.")}</p>{reviewIssues.map(i => <button key={i.id} onClick={() => openIssue(i.id)}><span className={responses[i.id] ? s.responded : s.issueDot}>{responses[i.id] ? "✓" : "!"}</span><span><strong>{t(i.title)}</strong><small>{responses[i.id] ? t("Response saved · pending application") : t(i.type)} · {t(overview.cards[i.entity].title)}</small></span><span>↗</span></button>)}</div>}
    <div className={s.scroll} ref={scroll}>
      <div className={s.overviewHeading}><span>{t("THE STUDY AT A GLANCE")}</span><h1>{t(overview.question)}</h1></div>
      {study.entities.length===0&&<p className={s.gestureHint}>{t("Upload a paper, then ask the agent to build the first model.")}</p>}
      <div className={s.gestureHint}>{tool === "circle" ? t("Draw a loop around anything you want to discuss.") : t("Click to inspect or ask · Shift-click to select several · Circle a region")}</div>
      <div data-event="model.canvas" ref={canvas} className={`${s.canvas} ${tool === "circle" ? s.circling : ""}`} onPointerDown={startCircle} onPointerMove={moveCircle} onPointerUp={finishCircle} onPointerCancel={() => { drawing.current = null; setInk([]); suppressClick.current = false; setTool("select"); }}>
        {overview.stages.map((stage, index) => <section key={stage.id} className={s.stage} aria-label={t(stage.title)}>
          <div className={s.stageLabel}><span>{String(index + 1).padStart(2, "0")}</span><div><h2>{t(stage.title)}</h2><small>{t(stage.subtitle)}</small></div></div>
          <div className={s.cards}>{stage.nodes.map(id => {
            const card = overview.cards[id];
            const problems = reviewIssues.filter(i => i.entity === id && !responses[i.id]);
            return <div key={id} data-model-id={id} data-event={`model.object.${id}`} className={`${s.card} ${["procedure","record"].includes(study.entities.find(entity=>entity.id===id)?.kind||"") || id === "manipulation" ? s.wide : ""} ${selectedIds.includes(id) ? s.selectedCard : ""} ${problems.length ? s.flagged : ""}`}>
              <button className={s.cardBody} aria-label={`Select ${t(card.title)}`} aria-pressed={selectedIds.includes(id)} onClick={e => pick(id, e.shiftKey)}><strong>{t(card.title)}</strong><p>{t(card.text)}</p></button>
              {problems.map(i => <button key={i.id} className={s.cardIssue} onClick={() => { if (tool !== "circle" && !suppressClick.current) openIssue(i.id); }} aria-label={`Review: ${t(i.title)}`}><span>!</span>{t(i.title)}<span>↗</span></button>)}
            </div>;
          })}</div>
        </section>)}
        <svg className={s.ink} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{path.length > 1 && <polygon points={path.map(p => `${p.x},${p.y}`).join(" ")} vectorEffect="non-scaling-stroke"/>}</svg>
      </div>
      <div className={s.legend}><span><i/> Source-linked draft</span><span><i/> Need input</span></div>
    </div>
    {anchor && <div className={`${s.dock} ${!issue&&!inspect?s.compactDock:""}`} aria-label="Study model selection">
      <div className={s.dockHeader}><span>{issue ? t(issue.type) : `${t(anchor.kind === "lasso" ? "Circled region" : "Model selection")} · ${selectedIds.length} ${t("objects")}`}</span><button aria-label={t("Clear model selection")} onClick={() => { onSelect(null); setNotice(""); }}>×</button></div>
      {(issue||inspect)&&<div className={s.selectedNames}>{selectedIds.length ? selectedIds.map(id => <button key={id} disabled={!study.entities.find(e=>e.id===id)?.evidence.quote.trim()&&!study.entities.find(e=>e.id===id)?.evidence.rects.length} onClick={() => onSource(id)} title={t("Locate original evidence")}>{t(overview.cards[id]?.title||id)} <span>↗</span></button>) : <span>{t("Canvas region · your drawing is attached")}</span>}</div>}
      {issue ? <div className={s.issueDetail} key={issue.id}>
        <h3>{t(issue.title)}</h3><p>{t(issue.question)}</p><p><strong>{t("Why it matters")}</strong> {t(issue.impact)}</p>
        <button className={s.sourceLink} disabled={!issue.evidence.quote.trim()&&!issue.evidence.rects.length} onClick={() => onSource(issue.entity, issue.evidence)}>{issue.evidence.quote.trim()||issue.evidence.rects.length?`${t("Source")} · p. ${pageNumber(issue.evidence.page)} ↗`:t("Source not located")}</button>
        <details><summary>{t("Evidence & suggested next step")}</summary><blockquote>{issue.evidence.quote}</blockquote><p>{t(issue.suggestion)}</p></details>
        <label htmlFor="review-response">{t("Your correction or decision")}</label><textarea id="review-response" value={reply} onChange={e => setReplyDrafts({...replyDrafts,[issue.id]:e.target.value})} placeholder={t("Describe the correction, supply evidence, or specify a study decision…")}/>
        <div className={s.issueActions}><button onClick={() => { onDiscuss(anchor,reply.trim()||`Help me review: ${t(issue.title)}. ${t(issue.question)}`); }}>{t("Discuss with AI ↗")}</button><button className={s.primary} disabled={!reply.trim()} onClick={() => { onRespond(issue.id, reply.trim()); setNotice(t("Response saved. Discuss it with the agent to update the model.")); }}>{t("Save response")}</button></div>
        {responses[issue.id] && <small className={s.savedState}>{t("✓ Response saved · pending application to the program")}</small>}
      </div> : <>
        <div className={s.selectionActions}>{selectedIds.length > 0 && <button aria-expanded={inspect} onClick={() => setInspect(!inspect)}>{inspect ? t("Hide details ↑") : t("Inspect details ↓")}</button>}<button onClick={() => { onDiscuss(anchor,t("I think there is an error here: ")); }}>{t("Flag an error")}</button></div>
        {inspect && focused && <div className={s.inspector}>
          {selectedIds.length > 1 && <p>{t("Details")} · {t(overview.cards[focused.id].title)}</p>}
          <h3>{t(overview.cards[focused.id].title)}</h3><p>{t(focused.description)}</p>
          <dl>{focused.fields.map(f => <div key={t(f.name)}><dt>{t(f.name)}</dt><dd>{f.value}<small>{f.status === "reported" ? t("Reported in source") : f.status === "implementation" ? t("Implementation proposal") : t("Needs review")}</small></dd></div>)}</dl>
          {focused.kind === "procedure" && <div className={s.stepDetails}><h4>{t("Inside one trial")}</h4>{study.procedure.map((step,i) => <div key={step.id}><button disabled={!step.evidence.quote.trim()&&!step.evidence.rects.length} onClick={() => onSource(focused.id, step.evidence)}>{i+1}. {t(step.name)} ↗</button><dl><dt>{t("Input")}</dt><dd>{t(step.input)}</dd><dt>{t("Person")}</dt><dd>{t(step.actor)}</dd><dt>{t("Output")}</dt><dd>{t(step.output)}</dd></dl></div>)}</div>}
          <details><summary>{t("Variables used here")} ({study.variables.filter(v => v.entity === focused.id).length})</summary>{study.variables.filter(v => v.entity === focused.id).map(v => <div className={s.variable} key={v.id}><code>{v.name}</code><p>{v.role} · {v.type} · {v.unit}</p><small>{v.producedBy} → {v.usedBy}</small><p>{v.definition}</p></div>)}</details>
          <blockquote>{focused.evidence.quote||t("Source not located")}</blockquote><button className={s.sourceLink} disabled={!focused.evidence.quote.trim()&&!focused.evidence.rects.length} onClick={() => onSource(focused.id, focused.evidence)}>{t("Source")} · p. {pageNumber(focused.evidence.page)} ↗</button>
        </div>}

      </>}
      {notice && <p className={s.notice} role="status">{notice}</p>}
    </div>}
    <footer className={s.footer}><span>{needsInput.length ? `${needsInput.length} ${t("decisions need input")}` : t("No open questions")}{Object.keys(responses).length > 0 && ` · ${Object.keys(responses).length} ${t("pending application")}`}</span><button onClick={() => setReviewOpen(!reviewOpen)}>{t("Review →")}</button></footer>
  </>}
  </section>;
}
