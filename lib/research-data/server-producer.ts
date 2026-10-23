/**
 * Server-owned research producers for the web surface (contract v1, issue #27 / tracker T08).
 *
 * The Vercel server is the only web component that sees committed user messages, the agent's
 * received replies, the GitHub Actions dispatch (the web "tool call") and every committed Human
 * Program / artifact version. Those records are built HERE, from server state, never from browser
 * input. The browser may only reference its own primary UI action (`action_id`).
 *
 * Every committed change produces one self-contained batch: its own research session
 * (`session.start`, events, `session.end` with `captured_through_seq`) under install
 * `web-server`. Ids are derived from stable producer keys, so a replayed batch is the same rows.
 * Cross-request causality uses the same derivation (e.g. `tool.end.caused_by` = the id of the
 * dispatch `tool.start`), matching desktop research-agent.ts semantics:
 *   action.invoke -> agent.turn_start -> conversation.message(user) -> tool.start -> tool.end
 *   -> conversation.message(assistant) -> permission.request -> agent.turn_end
 *
 * Pure module: no Next, no network. Delivery lives in server-outbox.ts.
 */
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, EVENTS, LIMITS, scrubResearchString, scrubResearchValue, validateResearchEvent, type ContentRef, type ResearchEvent } from './contract';

export const SERVER_INSTALL_ID = 'web-server';
export const SERVER_COLLECTOR_VERSION = 'web-server-producer/1.0.0';
export const PIPELINE_TOOL = 'humanstudy.pipeline';

export interface ServerContent { sha256: string; bytes: number; mime: string; text: string }
export interface ServerBatch {
  /** = research_session_id of every event in the batch, and the outbox row id. */
  id: string;
  producer: string;
  project_id: string | null;
  events: ResearchEvent[];
  content: ServerContent[];
}
export interface ProducerContext { ownerId: string; email?: string | null; projectId: string; at?: string }
export interface ServerEventInput extends Omit<Partial<ResearchEvent>, 'id' | 'metadata' | 'event_type'> {
  /** Stable key; the event id is derived from it, so producers can reference it from later batches. */
  key: string;
  event_type: string;
  metadata?: Record<string, unknown>;
}

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

