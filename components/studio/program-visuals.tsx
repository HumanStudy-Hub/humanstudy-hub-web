'use client';

import { useId } from 'react';
import type { HumanProgram } from '@/lib/studio/human-program';
import { FLOW_CARD_WIDTH as W, FLOW_CARD_HEIGHT as H, type ProgramGraph } from '@/lib/studio/program-views';
import s from './program-visuals.module.css';

type Props = { program: HumanProgram; studyId?: string; selectedIds: string[]; changedIds?: ReadonlySet<string>; issueIds: ReadonlySet<string>; onPick: (id: string, extend?: boolean) => void };

/** The step graph as a directed diagram. Links come only from `next` and typed containment. */
export function Diagram({ graph, program, selectedIds, changedIds, issueIds, onPick, emphasis }: Pick<Props, 'program' | 'selectedIds' | 'changedIds' | 'issueIds' | 'onPick'> & { graph: ProgramGraph; emphasis?: ReadonlySet<string> }) {
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

const groups = [
  { title: 'Background & hypotheses', kinds: ['background', 'hypothesis'] },
  { title: 'Study design', kinds: ['design', 'participants', 'material', 'procedure'] },
  { title: 'Data & findings', kinds: ['record', 'variable', 'analysis', 'result'] },
];

/** Every non-step node in scope, collapsed by kind group. Custom kinds stay inspectable under Other details. */
export function ContextGroups({ program, studyId, selectedIds, issueIds, onPick }: Omit<Props, 'changedIds'>) {
  const scoped = program.nodes.filter(n => !studyId || !n.studyIds.length || n.studyIds.includes(studyId));
  const known = new Set(groups.flatMap(g => g.kinds));
  const other = [...new Set(scoped.filter(n => !known.has(n.kind)).map(n => n.kind))];
  return <div className={s.context}>{[...groups, ...(other.length ? [{ title: 'Other details', kinds: other }] : [])].map(group => {
    const items = scoped.filter(n => group.kinds.includes(n.kind));
    return items.length > 0 && <details key={group.title}><summary>{group.title}<span>{items.length}</span></summary><div>{items.map(n => <button key={n.id} data-model-id={n.id} aria-pressed={selectedIds.includes(n.id)} onClick={e => onPick(n.id, e.shiftKey)}>{n.title}{issueIds.has(n.id) && <span className={s.questionMark}>!</span>}</button>)}</div></details>;
  })}</div>;
}
