/**
 * Server capture glue: commit a workspace change together with its research batches.
 *
 * - Flag off (RESEARCH_COLLECTION_V1_ENABLED !== '1'): exactly the previous saveWorkspace call.
 * - Flag on: rpc studio_cas_workspace_research performs the same CAS and inserts the outbox rows
 *   in one transaction. The outbox insert runs in a sub-transaction, so a research problem can
 *   never fail or roll back the user's save; the RPC reports whether the rows were stored.
 * - Delivery runs after the response (next/server `after`), never inside the user's request.
 * - If the RPC is not deployed yet, the plain CAS runs and the outbox rows are inserted
 *   separately with retries; a failure is logged as a fixed code without content.
 */
import { after } from 'next/server';
import type { StudioContext } from '../studio/auth';
import type { StudioDocument, StudioWorkspace } from '../studio/types';
import { studioConfig, studioFetch, upstreamJson, StudioError } from '../studio/http';
import { assertDocument, getWorkspace, saveWorkspace } from '../studio/store';
import { buildServerBatch, type ProducerContext, type ServerBatch, type ServerEventInput } from './server-producer';
import { deliverAndRecord, deliverBatch, drainOwner, insertOutbox, outboxRow, type Transport } from './server-outbox';

export const researchCollectionEnabled = (): boolean => process.env.RESEARCH_COLLECTION_V1_ENABLED === '1';
export interface PlannedBatch { producer: string; key: string; events: ServerEventInput[] }
/** Builds the batches for a commit; `revision` is the revision the commit will create. */
export type ResearchPlan = (revision: number, producer: ProducerContext) => Array<PlannedBatch | null | undefined | false>;

type SaveResult = StudioWorkspace | { conflict: true; latest: StudioWorkspace | null };
let rpcMissing = false;

function report(code: string, detail: Record<string, unknown> = {}): void {
  // Observable in server logs; never content, ids of content or credentials.
  console.error(JSON.stringify({ research_capture: code, ...detail }));
}
export function userTransport(ctx: StudioContext): Transport {
  const { url, key } = studioConfig();
  return { url, apikey: key, bearer: ctx.accessToken, ownerId: ctx.user.id, mode: 'user' };
}
function schedule(task: () => Promise<unknown>): void {
  const run = () => task().catch(() => report('delivery_task_failed'));
  try { after(run); } catch { void run(); }
}

export function planBatches(ctx: StudioContext, workspaceId: string, revision: number, plan: ResearchPlan): ServerBatch[] {
  const producer: ProducerContext = { ownerId: ctx.user.id, email: ctx.user.email ?? null, projectId: workspaceId, at: new Date().toISOString() };
  const out: ServerBatch[] = [];
  for (const planned of plan(revision, producer)) {
    if (!planned) continue;
    try { const batch = buildServerBatch(producer, planned.producer, planned.key, planned.events); if (batch) out.push(batch); }
    catch { report('batch_invalid', { producer: planned.producer }); }
  }
  return out;
}

/**
 * Deliver freshly committed batches, then retry a few of this owner's older pending ones.
 * `insert`: the commit did not store the outbox rows (RPC not deployed); insert them first, after
 * the response, so the user's request never waits on research storage.
 */
export function deliverSoon(ctx: StudioContext, batches: ServerBatch[], state: 'stored' | 'insert'): void {
  let transport: Transport;
  try { transport = userTransport(ctx); } catch { return; }
  schedule(async () => {
    const rows = batches.map(batch => outboxRow(ctx.user.id, batch));
    let stored = state === 'stored';
    if (state === 'insert') {
      stored = await insertOutbox(transport, rows);
      if (!stored) report('outbox_insert_failed', { producers: batches.map(b => b.producer) });
    }
    for (const row of rows) {
      if (stored) await deliverAndRecord(transport, row);
      else await deliverBatch(transport, row.payload, row.id).catch(() => report('unstored_delivery_failed', { producer: row.producer }));
    }
    if (stored) await drainOwner(transport, 3);
  });
}

const lastDrain = new Map<string, number>();
/** Opportunistic retry of pending batches from frequent requests, at most once a minute per owner per instance. */
export function drainSoon(ctx: StudioContext): void {
  if (!researchCollectionEnabled()) return;
  const now = Date.now();
  if (now - (lastDrain.get(ctx.user.id) ?? 0) < 60_000) return;
  lastDrain.set(ctx.user.id, now);
  if (lastDrain.size > 5000) lastDrain.clear();
  let transport: Transport;
  try { transport = userTransport(ctx); } catch { return; }
  schedule(() => drainOwner(transport, 3));
}

/** saveWorkspace plus atomic research capture. Same return shape and conflict semantics. */
export async function saveWorkspaceResearch(ctx: StudioContext, id: string, document: StudioDocument, expectedRevision: number, plan?: ResearchPlan): Promise<SaveResult> {
  if (!plan || !researchCollectionEnabled()) return saveWorkspace(ctx, id, document, expectedRevision);
  let batches: ServerBatch[] = [];
  try { batches = planBatches(ctx, id, expectedRevision + 1, plan); } catch { report('plan_failed'); }
  if (!batches.length) return saveWorkspace(ctx, id, document, expectedRevision);
  if (!rpcMissing) {
    const rows = batches.map(batch => outboxRow(ctx.user.id, batch));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new StudioError(400, 'invalid_revision');
    assertDocument(ctx, id, document);
    const response = await studioFetch('/rest/v1/rpc/studio_cas_workspace_research', { method: 'POST', token: ctx.accessToken,
      body: { p_id: id, p_expected_revision: expectedRevision, p_document: document, p_outbox: rows } });
    if (response.status === 404) { rpcMissing = true; report('rpc_missing'); }
    else {
      const body = await upstreamJson<{ workspace: StudioWorkspace | null; outbox_stored: boolean }>(response);
      if (!body || typeof body !== 'object') throw new StudioError(502, 'invalid_service_response');
      if (!body.workspace) return { conflict: true, latest: await getWorkspace(ctx, id) };
      if (!body.outbox_stored) report('outbox_insert_failed', { producers: batches.map(b => b.producer) });
      deliverSoon(ctx, batches, body.outbox_stored ? 'stored' : 'insert');
      return body.workspace;
    }
  }
  const saved = await saveWorkspace(ctx, id, document, expectedRevision);
  if ('conflict' in saved) return saved;
  deliverSoon(ctx, batches, 'insert');
  return saved;
}
