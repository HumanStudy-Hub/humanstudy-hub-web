import type { HumanProgram } from './human-program';

/** Visual artifacts generated on request, after E2B Fragments: a template names what to make, the
 * model streams one self-contained HTML document, and the page renders it in an isolated iframe.
 * The program stays the source of truth; a view only arranges it and links back by id. */

export type ViewTemplate = { id:string; label:string; hint:string; instructions:string };
export const viewTemplates:ViewTemplate[]=[
 {id:'flow',label:'Participant flow',hint:'Steps, branches, loops and roles as a diagram',instructions:'Draw the participant flow as a diagram. Steps in order, with an arrow only where a next edge exists; branch alternatives side by side; repeats as loops; each role as a lane when there are several. Write "order not stated" where steps have no next edge.'},
 {id:'conditions',label:'Compare conditions',hint:'What differs between conditions, side by side',instructions:'Compare the experimental conditions side by side, aligned by where each difference happens in the procedure. Show shared steps once. Quote differing material text exactly and mark the differing words. If the program states no conditions, say so plainly instead of inferring them.'},
 {id:'screens',label:'Participant screens',hint:'What one participant sees, in order',instructions:'Preview, screen by screen, what one participant sees, using only participant-visible materials (visibleIds) and quoting their text exactly. Let the reader switch condition when conditions exist. Mark screen grouping, order or wording the program does not state as "not stated".'},
];

export const VIEW_CONTRACT=`You make one visual artifact for a researcher reviewing a Human Program: the structured description of a published human study, given below as JSON.

Rules:
- Use only what the program states. Never invent steps, conditions, wording, numbers or order. Where something is missing, show "not stated".
- Quote text from fields exactly. Keep each item's citation: show "p. N" from the evidence locator next to it when one exists.
- Give every element that shows a program item the attribute data-program-id set to that item's id (node id, or "flow:" + step id), so the researcher can click it to open the item and its source.
- Output one complete, self-contained HTML document: inline CSS and JavaScript only, no external requests, no fonts or libraries from the network. Use SVG for diagrams. Keep it clean, readable and calm; use the system font stack. It must work at 600px wide.
- Write one short sentence first, outside the document, saying what you made. Then the document between <artifact title="Short title"> and </artifact>. Nothing after it.`;

/** The program as the model sees it: everything except bulky extensions, capped in size. */
export function programContext(program:HumanProgram,studyId?:string):string{
 const scope=(ids:string[])=>!studyId||!ids.length||ids.includes(studyId);
 const slim={title:program.title,studies:program.studies.filter(s=>!studyId||s.id===studyId),
  nodes:program.nodes.filter(n=>scope(n.studyIds)),steps:program.steps.filter(s=>!studyId||s.studyId===studyId),
  relations:program.relations,evidence:program.evidence.map(e=>({id:e.id,page:e.locator.page,quote:e.quote?.slice(0,400)})),issues:program.issues};
 return JSON.stringify(slim).slice(0,180_000);
}

/** Splits a streamed reply into the opening sentence and the artifact, which may still be incomplete. */
export function parseView(text:string):{note:string;title:string;html:string;done:boolean}{
 const open=text.match(/<artifact(?:\s+title="([^"]*)")?\s*>/);
 if(!open)return {note:text.trim(),title:'',html:'',done:false};
 const start=open.index!+open[0].length,end=text.indexOf('</artifact>',start);
 return {note:text.slice(0,open.index).trim(),title:open[1]||'View',html:(end<0?text.slice(start):text.slice(start,end)).replace(/^\s*```html?\s*|\s*```\s*$/g,'').trim(),done:end>=0};
}

/** Runs inside the iframe: reports clicks on program items to the page, and nothing else. */
export const VIEW_BRIDGE=`<script>document.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-program-id]');if(el){e.preventDefault();parent.postMessage({type:'program-view-pick',id:el.getAttribute('data-program-id')},'*');}});</script><style>[data-program-id]{cursor:pointer}</style>`;
