'use client';

import { useId, useState } from 'react';
import type { StudySchema } from '@/app/build-preview/study-schema';
import type { HumanProgram } from '@/lib/studio/human-program';
import { branchChoices, branchPaths, programGraph, FLOW_CARD_WIDTH as W, FLOW_CARD_HEIGHT as H, type ProgramGraph, type ProgramView } from '@/lib/studio/program-views';
import s from './program-visuals.module.css';

type Props = { model: StudySchema; view: ProgramView; studyId?: string; selectedIds: string[]; changedIds?: ReadonlySet<string>; issueIds: ReadonlySet<string>; onPick: (id: string, extend?: boolean) => void; onDiscuss: (id: string, draft?: string) => void };

function Diagram({ graph, program, selectedIds, changedIds, issueIds, onPick, emphasis }: Omit<Props, 'model' | 'view' | 'studyId' | 'onDiscuss'> & { graph: ProgramGraph; program: HumanProgram; emphasis?: ReadonlySet<string> }) {
  const marker = useId().replace(/:/g, '');
  const positions = new Map(graph.positions.map(p => [p.id, p]));
  return <div className={s.diagram}><svg width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} role="group" aria-label="Experimental flow">
    <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="var(--accent,#155e75)"/></marker></defs>
    {graph.links.map((e, i) => {
      const a = positions.get(e.from)!, b = positions.get(e.to)!;
      const x = a.x + W / 2, y = a.y + H, toX = b.x + W / 2, toY = b.y;
      const returning = b.y <= a.y;
      const path = returning ? `M${a.x + W},${a.y + H / 2} C${a.x + W + 26},${a.y + H / 2 - 36} ${b.x + W + 26},${b.y + H / 2 + 36} ${b.x + W},${b.y + H / 2}` : `M${x},${y} C${x},${y + 24} ${toX},${toY - 24} ${toX},${toY}`;
      const dim = emphasis && (!emphasis.has(e.from) || !emphasis.has(e.to));
      return <g key={`${e.from}:${e.to}:${i}`} className={dim ? s.dimLink : ''}><path data-flow-from={e.from} data-flow-to={e.to} d={path} fill="none" stroke="var(--accent,#155e75)" strokeOpacity={e.kind === 'contains' ? '.35' : '.6'} strokeWidth="1.5" strokeDasharray={e.kind === 'contains' ? '4 4' : undefined} markerEnd={e.kind === 'contains' ? undefined : `url(#${marker})`}/>{e.label && <g><rect x={(x + toX) / 2 - 72} y={(y + toY) / 2 - 9} width="144" height="18" rx="5" fill="var(--surface,#fff)"/><text x={(x + toX) / 2} y={(y + toY) / 2 + 3} textAnchor="middle" className={s.edgeLabel}><title>{e.label}</title>{e.label.length > 24 ? e.label.slice(0, 23) + '…' : e.label}</text></g>}</g>;
    })}
    {graph.steps.map(step => {
      const p = positions.get(step.id)!, id = `flow:${step.id}`;
      const actor = step.actorIds.map(id => program.nodes.find(n => n.id === id)?.title || id).join(', ');
      const colon=step.title.indexOf(':');
      const prefix=colon>0&&colon<50?step.title.slice(0,colon):'';
      const title=prefix?step.title.slice(colon+1).trim():step.title;
      return <foreignObject key={id} x={p.x} y={p.y} width={W} height={H}>
        <button type="button" data-model-id={id} data-event={`model.object.${id}`} className={`${s.flowNode} ${s[step.kind] || ''} ${selectedIds.includes(id) ? s.selected : ''} ${changedIds?.has(id) ? s.changed : ''} ${emphasis && !emphasis.has(step.id) ? s.dim : ''}`} aria-label={`Inspect ${step.title}`} aria-pressed={selectedIds.includes(id)} title={step.title} onClick={e => onPick(id, e.shiftKey)}>
          <span className={s.nodeTop}><small title={prefix||actor}>{prefix||(step.kind === 'action' ? actor || 'Action' : step.kind)}</small>{issueIds.has(id) && <span className={s.questionMark} aria-label="Needs input">!</span>}</span>
          <strong>{title}</strong><span className={s.nodeMeta}>{step.inputIds.length > 0 && <span>{step.inputIds.length} input{step.inputIds.length > 1 ? 's' : ''}</span>}{step.inputIds.length > 0 && step.outputIds.length > 0 && <span>→</span>}{step.outputIds.length > 0 && <span>{step.outputIds.length} output{step.outputIds.length > 1 ? 's' : ''}</span>}</span>
        </button>
      </foreignObject>;
    })}
  </svg></div>;
}

