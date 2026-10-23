/**
 * Durable delivery for server-produced research batches (T08).
 *
 * A batch is first written to public.research_server_outbox in the SAME transaction as the
 * workspace commit that produced it (rpc studio_cas_workspace_research), so a committed change
 * can never exist without its research record. Delivery to research_content / Storage /
 * research_events happens afterwards, outside the user's request, and is idempotent:
 * content is addressed by sha256, events by stable id, and a batch is only marked delivered
 * after its rows are read back. Failed attempts stay pending with a short error code and are
 * retried with backoff by the owner's next request or by /api/cron/research-outbox.
 * The view research_server_outbox_delivery shows what is pending, failing or rejected.
 *
 * No content or credentials are logged; error codes are fixed strings.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CONTENT_BUCKET, LIMITS, MANIFEST_FORMAT, type ResearchContentRow, type ResearchEvent } from './contract';
import type { ServerBatch, ServerContent } from './server-producer';

export const OUTBOX_TABLE = 'research_server_outbox';
export interface Transport {
  url: string; apikey: string; bearer: string;
  /** Owner of the rows. With the service role this must be set explicitly on every row. */
  ownerId: string;
  mode: 'user' | 'service';
  fetch?: typeof fetch;
}
export interface OutboxPayload { events: ResearchEvent[]; content: ServerContent[] }
export interface OutboxRow { id: string; owner_id: string; producer: string; project_id: string | null; event_count: number; content_count: number; payload: OutboxPayload }
export interface OutboxState { id: string; owner_id?: string; attempts: number; last_attempt_at?: string | null; last_error?: string | null }
export class DeliveryError extends Error { constructor(public code: string, public rejected = false) { super(code); } }

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const SESSION_COLUMNS = ['id', 'contract_version', 'surface', 'install_id', 'research_session_id', 'client_seq', 'data_type', 'event_type', 'occurred_at',
  'project_id', 'view', 'target', 'action_id', 'caused_by', 'thread_id', 'message_id', 'tool_call_id', 'source_id', 'artifact_id', 'artifact_version',
  'duration_ms', 'metadata', 'content_refs', 'app_version', 'collector_version', 'consent_version', 'platform'] as const;

export function outboxRow(ownerId: string, batch: ServerBatch): OutboxRow {
  return { id: batch.id, owner_id: ownerId, producer: batch.producer, project_id: batch.project_id, event_count: batch.events.length,
    content_count: batch.content.length, payload: { events: batch.events, content: batch.content } };
}