/** RFC 4122-shaped (version 4 / variant 8) uuid derived from a key; same derivation as archive-source. */
export function stableUuid(key: string): string {
  const h = sha(key).slice(0, 32).split('');
  h[12] = '4'; h[16] = '8';
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
/** Id of the server event with this producer key for this owner. */
export const serverEventId = (ownerId: string, key: string) => stableUuid(`web-server:${ownerId}:${key}`);
const json = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
const mimeFor = (role: string) => ['program', 'input', 'output', 'proposal', 'metadata', 'questions'].includes(role) ? 'application/json' : 'text/plain';

/**
 * Builds one batch. Metadata strings longer than the inline limit become content refs under the
 * same role (the complete value is kept, never clipped), as the desktop collector does.
 */
export function buildServerBatch(ctx: ProducerContext, producer: string, key: string, inputs: ServerEventInput[]): ServerBatch | null {
  if (!inputs.length) return null;
  const at = ctx.at ?? new Date().toISOString();
  const session = stableUuid(`web-server-session:${ctx.ownerId}:${key}`);
  const scrub = { email: ctx.email ?? null };
  const content = new Map<string, ServerContent>();
  const stage = (role: string, text: string): ContentRef => {
    const clean = scrubResearchString(text, scrub), hash = sha(clean), mime = mimeFor(role);
    if (!content.has(hash)) content.set(hash, { sha256: hash, bytes: utf8(clean), mime, text: clean });
    return { role, sha256: hash, bytes: utf8(clean), mime };
  };
  const base = {
    contract_version: CONTRACT_VERSION, surface: 'web' as const, platform: null, install_id: SERVER_INSTALL_ID,
    research_session_id: session, occurred_at: at, project_id: ctx.projectId, view: null, target: null,
    action_id: null, caused_by: null, thread_id: null, message_id: null, tool_call_id: null, source_id: null,
    artifact_id: null, artifact_version: null, duration_ms: null, app_version: 'web',
    collector_version: SERVER_COLLECTOR_VERSION, consent_version: 3,
  };
  const all: ServerEventInput[] = [
    { key: `${key}:session.start`, event_type: 'session.start', metadata: { collection_mode: 'server-producer', producer } },
    ...inputs,
  ];
  const events: ResearchEvent[] = all.map((input, index) => {
    const { key: eventKey, metadata: raw = {}, content_refs: givenRefs = [], ...fields } = input;
    const spec = EVENTS[input.event_type];
    if (!spec) throw new Error(`unknown research event ${input.event_type}`);
    const id = eventKey.endsWith(':session.start') ? stableUuid(`web-server-start:${ctx.ownerId}:${key}`) : serverEventId(ctx.ownerId, eventKey);
    const metadata = scrubResearchValue(raw, scrub) as Record<string, unknown>;
    const refs: ContentRef[] = [...givenRefs];
    for (const [k, v] of Object.entries(metadata)) {
      if (typeof v === 'string' && utf8(v) > LIMITS.inlineTextBytes) { refs.push(stage(k, v)); delete metadata[k]; }
    }
    if (utf8(JSON.stringify(metadata)) > LIMITS.metadataBytes) {
      const ref = stage('metadata', JSON.stringify(metadata)); refs.push(ref);
      for (const k of Object.keys(metadata)) {
        const v = metadata[k];
        if (!spec.metadata?.includes(k) && !spec.content?.includes(k)) delete metadata[k];
        else if (typeof v === 'object' && v !== null) metadata[k] = { content_ref: ref.sha256, key: k };
      }
    }
    const row: ResearchEvent = {
      ...base, ...fields, id, client_seq: index + 1, data_type: spec.dataType, event_type: input.event_type,
      ...(fields.target ? { target: scrubResearchString(fields.target, scrub).slice(0, LIMITS.targetChars) } : {}),
      ...(spec.primary ? { action_id: id } : {}), metadata, content_refs: refs,
    };
    return row;
  });
  const through = events.length + 1;
  events.push({ ...base, id: stableUuid(`web-server-end:${ctx.ownerId}:${key}`), client_seq: through, data_type: 'session',
    event_type: 'session.end', metadata: { captured_through_seq: through, reason: 'producer-committed' }, content_refs: [] });
  for (const event of events) {
    const errors = validateResearchEvent(event);
    if (errors.length) throw new Error(`invalid server research event ${event.event_type}: ${errors.join('; ')}`);
  }
  return { id: session, producer, project_id: ctx.projectId, events, content: [...content.values()] };
}

// ---- producer catalog ------------------------------------------------------------------------

type Ref = { conversationId: string; messageId: string };
const ms = (from?: string) => {
  const t = from ? Date.parse(from) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.min(86_400_000, Date.now() - t)) : 0;
};
export const turnStartId = (owner: string, requestId: string) => serverEventId(owner, `turn_start:${requestId}`);
export const toolStartId = (owner: string, jobId: string) => serverEventId(owner, `tool.start:${jobId}`);
export const serverActionId = (owner: string, requestId: string) => serverEventId(owner, `action:${requestId}`);

/**
 * The server's own primary action, for a request no browser operation named (an older client, a
 * system follow-up such as an automatic package sync or an autosave). T10: still exactly one
 * action.invoke per operation, `via: system`.
 */
export function systemActionEvent(key: string, target: string, view: string, parentActionId?: string | null): ServerEventInput {
  return { key, event_type: 'action.invoke', view, target, metadata: { via: 'system', server_generated: true, ...(parentActionId ? { parent_action_id: parentActionId } : {}) } };
}