export default function ProgramVisuals(props: Props) {
  const { model, view, studyId, onPick, onDiscuss } = props;
  const program = model.program;
  const [branchId, setBranchId] = useState(''), [choice, setChoice] = useState('');
  const branches = program ? branchChoices(program, studyId) : [];
  const branch = branches.find(b => b.id === branchId) || branches[0];
  const contrast = program && branch ? branchPaths(program, branch.id) : null;
  const chosen = contrast?.paths.find(p => p.id === choice) || contrast?.paths[0];
  const [leftId, setLeftId] = useState(''), [rightId, setRightId] = useState('');
  const left = contrast?.paths.find(p => p.id === leftId) || contrast?.paths[0];
  const right = contrast?.paths.find(p => p.id === rightId && p.id !== left?.id) || contrast?.paths.find(p => p.id !== left?.id);
  const scoped = model.entities.filter(n => !studyId || !n.studyIds?.length || n.studyIds.includes(studyId));
  const flowIds=new Set(program?.steps.map(step=>`flow:${step.id}`)||[]);
  const supporting = scoped.filter(node=>!flowIds.has(node.id));
  const kindOf=(node:StudySchema['entities'][number])=>program?.nodes.find(n=>n.id===node.id)?.kind||node.kind;
  const groups = [
    { title: 'Background & hypotheses', kinds: ['background', 'hypothesis'] },
    { title: 'Study design', kinds: ['design', 'participants', 'material', 'procedure'] },
    { title: 'Data & findings', kinds: ['record', 'variable', 'analysis', 'result'] },
  ];
  const known = new Set(groups.flatMap(group=>group.kinds));
  const other = [...new Set(supporting.filter(n=>!known.has(kindOf(n))).map(kindOf))];
  if(other.length)groups.push({title:'Other details',kinds:other});
  const graph = program ? programGraph(program, studyId) : undefined;
  const branchControl = branch && <select data-event={`program.branch.${branch.id}`} aria-label="Condition branch" value={branch.id} onChange={e => { setBranchId(e.target.value); setChoice(''); setLeftId(''); setRightId(''); }}>{branches.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}</select>;
  const summary = (ids: ReadonlySet<string>, label: string) => program && ids.size > 0 && <details className={s.shared}><summary>{label} <span>{ids.size}</span></summary><div>{program.steps.filter(step => ids.has(step.id)).map(step => <button key={step.id} data-model-id={`flow:${step.id}`} onClick={() => onPick(`flow:${step.id}`)}>{step.title}</button>)}</div></details>;
  return <div className={s.visuals}>
    <div className={s.context}>{groups.map(group => { const items = supporting.filter(n => group.kinds.includes(kindOf(n))); return items.length > 0 && <details key={group.title}><summary>{group.title}<span>{items.length}</span></summary><div>{items.map(n => <button key={n.id} data-model-id={n.id} aria-pressed={props.selectedIds.includes(n.id)} onClick={e => onPick(n.id, e.shiftKey)}>{n.title}{props.issueIds.has(n.id) && <span className={s.questionMark}>!</span>}</button>)}</div></details>; })}</div>
    {graph && graph.wrappers.length > 0 && <div className={s.wrapper}>{graph.wrappers.map(w => <button key={w.id} data-model-id={`flow:${w.id}`} onClick={() => onPick(`flow:${w.id}`)}>{w.kind} · {w.title}</button>)}</div>}
    {view !== 'flow' && branches.length > 0 && <div className={s.pathControls}>{branchControl}{view === 'paths' && <div className={s.choices}>{contrast!.paths.map(path => <button key={path.id} data-event={`program.path.${path.id}`} title={path.title} aria-pressed={chosen?.id === path.id} onClick={() => setChoice(path.id)}>{path.title}</button>)}</div>}</div>}
    {view === 'compare' && program && !branches.length && !studyId && program.studies.filter(s=>s.type==='empirical').length>1 ? <div className={s.studyComparison}>{program.studies.filter(s=>s.type==='empirical').map(scope=><section key={scope.id}><h2>{scope.title}</h2>{scope.description&&<details><summary>Study context</summary><p>{scope.description}</p></details>}{program.steps.some(s=>s.studyId===scope.id)?<Diagram {...props} program={program} graph={programGraph(program,scope.id)}/>:<p className={s.mappingNote}>Flow not mapped for this study.</p>}</section>)}</div> : view === 'compare' && contrast && left && right ? <>
      {summary(contrast.before, 'Shared start')}
      <div className={s.comparison}>{[left, right].map((path, i) => <section key={i} aria-label={i === 0 ? 'First path' : 'Second path'}><header><span>{i === 0 ? 'A' : 'B'}</span><select data-event={`program.compare.${i}.${path.id}`} aria-label={i === 0 ? 'First condition' : 'Second condition'} value={path.id} onChange={e => { if (i === 0) setLeftId(e.target.value); else setRightId(e.target.value); }}>{contrast.paths.filter(p => i === 0 || p.id !== left.id).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></header><Diagram {...props} program={program!} graph={programGraph(program!, branch!.studyId, path.unique)}/></section>)}</div>
      {summary(contrast.shared, 'Shared continuation')}
    </> : graph && graph.steps.length > 0 ? <Diagram {...props} program={program!} graph={graph} emphasis={view === 'paths' && chosen && contrast ? new Set([...chosen.unique, ...contrast.shared, ...contrast.before, branch!.id]) : undefined}/> : <div className={s.unspecified}><p>The execution flow has not been mapped yet.</p>{scoped.filter(n => n.kind === 'procedure').map(n => <button key={n.id} data-model-id={n.id} onClick={() => onPick(n.id)}>{n.title}</button>)}<button className={s.ask} onClick={() => onDiscuss(scoped.find(n => n.kind === 'design')?.id || scoped[0]?.id || '', 'Map the documented participant procedure into explicit steps and connections. Preserve unknown order and conditions as questions rather than inventing them.')}>Ask agent to map the flow</button></div>}
    {view !== 'flow' && !branches.length && !(view==='compare'&&!studyId&&program&&program.studies.filter(s=>s.type==='empirical').length>1) && <p className={s.mappingNote}>No condition paths are mapped in this program.{scoped.length > 0 && <button onClick={() => onDiscuss(scoped.find(n => n.kind === 'design')?.id || scoped[0].id, 'Check whether this study has different conditions. Map only the documented conditions and their step paths, and flag missing assignments.')}>Check with agent ↗</button>}</p>}
  </div>;
}