async function call(t: Transport, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { apikey: t.apikey, Authorization: `Bearer ${t.bearer}`, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await (t.fetch ?? fetch)(t.url.replace(/\/$/, '') + path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  } catch { throw new DeliveryError('network'); }
}
const fail = (r: Response, what: string): never => {
  throw new DeliveryError(`${what}_${r.status}`, [400, 409, 413, 422].includes(r.status));
};

/** Content as stored objects: one gzip object, or gzip parts followed by an identity manifest. */
export function encodeContent(c: ServerContent): Array<{ sha256: string; data: Buffer; row: ResearchContentRow }> {
  const raw = Buffer.from(c.text, 'utf8');
  if (sha(raw) !== c.sha256 || raw.length !== c.bytes) throw new DeliveryError('content_hash_mismatch', true);
  if (raw.length <= LIMITS.partBytes) {
    const data = gzipSync(raw);
    return [{ sha256: c.sha256, data, row: { sha256: c.sha256, kind: 'whole', bytes: raw.length, stored_bytes: data.length, mime: c.mime, encoding: 'gzip', surface: 'web' } }];
  }
  const out: Array<{ sha256: string; data: Buffer; row: ResearchContentRow }> = [], parts: Array<{ sha256: string; bytes: number }> = [];
  for (let at = 0; at < raw.length; at += LIMITS.partBytes) {
    const part = raw.subarray(at, Math.min(raw.length, at + LIMITS.partBytes)), hash = sha(part), data = gzipSync(part);
    parts.push({ sha256: hash, bytes: part.length });
    out.push({ sha256: hash, data, row: { sha256: hash, kind: 'part', bytes: part.length, stored_bytes: data.length, mime: c.mime, encoding: 'gzip', surface: 'web' } });
  }
  const manifest = Buffer.from(JSON.stringify({ format: MANIFEST_FORMAT, encoding: 'utf8', bytes: raw.length, sha256: c.sha256, mime: c.mime, parts }));
  out.push({ sha256: c.sha256, data: manifest, row: { sha256: c.sha256, kind: 'manifest', bytes: raw.length, stored_bytes: manifest.length, mime: c.mime, encoding: 'identity', parts: parts.map(p => p.sha256), surface: 'web' } });
  return out;
}

async function storeObject(t: Transport, o: { sha256: string; data: Buffer; row: ResearchContentRow }): Promise<void> {
  const seen = await call(t, `/rest/v1/research_content?owner_id=eq.${t.ownerId}&sha256=eq.${o.sha256}&select=sha256&limit=1`);
  if (!seen.ok) fail(seen, 'content_check');
  if ((await seen.json() as unknown[]).length) return;
  const path = `${t.ownerId}/${o.sha256}`;
  const put = await call(t, `/storage/v1/object/${CONTENT_BUCKET}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: new Uint8Array(o.data) });
  if (!put.ok) {
    const error = await put.json().catch(() => ({})) as { statusCode?: string; error?: string };
    if (!(put.status === 409 || error.statusCode === '409' || error.error === 'Duplicate')) fail(put, 'content_upload');
    // An earlier attempt stored the object but not its row. Accept it only if it is this content.
    const old = await call(t, `/storage/v1/object/authenticated/${CONTENT_BUCKET}/${path}`);
    if (!old.ok) fail(old, 'content_duplicate');
    const bytes = Buffer.from(await old.arrayBuffer());
    const same = bytes.equals(o.data) || (o.row.kind !== 'manifest' && (() => {
      try { const raw = o.row.encoding === 'gzip' ? gunzipSync(bytes, { maxOutputLength: LIMITS.partBytes }) : bytes; return sha(raw) === o.sha256; } catch { return false; }
    })());
    if (!same) throw new DeliveryError('content_conflict', true);
  }
  const row = await call(t, '/rest/v1/research_content?on_conflict=owner_id,sha256', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, json: { ...o.row, owner_id: t.ownerId } });
  if (!row.ok) fail(row, 'content_row');
}

/** PostgREST bulk inserts need identical keys in every row, nullable ones included. */
const normalize = (e: ResearchEvent, owner: string) => {
  const out: Record<string, unknown> = { owner_id: owner };
  for (const k of SESSION_COLUMNS) out[k] = (e as unknown as Record<string, unknown>)[k] ?? (k === 'metadata' ? {} : k === 'content_refs' ? [] : null);
  return out;
};

/** Deliver one batch: content first (so no event references missing bytes), then events, then read back. */
export async function deliverBatch(t: Transport, payload: OutboxPayload, sessionId: string): Promise<void> {
  if (t.mode === 'service') {
    // The service role bypasses RLS, so the agreement check the policy performs is repeated here.
    const agreed = await call(t, `/rest/v1/research_consents?owner_id=eq.${t.ownerId}&surface=eq.web&version=eq.3&select=version&limit=1`);
    if (!agreed.ok) fail(agreed, 'consent_check');
    if (!(await agreed.json() as unknown[]).length) throw new DeliveryError('consent_missing');
  }
  for (const c of payload.content) for (const o of encodeContent(c)) await storeObject(t, o);
  const rows = payload.events.map(e => normalize(e, t.ownerId));
  for (let at = 0; at < rows.length; at += LIMITS.batchSize) {
    const slice = rows.slice(at, at + LIMITS.batchSize);
    const r = await call(t, '/rest/v1/research_events?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, json: slice });
    if (r.ok) continue;
    if (![400, 409, 413, 422].includes(r.status)) fail(r, 'events');
    // Isolate: deliver every valid row, keep the batch pending and flag it as rejected for review.
    let rejected = 0;
    for (const one of slice) {
      const single = await call(t, '/rest/v1/research_events?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, json: [one] });
      if (!single.ok) { if ([400, 409, 413, 422].includes(single.status)) rejected++; else fail(single, 'events'); }
    }
    if (rejected) throw new DeliveryError(`rejected_${r.status}`, true);
  }
  const ids = new Set(payload.events.map(e => e.id));
  const back = await call(t, `/rest/v1/research_events?owner_id=eq.${t.ownerId}&research_session_id=eq.${sessionId}&select=id&limit=${ids.size + 1}`);
  if (!back.ok) fail(back, 'confirm');
  const present = (await back.json() as Array<{ id: string }>).filter(r => ids.has(r.id)).length;
  if (present !== ids.size) throw new DeliveryError('events_unconfirmed');
}

async function mark(t: Transport, id: string, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await call(t, `/rest/v1/${OUTBOX_TABLE}?id=eq.${id}&owner_id=eq.${t.ownerId}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, json: patch });
    return r.ok;
  } catch { return false; }
}

