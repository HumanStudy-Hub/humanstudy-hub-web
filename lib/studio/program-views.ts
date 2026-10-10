import type { HumanProgram, ProgramStep } from './human-program';

export type ProgramView = 'flow' | 'paths' | 'compare';
export type FlowLink = { from: string; to: string; label?: string; kind: 'next' | 'branch' | 'contains' };
export type FlowPosition = { id: string; x: number; y: number; rank: number };
export type ProgramGraph = { steps: ProgramStep[]; wrappers: ProgramStep[]; links: FlowLink[]; positions: FlowPosition[]; width: number; height: number };
export const FLOW_CARD_WIDTH = 208;
export const FLOW_CARD_HEIGHT = 108;

/** Layout metadata is disposable. No condition assignments or step order are
 * inferred from titles, field prose, source coordinates or array proximity. */
export function programGraph(program: HumanProgram, studyId?: string, onlyIds?: ReadonlySet<string>): ProgramGraph {
  const scoped = program.steps.filter(s => (!studyId || s.studyId === studyId) && (!onlyIds || onlyIds.has(s.id)));
  const incoming = new Set(scoped.flatMap(s => s.next.map(e => e.to)));
  const wrappers = scoped.filter(s => s.kind === 'sequence' && s.children.length > 0 && !s.next.length && !incoming.has(s.id));
  const wrapperIds = new Set(wrappers.map(s => s.id));
  const steps = scoped.filter(s => !wrapperIds.has(s.id));
  const ids = new Set(steps.map(s => s.id));
  const links: FlowLink[] = steps.flatMap(s => [
    ...s.next.filter(e => ids.has(e.to)).map(e => ({ from: s.id, to: e.to, label: e.when, kind: 'next' as const })),
    ...s.children.filter(id => ids.has(id)).map(to => ({ from: s.id, to, kind: s.kind === 'branch' ? 'branch' as const : 'contains' as const })),
  ]);
  // Strongly connected components keep valid feedback loops finite and visible.
  const adjacency = new Map(steps.map(s => [s.id, links.filter(e => e.from === s.id).map(e => e.to)]));
  let index = 0;
  const indices = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], stacked = new Set<string>(), components: string[][] = [];
  function visit(id: string) {
    indices.set(id, index); low.set(id, index++); stack.push(id); stacked.add(id);
    for (const to of adjacency.get(id) || []) {
      if (!indices.has(to)) { visit(to); low.set(id, Math.min(low.get(id)!, low.get(to)!)); }
      else if (stacked.has(to)) low.set(id, Math.min(low.get(id)!, indices.get(to)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = []; let node: string;
      do { node = stack.pop()!; stacked.delete(node); component.push(node); } while (node !== id);
      components.push(component);
    }
  }
  steps.forEach(s => { if (!indices.has(s.id)) visit(s.id); });
  const componentOf = new Map(components.flatMap((c, i) => c.map(id => [id, i] as const)));
  const ranks = components.map(() => 0), degree = components.map(() => 0);
  const successors = components.map(() => new Set<number>());
  links.forEach(e => {
    const from = componentOf.get(e.from)!, to = componentOf.get(e.to)!;
    if (from !== to && !successors[from].has(to)) { successors[from].add(to); degree[to]++; }
  });
  const queue = degree.flatMap((n, i) => n === 0 ? [i] : []);
  for (let q = 0; q < queue.length; q++) for (const to of successors[queue[q]]) {
    ranks[to] = Math.max(ranks[to], ranks[queue[q]] + 1);
    if (--degree[to] === 0) queue.push(to);
  }
  const rows = new Map<number, ProgramStep[]>();
  steps.forEach(s => { const r = ranks[componentOf.get(s.id)!]; rows.set(r, [...(rows.get(r) || []), s]); });
  const columns = Math.max(1, ...[...rows.values()].map(row => row.length));
  const width = columns * (FLOW_CARD_WIDTH + 36) + 48;
  const positions = [...rows].flatMap(([rank, row]) => row.map((s, col) => ({
    id: s.id, rank, x: (width - row.length * (FLOW_CARD_WIDTH + 36) + 36) / 2 + col * (FLOW_CARD_WIDTH + 36), y: 20 + rank * 156,
  })));
  return { steps, wrappers, links, positions, width, height: Math.max(156, (Math.max(0, ...ranks) + 1) * 156) };
}

export function branchChoices(program: HumanProgram, studyId?: string) {
  return program.steps.filter(s => s.kind === 'branch' && (!studyId || s.studyId === studyId) && s.children.length > 1);
}

/** Each alternative remains a referenced step. Shared continuation is computed
 * from actual connections; parallel operations are never called conditions. */
export function branchPaths(program: HumanProgram, branchId: string) {
  const branch = program.steps.find(s => s.id === branchId && s.kind === 'branch');
  if (!branch) return { branch: undefined, paths: [], shared: new Set<string>(), before: new Set<string>() };
  const steps = new Map(program.steps.filter(s => s.studyId === branch.studyId).map(s => [s.id, s]));
  const next = (id: string) => { const s = steps.get(id); return s ? [...s.next.map(e => e.to), ...(s.kind === 'branch' ? s.children : [])] : []; };
  const reachable = (start: string, stopAtDecision=true) => {
    const result = new Set<string>(), pending = [start];
    while (pending.length) {
      const id = pending.shift()!;
      if (id === branch.id || result.has(id) || !steps.has(id)) continue;
      result.add(id);
      // A later decision requires its own condition mapping. Reachability alone
      // cannot establish that both alternatives execute all later branches.
      if(!stopAtDecision||steps.get(id)!.kind!=='branch')pending.push(...next(id));
    }
    return result;
  };
  const paths = branch.children.filter(id => steps.has(id)).map(id => ({ id, title: steps.get(id)!.title, ids: reachable(id) }));
  const shared = new Set(paths[0] ? [...paths[0].ids].filter(id => paths.every(p => p.ids.has(id))) : []);
  const downstream = new Set(branch.children.flatMap(id=>[...reachable(id,false)]));
  // Reverse reachability gives common earlier steps without imposing array order.
  const before = new Set<string>(), pending = [branch.id];
  while (pending.length) {
    const id = pending.pop()!;
    for (const s of steps.values()) if (!before.has(s.id) && !downstream.has(s.id) && s.id !== branch.id && next(s.id).includes(id)) { before.add(s.id); pending.push(s.id); }
  }
  return { branch, paths: paths.map(p => ({ ...p, unique: new Set([...p.ids].filter(id => !shared.has(id))) })), shared, before };
}

export function programView(value: string | null | undefined): ProgramView {
  return value === 'paths' || value === 'compare' ? value : 'flow';
}