export interface SubmitInput {
  requestId: string; conversationId: string; text: string; mode: 'build' | 'discuss'; jobId: string;
  /** The browser's own primary action.invoke id (chat send). Without it the server records one. */
  actionId?: string | null;
  sourceRecordId?: string; modelAnchor?: unknown; sourceSelection?: unknown;
  parent?: Ref; replyTo?: Ref; mergedFrom?: Ref;
  /** The enclosing operation when this message is sent while another turn runs (T10). */
  parentActionId?: string | null;
}
/** The committed user message (reservation save of the chat route). */
export function submitEvents(ctx: ProducerContext, s: SubmitInput): ServerEventInput[] {
  const action = s.actionId ?? serverActionId(ctx.ownerId, s.requestId), turn = turnStartId(ctx.ownerId, s.requestId);
  const out: ServerEventInput[] = [], parent = s.parentActionId && s.parentActionId !== action ? { parent_action_id: s.parentActionId } : {};
  if (!s.actionId) out.push(systemActionEvent(`action:${s.requestId}`, s.mode === 'build' ? 'build.start' : 'composer.send', 'agent', s.parentActionId));
  out.push(
    { key: `turn_start:${s.requestId}`, event_type: 'agent.turn_start', thread_id: s.conversationId, action_id: action, caused_by: action,
      metadata: { model: 'not-reported', mode: s.mode, job_id: s.jobId, runtime: 'github-actions', ...parent } },
    { key: `message:${s.requestId}`, event_type: 'conversation.message', thread_id: s.conversationId, message_id: s.requestId, action_id: action, caused_by: turn,
      metadata: { role: 'user', part: 0, part_kind: 'text', status: parent.parent_action_id ? 'submitted_while_busy' : 'complete', text: s.text, ...parent,
        ...(s.sourceRecordId ? { source_record_id: s.sourceRecordId } : {}),
        ...(s.modelAnchor ? { model_anchor: s.modelAnchor } : {}), ...(s.sourceSelection ? { source_selection: s.sourceSelection } : {}),
        ...(s.parent ? { parent: s.parent } : {}), ...(s.replyTo ? { reply_to: s.replyTo } : {}), ...(s.mergedFrom ? { merged_from: s.mergedFrom } : {}) } },
  );
  return out;
}

export interface DispatchInput {
  jobId: string; conversationId: string; actionId: string | null; causedBy: string | null; mode: string;
  /** Exactly what the runner receives (job request), not a summary. Signed URLs are never included. */
  input: unknown; retryOf?: string; state?: string;
  /** The enclosing operation (a retry inside the turn it restarts). */
  parentActionId?: string | null;
}
/** The web "tool call": dispatch of the study-building/discussion agent to GitHub Actions. */
export function dispatchEvents(ctx: ProducerContext, d: DispatchInput): ServerEventInput[] {
  return [{ key: d.retryOf ? `tool.start:${d.jobId}:retry:${d.retryOf}` : `tool.start:${d.jobId}`, event_type: 'tool.start', thread_id: d.conversationId,
    tool_call_id: d.jobId, target: PIPELINE_TOOL, action_id: d.actionId, caused_by: d.retryOf ? toolStartId(ctx.ownerId, d.jobId) : d.causedBy,
    metadata: { input: json(d.input), native_id_reported: true, state: d.state ?? 'queued', mode: d.mode, ...(d.retryOf ? { retry: true } : {}),
      ...(d.parentActionId && d.parentActionId !== d.actionId ? { parent_action_id: d.parentActionId } : {}) } }];
}

