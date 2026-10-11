'use client';

import Link from 'next/link';
import { useState } from 'react';
import StudyModel from '@/app/build-preview/study-model';
import type { Evidence } from '@/app/build-preview/study-schema';
import type { ModelAnchor } from '@/app/build-preview/model-review';
import { projectHumanProgram, validateHumanProgram } from '@/lib/studio/human-program';
import { supportedBy } from '@/lib/studio/program-view';
import mobile from './design-cases/mobile-internet.json';
import game from './design-cases/study_009.json';
import trust from './design-cases/study_012.json';
import vignette from './design-cases/study_005.json';
import knobe from '@/data/studio-samples/intentional-action/program.json';
import s from './design-review.module.css';

const knobeProgram = validateHumanProgram(knobe);
// The same program without its stated conditions or presentation plan, to show what a reviewer sees when the agent leaves them out.
const { presentation: _presentation, ...knobeRest } = knobeProgram.extensions ?? {}; void _presentation;
const knobeUnstated = validateHumanProgram({ ...knobeProgram, extensions: knobeRest, nodes: knobeProgram.nodes.filter(n => n.kind !== 'condition').map(({ conditionIds: _c, ...n }) => { void _c; return n; }), steps: knobeProgram.steps.map(({ conditionIds: _c, ...st }) => { void _c; return st; }) });
const examples = [
  { id: 'mobile', label: 'Mobile internet · two arms, three waves', program: validateHumanProgram(mobile) },
  { id: 'knobe', label: 'Side effects · conditions stated', program: knobeProgram },
  { id: 'knobe-unstated', label: 'Side effects · conditions not stated', program: knobeUnstated },
  { id: 'trust', label: 'Trust game · sequential interaction', program: validateHumanProgram(trust) },
  { id: 'game', label: 'Guessing game · repeated rounds', program: validateHumanProgram(game) },
  { id: 'vignette', label: 'Vignettes · unmapped flow', program: validateHumanProgram(vignette) },
];

/** An isolated public design review, not a second project entry or a mock agent.
 * Editor versions below use the same production renderer and anchor callbacks. */
export default function DesignReview({ initialCase }: { initialCase?: string }) {
  const [caseId, setCaseId] = useState(examples.some(e=>e.id===initialCase)?initialCase!:'mobile');
  const [passage, setPassage] = useState<{ page: number; text: string } | null>(null);
  const [anchor, setAnchor] = useState<ModelAnchor|null>(null), [quote, setQuote] = useState<Evidence|null>(null);
  const [draft, setDraft] = useState(''), [context, setContext] = useState('');
  const [notes, setNotes] = useState<{ caseId: string; context: string; text: string }[]>([]);
  const sample = examples.find(e=>e.id===caseId)!;
  // These examples do not load/index attached PDFs. Do not inherit the agent's
  // claimed verification status in a public view lacking that source text.
  const model = projectHumanProgram({...sample.program,evidence:sample.program.evidence.map(e=>({...e,verification:'unverified' as const}))});
  const [selected,setSelected] = useState('');
  const updateUrl = (nextCase: string) => history.replaceState(null, '', `?case=${nextCase}`);
  // Without the PDF, the cited quotes stand in for passages a reviewer would select in the paper.
  const passages = sample.program.evidence.filter(e => e.quote && e.locator.page);
  function discuss(next: ModelAnchor, text?: string) {
    setAnchor(next); setContext(next.entityIds.map(id=>model.entities.find(e=>e.id===id)?.title||id).join(', ') || 'Whole program');
    setDraft(text||''); document.getElementById('view-feedback')?.focus();
  }
  return <div className={s.shell}>
    <header className={s.header}><Link href="/">HumanStudy-Hub</Link><span>Visual design review</span><Link href="/build">Open study editor ↗</Link></header>
    <div className={s.workspace}>
      <aside className={s.review} aria-label="Design review notes">
        <label htmlFor="review-case">Study</label><select id="review-case" value={caseId} onChange={e=>{setCaseId(e.target.value);setAnchor(null);setSelected('');setQuote(null);setPassage(null);setContext('');updateUrl(e.target.value);}}>{examples.map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select>
        <div className={s.intro}><h1>Read the experiment.<br/>Check every claim.</h1><p>Open a step to see its rule, materials and records. Every item links to the passage it comes from; items without one say so.</p></div>
        <div className={s.noteList}>{notes.map((note,i)=><article key={i}><small>{examples.find(e=>e.id===note.caseId)?.label}</small>{note.context&&<strong>{note.context}</strong>}<p>{note.text}</p></article>)}</div>
        {quote&&<details className={s.quote} open><summary>Source passage · p. {quote.page}</summary><blockquote>{quote.quote||'Open the original paper to check this passage.'}</blockquote><small>Check against the original; this view does not certify the quote.</small></details>}
        {passages.length>0&&<details className={s.quote}><summary>Select a passage · {passages.length}</summary>{passages.map(e=><button key={e.id} type="button" aria-pressed={passage?.text===e.quote} onClick={()=>setPassage(passage?.text===e.quote?null:{page:e.locator.page!,text:e.quote!})}>p. {e.locator.page} · {e.quote!.slice(0,90)}{e.quote!.length>90?'…':''}</button>)}</details>}
        <form className={s.feedback} onSubmit={e=>{e.preventDefault();if(!draft.trim())return;setNotes(n=>[...n,{caseId,context,text:draft.trim()}]);setDraft('');setContext('');}}><label htmlFor="view-feedback">View feedback <span>Local notes</span></label>{context&&<p>{context}<button type="button" aria-label="Clear feedback context" onClick={()=>setContext('')}>×</button></p>}<textarea id="view-feedback" value={draft} onChange={e=>setDraft(e.target.value)} placeholder="What feels clearer? What should change?"/><button disabled={!draft.trim()}>Add note</button></form>
        <small className={s.disclaimer}>Public examples · notes stay in this tab.<br/>In the study editor, selections go to the real agent.</small>
      </aside>
      <StudyModel key={caseId} support={passage?{page:passage.page,ids:supportedBy(sample.program,passage)}:null} model={model} selected={selected} anchor={anchor} responses={{}} onSelect={next=>{setAnchor(next);setSelected(next?.entityIds[0]||'');}} onSource={(_,e)=>setQuote(e||null)} onDiscuss={discuss} onRespond={()=>{}}/>
    </div>
  </div>;
}
