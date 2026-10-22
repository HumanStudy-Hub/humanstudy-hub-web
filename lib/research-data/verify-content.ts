// Server-only byte verification. No model calls; bounded decompression and no content logging.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { ResearchContentRow, ContentManifest } from './contract';

const PART = 4 * 1024 * 1024, OBJECT = 8 * 1024 * 1024;
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export type StoredContent = ResearchContentRow & { owner_id: string };
interface Reader {
  row(owner: string, hash: string): Promise<StoredContent | null>;
  object(owner: string, hash: string): Promise<Uint8Array>;
}
function decode(row: StoredContent, stored: Uint8Array): Buffer {
  if (stored.length !== row.stored_bytes || stored.length > OBJECT) throw new Error('stored_size_mismatch');
  const bytes = row.encoding === 'gzip' ? gunzipSync(stored, { maxOutputLength: PART }) : Buffer.from(stored);
  if (bytes.length > PART) throw new Error('content_part_too_large');
  return bytes;
}
export async function verifyContent(row: StoredContent, read: Reader): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('invalid_hash');
  const bytes = decode(row, await read.object(row.owner_id, row.sha256));
  if (row.kind !== 'manifest') {
    if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) throw new Error('content_hash_mismatch');
    return;
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as ContentManifest;
  if (manifest.format !== 'humanstudy-content-parts-v1' || manifest.sha256 !== row.sha256 || manifest.bytes !== row.bytes ||
      !Array.isArray(manifest.parts) || manifest.parts.length < 2 || manifest.parts.length > 10000 ||
      !Array.isArray(row.parts) || row.parts.length !== manifest.parts.length) throw new Error('invalid_manifest');
  const hash = createHash('sha256'); let count = 0;
  for (const [i, part] of manifest.parts.entries()) {
    if (!/^[a-f0-9]{64}$/.test(part.sha256) || row.parts[i] !== part.sha256 || !Number.isSafeInteger(part.bytes) || part.bytes < 0 || part.bytes > PART) throw new Error('invalid_manifest_part');
    const child = await read.row(row.owner_id, part.sha256);
    if (!child) throw new Error('part_not_uploaded');
    if (child.owner_id !== row.owner_id || child.sha256 !== part.sha256 || child.kind === 'manifest' || child.bytes !== part.bytes) throw new Error('invalid_part_row');
    const data = decode(child, await read.object(row.owner_id, part.sha256));
    if (data.length !== part.bytes || sha(data) !== part.sha256) throw new Error('part_hash_mismatch');
    hash.update(data); count += data.length;
  }
  if (count !== row.bytes || hash.digest('hex') !== row.sha256) throw new Error('manifest_hash_mismatch');
}

export async function verifyPendingContent(config: { url: string; key: string; fetch?: typeof fetch; limit?: number }) {
  const fetcher = config.fetch ?? fetch, origin = new URL(config.url);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('invalid_service_origin');
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetcher(origin.origin + path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, ...init.headers } });
    if (!response.ok) throw new Error(`service_${response.status}`);
    return response;
  };
  // Failed/missing objects rotate behind never-attempted ones rather than starving the queue.
  const list = await request(`/rest/v1/research_content?verified_at=is.null&select=*&order=verification_attempted_at.asc.nullsfirst,created_at.asc&limit=${Math.max(1, Math.min(20, config.limit ?? 5))}`);
  const rows = await list.json() as StoredContent[], outcome = { checked: 0, verified: 0, pending: 0, failed: 0 };
  const read: Reader = {
    row: async (owner, hash) => (await (await request(`/rest/v1/research_content?owner_id=eq.${owner}&sha256=eq.${hash}&select=*&limit=1`)).json())[0] ?? null,
    object: async (owner, hash) => {
      const r = await request(`/storage/v1/object/authenticated/research-content/${owner}/${hash}`);
      if (Number(r.headers.get('content-length')) > OBJECT) { await r.body?.cancel(); throw new Error('stored_object_too_large'); }
      const reader = r.body?.getReader(); if (!reader) throw new Error('object_missing');
      const chunks: Uint8Array[] = []; let total = 0;
      for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > OBJECT) { await reader.cancel(); throw new Error('stored_object_too_large'); } chunks.push(value); }
      return Buffer.concat(chunks);
    },
  };
  for (const row of rows) {
    outcome.checked++;
    try {
      await verifyContent(row, read);
      await request(`/rest/v1/research_content?owner_id=eq.${row.owner_id}&sha256=eq.${row.sha256}&verified_at=is.null`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verified_at: new Date().toISOString(), verification_attempted_at: new Date().toISOString(), verification_error: null }) });
      outcome.verified++;
    } catch (e) {
      const pending = e instanceof Error && e.message === 'part_not_uploaded';
      if (pending) outcome.pending++; else outcome.failed++;
      await request(`/rest/v1/research_content?owner_id=eq.${row.owner_id}&sha256=eq.${row.sha256}&verified_at=is.null`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verification_attempted_at: new Date().toISOString(), verification_error: pending ? 'parts_pending' : 'integrity_check_failed' }) });
    }
  }
  return outcome;
}