export interface FinishInput {
  jobId: string; conversationId: string; actionId: string | null;
  /** Distinguishes repeated terminal states of a retried job. */
  attempt: string;
  status: 'completed' | 'error' | 'interrupted';
  output?: unknown; startedAt?: string;
  /** Turn semantics (user-initiated agent turn); absent for package sync jobs. */
  turn?: { requestId: string; startedAt?: string };
  reply?: { messageId: string; text: string; status: 'complete' | 'partial'; proposal?: unknown; reason?: string };
  proposalId?: string;
  error?: string;
}
/** tool.end + received reply (complete or partial) + proposal request + error + turn end. */
export function finishEvents(ctx: ProducerContext, f: FinishInput): ServerEventInput[] {
  const toolEnd = `tool.end:${f.jobId}:${f.attempt}`, endId = serverEventId(ctx.ownerId, toolEnd);
  const out: ServerEventInput[] = [{ key: toolEnd, event_type: 'tool.end', thread_id: f.conversationId, tool_call_id: f.jobId, target: PIPELINE_TOOL,
    action_id: f.actionId, caused_by: toolStartId(ctx.ownerId, f.jobId), duration_ms: ms(f.startedAt),
    metadata: { status: f.status, ...(f.output === undefined ? { output_absent: true } : { output: json(f.output) }) } }];
  let last = endId;
  if (f.reply) {
    const key = `message:${f.reply.messageId}`;
    out.push({ key, event_type: 'conversation.message', thread_id: f.conversationId, message_id: f.reply.messageId, action_id: f.actionId, caused_by: endId,
      metadata: { role: 'assistant', part: 0, part_kind: 'text', status: f.reply.status, ...(f.reply.text ? { text: f.reply.text } : { text_absent: true }),
        ...(f.reply.reason ? { reason: f.reply.reason } : {}), ...(f.reply.proposal !== undefined ? { proposal: json(f.reply.proposal) } : {}),
        ...(f.turn ? { reply_to_message_id: f.turn.requestId } : {}) } });
    last = serverEventId(ctx.ownerId, key);
    if (f.proposalId) out.push({ key: `permission.request:${f.proposalId}`, event_type: 'permission.request', thread_id: f.conversationId, target: 'proposal.apply',
      message_id: f.reply.messageId, action_id: f.actionId, caused_by: last, metadata: { permission_id: f.proposalId, kind: 'model-proposal' } });
  }
  if (f.error) out.push({ key: `error:${f.jobId}:${f.attempt}`, event_type: 'conversation.error', thread_id: f.conversationId, action_id: f.actionId, caused_by: endId,
    metadata: { status: 'error', text: f.error } });
  if (f.turn) out.push({ key: `turn_end:${f.turn.requestId}:${f.attempt}`, event_type: 'agent.turn_end', thread_id: f.conversationId, action_id: f.actionId,
    caused_by: turnStartId(ctx.ownerId, f.turn.requestId), duration_ms: ms(f.turn.startedAt),
    metadata: { status: f.status === 'completed' ? 'complete' : f.status, job_id: f.jobId } });
  return out;
}

/** A turn that failed before any job was dispatched (dispatch error, configuration, storage). */
export function dispatchFailedEvents(ctx: ProducerContext, f: { jobId: string; conversationId: string; actionId: string | null; requestId?: string; startedAt?: string; error: string; input?: unknown }): ServerEventInput[] {
  return [
    ...dispatchEvents(ctx, { jobId: f.jobId, conversationId: f.conversationId, actionId: f.actionId, causedBy: f.requestId ? turnStartId(ctx.ownerId, f.requestId) : f.actionId, mode: 'dispatch', input: f.input ?? { job_id: f.jobId }, state: 'failed' }),
    ...finishEvents(ctx, { jobId: f.jobId, conversationId: f.conversationId, actionId: f.actionId, attempt: 'dispatch', status: 'error', output: { error: f.error }, error: f.error,
      ...(f.requestId ? { turn: { requestId: f.requestId, startedAt: f.startedAt } } : {}) }),
  ];
}

export interface DecisionInput { proposalId: string; decision: 'apply' | 'reject'; conversationId: string; messageId?: string; actionId?: string | null; automatic?: boolean; target?: string;
  /** The turn whose proposal this decides (T10 metadata.parent_action_id). */
  parentActionId?: string | null }
export function decisionEvents(ctx: ProducerContext, d: DecisionInput): ServerEventInput[] {
  const key = `permission.decision:${d.target ?? 'proposal.apply'}:${d.proposalId}`;
  return [{ key, event_type: 'permission.decision', thread_id: d.conversationId, target: d.target ?? 'proposal.apply', ...(d.messageId ? { message_id: d.messageId } : {}),
    // T10 (desktop research-agent.ts): a researcher's reply is caused by the answering operation;
    // an automatic decision by the request it resolves, when there is one.
    action_id: d.actionId ?? null, caused_by: !d.automatic && d.actionId ? d.actionId : d.target ? null : serverEventId(ctx.ownerId, `permission.request:${d.proposalId}`),
    metadata: { permission_id: d.proposalId, reply: d.decision, automatic: Boolean(d.automatic),
      ...(d.parentActionId && d.parentActionId !== d.actionId ? { parent_action_id: d.parentActionId } : {}) } }];
}
export const decisionId = (owner: string, proposalId: string, target = 'proposal.apply') => serverEventId(owner, `permission.decision:${target}:${proposalId}`);

