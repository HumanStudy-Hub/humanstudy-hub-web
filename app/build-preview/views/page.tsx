"use client";
import { useMemo, useState } from "react";
import StudyModel from "../study-model";
import type { ModelAnchor, ReviewResponse } from "../model-review";
import { projectHumanProgram, type HumanProgram } from "@/lib/studio/human-program";
import sample from "@/data/studio-samples/intentional-action/program.json";
import fixtures from "@/tests/fixtures/human-program-v2.json";
import mobile from "@/components/studio/design-cases/mobile-internet.json";
import w from "../workspace.module.css";
import s from "./views.module.css";

/** Auth-free bench for comparing Human Program views on real programs. Nothing is saved. */
const knobe=sample as unknown as HumanProgram;
const withoutPresentation=():HumanProgram=>{const {presentation:_,...rest}=knobe.extensions??{};void _;return {...knobe,extensions:rest};};
const fixture=(id:string)=>(fixtures as unknown as {cases:{id:string;program:HumanProgram}[]}).cases.find(c=>c.id===id)!.program;
const cases:{id:string;label:string;note:string;program:()=>HumanProgram}[]=[
 {id:"knobe",label:"Knobe 2003 · agent presentation",note:"Two experiments × harm/help. The build agent declared the conditions and which verbatim fields appear on each screen.",program:()=>knobe},
 {id:"knobe-inferred",label:"Knobe 2003 · inferred only",note:"Same program with extensions.presentation removed: conditions and screens are inferred from field names. Compare against the agent version.",program:withoutPresentation},
 {id:"mobile",label:"Castelo et al. 2025 · crossover RCT",note:"A real Build Study output (also in Codex's review). Conditions are branch steps; the second branch swaps the arms. Unreviewed agent output, not an approved study.",program:()=>mobile as unknown as HumanProgram},
 {id:"trust",label:"Berg et al. 1995 · two roles",note:"Two actors (Room A, Room B) with sequential visibility; the treatments are separate studies, so Compare switches to studies.",program:()=>fixture("study_012")},
 {id:"beauty",label:"Nagel 1995 · repeated game",note:"A repeat container with a nested interaction step.",program:()=>fixture("study_009")},
];

export default function ProgramViewBench(){
 const [caseId,setCaseId]=useState(cases[0].id),[theme,setTheme]=useState<"light"|"dark">("light");
 const [anchor,setAnchor]=useState<ModelAnchor|null>(null),[responses,setResponses]=useState<Record<string,ReviewResponse>>({}),[log,setLog]=useState("");
 const current=cases.find(c=>c.id===caseId)!;
 const model=useMemo(()=>projectHumanProgram(current.program()),[current]);
 return <div className={`${w.shell} ${s.bench}`} data-theme={theme}>
  <header className={s.bar}>
   <strong>Human Program views</strong>
   <select aria-label="Program" value={caseId} onChange={e=>{setCaseId(e.target.value);setAnchor(null);setLog("");}}>{cases.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select>
   <button onClick={()=>setTheme(theme==="light"?"dark":"light")}>{theme==="light"?"Dark":"Light"}</button>
   <span>{current.note}</span>
  </header>
  <main className={s.stage}>
   <aside className={s.notes}>
    <h2>Four views of one program</h2>
    <dl>
     <dt>Flow</dt><dd>Execution order. Actors become swimlanes, conditions fork into coloured lanes, repeats are containers. Before/after context shrinks to one line.</dd>
     <dt>Compare</dt><dd>Aligned rows per condition (or per study). Identical rows collapse; differing words are marked.</dd>
     <dt>Screens</dt><dd>What one participant actually sees, one condition at a time, built only from verbatim fields. Unreported details show as gaps.</dd>
     <dt>Outline</dt><dd>The current card view, kept for comparison.</dd>
    </dl>
    <p>Click anything to inspect it; amber badges open the question. Shift-click selects several.</p>
    {log&&<p className={s.log}>{log}</p>}
   </aside>
   <div className={s.panel}>
    <StudyModel key={caseId} model={model} selected={anchor?.entityIds[0]??""} anchor={anchor} responses={responses} onSelect={setAnchor} onSource={(id,e)=>setLog(`Would open the source for ${id}${e?.page?` · p. ${e.page}`:""}.`)} onDiscuss={(a,draft)=>setLog(`Would open the agent chat about ${a.issueId??a.entityIds.join(", ")}${draft?`: “${draft}”`:""}.`)} onRespond={(id,text)=>setResponses(r=>({...r,[id]:{text,savedAt:new Date().toISOString()}}))}/>
   </div>
  </main>
 </div>;
}
