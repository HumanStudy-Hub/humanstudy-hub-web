/**
 * One primary action per user operation on the web (T10; same rules as humanstudy-desktop
 * app/src/shared/research-operations.ts, docs/research-data.md "Causality (T10)").
 *
 * A user operation starts at a click, a keyboard shortcut, a command-palette choice or a composer
 * Enter. It gets one id. The first semantic product action seen for it (`action`) becomes its single
 * `action.invoke`, named by that action and carrying `metadata.via` (the input route). A generic
 * click / shortcut record is written only when no semantic action claimed the operation within
 * FALLBACK_MS. Completion records (`record`: selection, layout) made during the operation carry its
 * id as `actionId`; passive summaries (scroll, visibility) never do. A semantic action without a
 * user input in progress is a system operation of its own (`via: system`).
 *
 * Pure: no DOM, React or Node APIs, so the browser hook and the coverage test share this logic.
 */
import type { ActionVia } from './contract';

export const FALLBACK_MS = 300;
export type Metadata = Record<string, string | number | boolean>;
export type PrimaryType = 'click' | 'chat' | 'review';
export type RecordType = 'selection' | 'layout';
export interface OperationEvent { id?: string; target?: string; actionId?: string; metadata?: Metadata }
export interface OperationDeps {
  emit(type: PrimaryType | RecordType, fields: OperationEvent): void;
  uuid(): string;
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  microtask(fn: () => void): void;
}
export interface ActionOptions {
  /** Legacy stream type of the primary (chat send/build, proposal review, anything else). */
  type?: PrimaryType;
  metadata?: Metadata;
  /** Input route when no user input is in progress (a file chosen in the system picker). */
  via?: ActionVia;
  /** Always a new system operation (autosave, polling), never the current user input. */
  system?: boolean;
}

interface Op {
  id: string; target: string; via: ActionVia;
  /** Still inside the input event's synchronous dispatch. */
  sync: boolean;
  decided: boolean; decidedAt: number;
  /** Record a generic click/shortcut when nothing claims it (false for a composer Enter). */
  fallback: boolean;
  buffer: Array<[RecordType, Metadata | undefined]>;
  timer?: unknown;
}

/** "cmd+shift+k": modifiers plus a key name, as desktop capture.ts. No text is recorded. */
export function shortcutName(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key) || !(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase().replace('arrow', '');
  return [e.metaKey && 'cmd', e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', k].filter(Boolean).join('+');
}

export function createWebOperations(deps: OperationDeps) {
  let current: Op | null = null;

  function decide(op: Op): void {
    op.decided = true; op.decidedAt = deps.now();
    if (op.timer !== undefined) deps.cancel(op.timer);
    op.timer = undefined;
  }
  function primary(op: Op, type: PrimaryType, target: string, metadata?: Metadata): void {
    decide(op);
    deps.emit(type, { id: op.id, target, metadata: { ...metadata, via: op.via } });
    for (const [t, m] of op.buffer.splice(0)) deps.emit(t, { actionId: op.id, ...(m ? { metadata: m } : {}) });
  }
  function settle(op: Op): void {
    if (op.decided) return;
    if (op.fallback) return primary(op, 'click', op.target);
    // Nothing claimed an input that has no generic record (composer Enter): its records stand alone.
    decide(op);
    for (const [t, m] of op.buffer.splice(0)) deps.emit(t, m ? { metadata: m } : {});
  }

  /**
   * A user input begins an operation. `join`: a synthetic input (element.click() from a handler)
   * continues the operation in progress instead of starting one.
   */
  function input(target: string, via: ActionVia, opts: { fallback?: boolean; join?: boolean } = {}): string {
    if (current && (current.sync || (opts.join && !current.decided))) return current.id;
    if (current && !current.decided) settle(current);
    const op: Op = { id: deps.uuid(), target: target.slice(0, 160) || 'action', via, sync: true, decided: false, decidedAt: 0,
      fallback: opts.fallback !== false, buffer: [] };
    current = op;
    deps.microtask(() => {
      op.sync = false;
      if (!op.decided) op.timer = deps.later(() => { op.timer = undefined; settle(op); }, FALLBACK_MS);
    });
    return op.id;
  }

  /**
   * A semantic product action. It names the operation in progress (first claim wins) or, without
   * one, is a system operation of its own. Returns the operation id for server requests (actionId).
   */
  function action(name: string, opts: ActionOptions = {}): string {
    const op = opts.system ? null : current;
    const usable = op && (op.sync || !op.decided || deps.now() < op.decidedAt + FALLBACK_MS);
    if (!usable) {
      const id = deps.uuid(), via = opts.via ?? 'system';
      deps.emit(opts.type ?? 'click', { id, target: name.slice(0, 160), metadata: { ...opts.metadata, via } });
      return id;
    }
    // A later name for an already-named operation is the same operation; it is not recorded again.
    if (!op!.decided) { op!.target = name.slice(0, 160); primary(op!, opts.type ?? 'click', op!.target, opts.metadata); }
    return op!.id;
  }

  /** A completion record (final selection, layout change), linked to the operation that made it. */
  function record(type: RecordType, metadata?: Metadata): void {
    const op = current;
    if (op && !op.decided) { op.buffer.push([type, metadata]); return; }
    if (op && op.sync) { deps.emit(type, { actionId: op.id, ...(metadata ? { metadata } : {}) }); return; }
    deps.emit(type, metadata ? { metadata } : {});
  }

  /** Before the page hides or unmounts: write the pending operation's generic record now. */
  function settleAll(): void { if (current && !current.decided) settle(current); }

  return { input, action, record, settleAll };
}
export type WebOperations = ReturnType<typeof createWebOperations>;
