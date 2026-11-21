import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export const owner = id(100);
export const other = id(200);
export const stamp = (minute) => '2026-11-20T17:' + String(minute).padStart(2, '0') + ':00Z';
export const from = stamp(10);
export const to = stamp(30);
export const old = id(999);
export const event = (n, sequence, type, extra = {}) => ({
  owner_id: owner, surface: 'desktop', install_id: 'fixture-install', research_session_id: id(101),
  id: id(n), client_seq: sequence, event_type: type, occurred_at: stamp(10 + sequence),
  metadata: {}, content_refs: [], ...extra,
});

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const content = Buffer.from('Hello, planet 🌍!');
const contentSha = hash(content);
const part1 = content.subarray(0, 16);
const part2 = content.subarray(16);
const manifest = Buffer.from(JSON.stringify({
  format: 'humanstudy-content-parts-v1', encoding: 'utf8', sha256: contentSha, bytes: content.length,
  parts: [part1, part2].map((bytes) => ({ sha256: hash(bytes), bytes: bytes.length })),
}));
const object = (kind, data, encoding, extra = {}) => {
  const stored = encoding === 'gzip' ? gzipSync(data) : data;
  return { stored, row: {
    owner_id: owner, kind, encoding, mime: null, sha256: hash(data), bytes: data.length,
    stored_bytes: stored.length, ...extra,
  } };
};
export const missing = hash('missing');
export const absent = object('whole', Buffer.from('absent'), 'identity');
export const corrupt = object('whole', Buffer.from('correct'), 'identity');
export const whole = object('whole', Buffer.from('an intact whole object'), 'gzip');
export const stored = [
  object('manifest', manifest, 'gzip', {
    sha256: contentSha, bytes: content.length, parts: [hash(part1), hash(part2)], mime: 'text/plain',
  }),
  object('part', part1, 'gzip'), object('part', part2, 'identity'),
  { row: corrupt.row, stored: Buffer.from('damaged') }, whole,
];
export const ref = { sha256: contentSha, role: 'text', bytes: content.length, mime: 'text/plain' };

export const events = [
  event(6, 1, 'simulation.completed', { research_session_id: id(102), occurred_at: stamp(23),
    visit_id: id(300), caused_by: id(4), action_id: id(1), metadata: { run_id: 'run-1', status: 'done' } }),
  event(5, 8, 'tool.end', { thread_id: 'ses_thread', message_id: id(501), tool_call_id: 'call_tool',
    occurred_at: stamp(19), content_refs: [ref, { sha256: missing, role: 'source' },
      { sha256: corrupt.row.sha256, role: 'file' }, { sha256: absent.row.sha256, role: 'file' }, { sha256: whole.row.sha256, role: 'file' }] }),
  event(1, 2, 'action.invoke', { action_id: id(1), occurred_at: stamp(12),
    metadata: { visit_id: id(300) }, target: '=HYPERLINK("potential formula")' }),
  event(4, 7, 'simulation.started', { action_id: id(1), caused_by: id(3),
    metadata: { run_id: 'run-1', model_request_ids: [id(501), id(504)] }, content_refs: [ref] }),
  event(3, 5, 'tool.start', { thread_id: 'ses_thread', message_id: id(501), tool_call_id: 'call_tool',
    action_id: id(1), caused_by: id(2) }),
  event(2, 3, 'conversation.message', { thread_id: 'ses_thread', message_id: id(501),
    caused_by: old, action_id: id(1), occurred_at: stamp(11), metadata: { text: 'message' } }),
  event(7, 1, 'simulation.future_stage', { owner_id: other, occurred_at: stamp(14),
    caused_by: id(1), action_id: id(123), thread_id: 'ses_thread', message_id: id(501),
    tool_call_id: 'call_tool', content_refs: [ref] }),
  event(8, 1, 'session.start', { research_session_id: id(103), occurred_at: stamp(14) }),
];
export const delivery = [
  { ...events[2], has_start: true, has_end: false, complete: false, events_missing: 3,
    events_missing_content: 1, rejected_reports: 1, first_occurred_at: stamp(1), last_occurred_at: stamp(26) },
  { ...events[0], has_start: false, has_end: true, complete: true, events_missing: 0,
    events_missing_content: 0, rejected_reports: 0, first_occurred_at: stamp(16), last_occurred_at: stamp(25) },
];
export const reservations = [
  { id: id(501), account_id: owner, created_at: stamp(4), actual_microusd: 65, state: 'settled' },
  { id: id(502), account_id: owner, created_at: stamp(17), actual_microusd: null, state: 'pending' },
  { id: id(503), account_id: owner, created_at: stamp(29), actual_microusd: 42, state: 'overrun' },
  { id: id(504), account_id: other, created_at: stamp(3), actual_microusd: 100, state: 'settled' },
  { id: id(505), account_id: id(400), created_at: stamp(18), actual_microusd: 7, state: 'settled' },
];
// Hub visit records: one with runtime events, one the runtime never reached, one for an account
// without exported research events.
export const visits = [
  { id: id(300), owner_id: owner, workspace: 'try-' + owner, started_at: stamp(10), ended_at: stamp(27),
    end_reason: 'timeout', provider_expires_at: stamp(27) },
  { id: id(301), owner_id: owner, workspace: 'try-' + owner, started_at: stamp(28), ended_at: null,
    end_reason: null, provider_expires_at: stamp(59) },
  { id: id(302), owner_id: id(400), workspace: 'try-' + id(400), started_at: stamp(15), ended_at: stamp(16),
    end_reason: 'crash', provider_expires_at: null },
];