/** Deliver a stored outbox row and record the outcome on it. Never throws. */
export async function deliverAndRecord(t: Transport, row: Pick<OutboxRow, 'id' | 'payload'> & Partial<OutboxState>): Promise<'delivered' | 'pending' | 'rejected'> {
  const attempts = (row.attempts ?? 0) + 1, now = new Date().toISOString();
  try {
    await deliverBatch(t, row.payload, row.id);
    // Payload is released only after the rows were read back from research_events.
    await mark(t, row.id, { delivered_at: now, payload: null, attempts, last_attempt_at: now, last_error: null });
    return 'delivered';
  } catch (error) {
    const e = error instanceof DeliveryError ? error : new DeliveryError('internal');
    await mark(t, row.id, { attempts, last_attempt_at: now, last_error: (e.rejected ? 'rejected:' : '') + e.code.slice(0, 120) });
    return e.rejected ? 'rejected' : 'pending';
  }
}

/** Insert rows without a workspace commit (fallback while the RPC is not deployed). */
export async function insertOutbox(t: Transport, rows: OutboxRow[], retries = 2): Promise<boolean> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await call(t, `/rest/v1/${OUTBOX_TABLE}?on_conflict=id`, { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, json: rows });
      if (r.ok) return true;
      if (r.status === 404 || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) return false;
    } catch { /* transient */ }
    if (i < retries) await new Promise(resolve => setTimeout(resolve, 250 * 4 ** i));
  }
  return false;
}

/** Rows due for another attempt: not delivered, not rejected, past their backoff. */
export function due(rows: OutboxState[], now = Date.now()): OutboxState[] {
  return rows.filter(r => !String(r.last_error ?? '').startsWith('rejected:') &&
    (!r.last_attempt_at || now - Date.parse(r.last_attempt_at) >= Math.min(3_600_000, 30_000 * 2 ** Math.min(10, r.attempts))));
}

async function pendingRows(t: Transport, filter: string, limit: number): Promise<OutboxState[]> {
  const r = await call(t, `/rest/v1/${OUTBOX_TABLE}?delivered_at=is.null${filter}&select=id,owner_id,attempts,last_attempt_at,last_error&order=created_at.asc&limit=${limit}`);
  if (!r.ok) fail(r, 'outbox_list');
  return await r.json() as OutboxState[];
}
async function payloadOf(t: Transport, id: string): Promise<OutboxPayload | null> {
  const r = await call(t, `/rest/v1/${OUTBOX_TABLE}?id=eq.${id}&owner_id=eq.${t.ownerId}&select=payload&limit=1`);
  if (!r.ok) fail(r, 'outbox_read');
  return (await r.json() as Array<{ payload: OutboxPayload | null }>)[0]?.payload ?? null;
}

/** Retry this owner's pending batches (user token). */
export async function drainOwner(t: Transport, limit = 3): Promise<{ delivered: number; pending: number; rejected: number }> {
  const result = { delivered: 0, pending: 0, rejected: 0 };
  let rows: OutboxState[];
  try { rows = due(await pendingRows(t, `&owner_id=eq.${t.ownerId}`, 25)).slice(0, limit); } catch { return result; }
  for (const row of rows) {
    let payload: OutboxPayload | null;
    try { payload = await payloadOf(t, row.id); } catch { result.pending++; continue; }
    if (!payload) continue;
    result[await deliverAndRecord(t, { ...row, payload })]++;
  }
  return result;
}

/** Scheduled drain across owners with the service role (owners who never return). */
export async function drainAll(base: Omit<Transport, 'ownerId' | 'mode'>, limit = 25): Promise<{ checked: number; delivered: number; pending: number; rejected: number }> {
  const out = { checked: 0, delivered: 0, pending: 0, rejected: 0 };
  const service: Transport = { ...base, ownerId: '', mode: 'service' };
  for (const row of due(await pendingRows(service, '', 200)).slice(0, limit)) {
    if (!row.owner_id) continue;
    const t: Transport = { ...base, ownerId: row.owner_id, mode: 'service' };
    out.checked++;
    let payload: OutboxPayload | null;
    try { payload = await payloadOf(t, row.id); } catch { out.pending++; continue; }
    if (!payload) continue;
    out[await deliverAndRecord(t, { ...row, payload })]++;
  }
  return out;
}