type Artifact = { id: string; filename?: string; content?: string } & Record<string, unknown>;
type Doc = { model?: unknown; artifacts?: Artifact[]; annotations?: unknown[] };
export interface VersionInput { before: Doc | null; after: Doc; revision: number; by: 'human' | 'agent-proposal' | 'baseline'; actionId?: string | null; causedBy?: string | null; proposalId?: string; jobId?: string }
/**
 * T10 version labels (same meanings as desktop): human-save = a researcher's committed save, linked to
 * the save operation; baseline = state a project starts with; agent-proposal (web) = an agent
 * proposal the researcher applied, caused by that permission.decision; agent-tool = files the
 * runner wrote, caused by the tool.end that returned them. `external` (a change no operation of
 * this surface caused) cannot occur on web: every commit goes through a web request.
 */
const versionTrigger = (by: VersionInput['by']) => by === 'human' ? { trigger: 'human-save' } : by === 'baseline' ? { trigger: 'baseline' } : { trigger: 'agent-proposal', writer_link: 'permission-decision' };
/**
 * Effective, committed versions only: the Human Program, each changed generated artifact and the
 * annotation set. artifact_version is the workspace revision that committed it (the same number
 * studio_research_history uses), so the two records join exactly.
 */
export function versionEvents(ctx: ProducerContext, v: VersionInput): ServerEventInput[] {
  const out: ServerEventInput[] = [], link = { action_id: v.actionId ?? null, caused_by: v.causedBy ?? null };
  const extra = { ...versionTrigger(v.by), ...(v.proposalId ? { proposal_id: v.proposalId } : {}), ...(v.jobId ? { job_id: v.jobId } : {}) };
  const model = JSON.stringify(v.after.model ?? null);
  if (v.after.model !== undefined && (!v.before || JSON.stringify(v.before.model ?? null) !== model))
    out.push({ key: `program:${ctx.projectId}:${v.revision}`, event_type: 'program.version', artifact_id: 'program.json', artifact_version: v.revision, ...link,
      metadata: { by: v.by, committed_sha256: sha(model), program: model, ...extra } });
  const prior = new Map((v.before?.artifacts ?? []).map(a => [a.id, JSON.stringify(a)] as const));
  for (const artifact of v.after.artifacts ?? []) {
    const text = JSON.stringify(artifact);
    if (prior.get(artifact.id) === text) continue;
    const id = `artifacts/${artifact.filename || artifact.id}`.slice(0, 200);
    out.push({ key: `artifact:${ctx.projectId}:${artifact.id}:${v.revision}`, event_type: 'artifact.version', artifact_id: id, artifact_version: v.revision, ...link,
      metadata: { by: v.by, committed_sha256: sha(text), artifact_record_id: artifact.id, file: text, ...extra } });
  }
  const removed = [...prior.keys()].filter(id => !(v.after.artifacts ?? []).some(a => a.id === id));
  if (removed.length) out.push({ key: `artifact-removed:${ctx.projectId}:${v.revision}`, event_type: 'artifact.version', artifact_id: 'artifacts/index.json', artifact_version: v.revision, ...link,
    metadata: { by: v.by, op: 'remove', removed, file: JSON.stringify((v.after.artifacts ?? []).map(a => a.id)), ...extra } });
  const annotations = JSON.stringify(v.after.annotations ?? []);
  if (v.after.annotations !== undefined && (v.before ? JSON.stringify(v.before.annotations ?? []) !== annotations : (v.after.annotations ?? []).length > 0))
    out.push({ key: `annotations:${ctx.projectId}:${v.revision}`, event_type: 'artifact.version', artifact_id: 'annotations.json', artifact_version: v.revision, ...link,
      metadata: { by: v.by, committed_sha256: sha(annotations), file: annotations, ...extra } });
  return out;
}

/** Generated package files read from the runner's job branch when a build completes. */
export function packageFileEvents(ctx: ProducerContext, p: { jobId: string; revision: number; files: Array<{ path: string; content: Buffer | string }>; actionId: string | null; causedBy: string | null }): ServerEventInput[] {
  return p.files.map(file => {
    const text = typeof file.content === 'string' ? file.content : file.content.toString('utf8');
    return { key: `package:${p.jobId}:${file.path}`, event_type: 'artifact.version', artifact_id: `package/${file.path}`.slice(0, 200), artifact_version: p.revision,
      action_id: p.actionId, caused_by: p.causedBy, metadata: { by: 'agent', trigger: 'agent-tool', writer_link: 'tool-result', job_id: p.jobId, committed_sha256: sha(text), file: text } };
  });
}
