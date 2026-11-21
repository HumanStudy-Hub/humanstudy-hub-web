#!/usr/bin/env node
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import AdmZip from 'adm-zip';
import { verifyContent } from '../lib/research-data/verify-content.ts';
import { createSource, ExportError, SHA256, UUID } from './lib/research-export-source.mjs';

const USAGE = 'Usage: node scripts/export-research-timeline.mjs (--user-id UUID | --email EMAIL | --all) --from DATE --to DATE --out FILE.zip';
const EVENT_COLUMNS = `id owner_id visit_id surface install_id research_session_id client_seq
  occurred_at received_at event_type data_type project_id view target action_id caused_by thread_id message_id tool_call_id
  source_id artifact_id artifact_version duration_ms contract_version app_version collector_version consent_version
  platform metadata content_refs links simulation hosted_request_ids gap_flags content`.split(/\s+/);
const SESSION_COLUMNS = `owner_id visit_id surface install_id research_session_id gap_flags
  first_exported_at last_exported_at delivery`.split(/\s+/);
const USAGE_COLUMNS = `id account_id environment model_id created_at settled_at state reserved_microusd
  actual_microusd matched_by event_ids sessions`.split(/\s+/);
const CONTENT_COLUMNS = 'owner_id sha256 status path bytes mime'.split(' ');

function utcDate(input) {
  const date = /^\d{4}-\d\d-\d\d/.exec(input ?? '')?.[0];
  if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
      (input !== date && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input)) ||
      !Number.isFinite(Date.parse(input))) {
    throw new ExportError('Use a UTC date or an ISO timestamp with an explicit time zone for --from and --to.');
  }
  return new Date(input).toISOString();
}

export function parseOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      'user-id': { type: 'string' }, email: { type: 'string' }, all: { type: 'boolean' },
      from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
    } }));
  } catch {
    throw new ExportError(USAGE);
  }
  if (values.help) return { help: true };
  const { 'user-id': owner, email, all, out } = values;
  if ([owner, email, all].filter(Boolean).length !== 1 || (owner && !UUID.test(owner)) ||
      (email && !/^[^\s@]+@[^\s@]+$/.test(email)) || !out?.toLowerCase().endsWith('.zip')) {
    throw new ExportError(USAGE);
  }
  const from = utcDate(values.from), to = utcDate(values.to);
  if (from >= to) throw new ExportError('--to must be after --from.');
  return { owner: owner?.toLowerCase(), email, from, to, out };
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const scope = (...parts) => JSON.stringify(parts);
const sessionKey = (row) => scope(row.owner_id, row.surface, row.install_id, row.research_session_id);
const time = (row) => Date.parse(row.occurred_at);
const byTime = (a, b) => time(a) - time(b) || compare(a.id, b.id);
const sessionIdentity = ({ owner_id, visit_id, surface, install_id, research_session_id }) =>
  ({ owner_id, visit_id, surface, install_id, research_session_id });

function gapFlags(delivery) {
  if (!delivery) return ['delivery_row_missing'];
  const flags = [];
  if (!delivery.has_start) flags.push('session_start_missing');
  if (!delivery.has_end) flags.push('session_end_missing');
  if (Number(delivery.events_missing) > 0) flags.push('events_missing');
  if (Number(delivery.events_missing_content) > 0) flags.push('events_missing_content');
  if (Number(delivery.rejected_reports) > 0) flags.push('delivery_rejected');
  if (!delivery.complete) flags.push('delivery_incomplete');
  return flags;
}

function orderTimeline(events, deliveryRows) {
  const deliveryBySession = new Map(deliveryRows.map((row) => [sessionKey(row), row]));
  // Some collectors may put a visit identifier on only part of a session.
  const visitBySession = new Map();
  const visitOf = (row) => row.visit_id || row.metadata?.visit_id || null;
  for (const event of [...events].sort(byTime)) {
    if (visitOf(event) && !visitBySession.has(sessionKey(event))) {
      visitBySession.set(sessionKey(event), visitOf(event));
    }
  }

  const sessions = new Map(), visits = new Map();
  for (const event of events) {
    const visit_id = visitOf(event) || visitBySession.get(sessionKey(event)) || null;
    const visitKey = scope(event.owner_id, visit_id, visit_id ? null : sessionKey(event));
    const key = scope(visitKey, sessionKey(event));
    let session = sessions.get(key);
    if (!session) {
      const delivery = deliveryBySession.get(sessionKey(event)) ?? null;
      session = { ...sessionIdentity({ ...event, visit_id }), delivery, gap_flags: gapFlags(delivery), events: [] };
      sessions.set(key, session);
      if (!visits.has(visitKey)) visits.set(visitKey, []);
      visits.get(visitKey).push(session);
    }
    session.events.push({ ...event, visit_id });
  }

  for (const session of sessions.values()) {
    session.events.sort((a, b) => a.client_seq - b.client_seq || compare(a.id, b.id));
    const byCapture = [...session.events].sort(byTime);
    session.first_exported_at = byCapture[0].occurred_at;
    session.last_exported_at = byCapture.at(-1).occurred_at;
  }
  const start = (session) => Date.parse(session.delivery?.first_occurred_at ?? session.first_exported_at);
  const orderedVisits = [...visits.values()].map((visit) => visit.sort((a, b) =>
    start(a) - start(b) || compare(sessionKey(a), sessionKey(b))));
  orderedVisits.sort(([a], [b]) => compare(a.owner_id, b.owner_id) || start(a) - start(b) ||
    compare(a.visit_id ?? sessionKey(a), b.visit_id ?? sessionKey(b)));
  return orderedVisits.flat();
}

async function resolveLinks(events, source, owner) {
  const exported = new Map(events.map((event) => [event.id, event.owner_id]));
  const targetIds = events.flatMap((event) => [event.caused_by, event.action_id, event.metadata?.parent_action_id])
    .filter((id) => id && !exported.has(id));
  const external = new Map((await source.eventTargets(targetIds, owner)).map((event) => [event.id, event.owner_id]));
  const anchors = new Map();
  const ids = {
    thread: (event) => event.thread_id && scope(event.owner_id, 'thread', event.thread_id),
    message: (event) => event.message_id && scope(event.owner_id, 'message', event.thread_id, event.message_id),
    tool_call: (event) => event.tool_call_id && scope(event.owner_id, 'tool_call', event.thread_id, event.tool_call_id),
  };
  for (const event of [...events].sort(byTime)) {
    for (const [kind, keyOf] of Object.entries(ids)) {
      const key = keyOf(event);
      if (!key) continue;
      const preferred = kind === 'tool_call' ? event.event_type === 'tool.start' :
        kind === 'message' && event.event_type === 'conversation.message';
      if (!anchors.has(key) || (preferred && !anchors.get(key).preferred)) {
        anchors.set(key, { event_id: event.id, preferred });
      }
    }
  }
  for (const event of events) {
    function pointer(id) {
      if (!id) return null;
      const status = exported.get(id) === event.owner_id ? 'exported' :
        external.get(id) === event.owner_id ? 'outside_export' : 'missing';
      return { event_id: id, status };
    }
    event.links = {
      caused_by: pointer(event.caused_by),
      action: pointer(event.action_id),
      parent_action: pointer(event.metadata?.parent_action_id),
      ...Object.fromEntries(Object.entries(ids).map(([kind, keyOf]) =>
        [kind, anchors.get(keyOf(event))?.event_id ?? null])),
    };
  }
}

function requestIds(event) {
  const meta = event.metadata ?? {};
  const ids = [meta.request_id, meta.model_request_id, meta.hosted_request_id, event.message_id];
  for (const field of ['request_ids', 'model_request_ids', 'hosted_request_ids']) {
    if (Array.isArray(meta[field])) ids.push(...meta[field]);
  }
  return [...new Set(ids.filter((id) => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()))];
}

async function joinUsage(sessions, source, options) {
  const candidates = new Map(), sessionsByOwner = new Map();
  for (const session of sessions) {
    const identity = sessionIdentity(session);
    if (!sessionsByOwner.has(session.owner_id)) sessionsByOwner.set(session.owner_id, []);
    sessionsByOwner.get(session.owner_id).push(session);
    for (const event of session.events) {
      event.hosted_request_ids = [];
      for (const id of requestIds(event)) {
        const key = scope(event.owner_id, id);
        if (!candidates.has(key)) candidates.set(key, { id, matches: [] });
        candidates.get(key).matches.push({ event, identity });
      }
    }
  }

  const inRange = await source.reservations(options);
  const seen = new Set(inRange.map((row) => scope(row.account_id, row.id)));
  const exactOnly = await source.reservationsById([...candidates]
    .filter(([key]) => !seen.has(key)).map(([, { id }]) => id), options.owner);
  const reservations = new Map(inRange.map((row) => [row.id, row]));
  for (const row of exactOnly) {
    if (candidates.has(scope(row.account_id, row.id))) reservations.set(row.id, row);
  }

  return [...reservations.values()].sort((a, b) => compare(a.account_id, b.account_id) ||
      Date.parse(a.created_at) - Date.parse(b.created_at) || compare(a.id, b.id)).map((row) => {
    const exact = candidates.get(scope(row.account_id, row.id))?.matches ?? [];
    for (const { event } of exact) event.hosted_request_ids.push(row.id);

    const created = Date.parse(row.created_at);
    const windows = exact.length ? [] : (sessionsByOwner.get(row.account_id) ?? []).filter((session) =>
      Date.parse(session.delivery?.first_occurred_at ?? session.first_exported_at) <= created &&
      created <= Date.parse(session.delivery?.last_occurred_at ?? session.last_exported_at));
    const identities = exact.length ? exact.map(({ identity }) => identity) : windows.map(sessionIdentity);
    const unique = new Map(identities.map((identity) => [JSON.stringify(identity), identity]));
    return {
      ...row, matched_by: exact.length ? 'request_id' : windows.length ? 'account_time_window' : 'account_only',
      event_ids: exact.map(({ event }) => event.id), sessions: [...unique.values()],
    };
  });
}

async function exportContent(events, source, zip) {
  const contents = new Map();
  for (const event of events) {
    event.content = [];
    for (const ref of event.content_refs ?? []) {
      const { owner_id } = event;
      const { sha256 } = ref;
      if (!UUID.test(owner_id) || !SHA256.test(sha256)) {
        event.content.push({ role: ref.role, sha256, status: 'invalid_reference', path: null });
        continue;
      }
      const key = scope(owner_id, sha256);
      if (!contents.has(key)) {
        const item = { owner_id, sha256, status: 'index_missing', path: null, bytes: null, mime: null };
        const row = await source.row(owner_id, sha256);
        if (row) {
          const chunks = [];
          item.bytes = row.bytes;
          item.mime = row.mime;
          try {
            if (row.owner_id !== owner_id || row.sha256 !== sha256) throw new Error('invalid_content_row');
            await verifyContent(row, source, (bytes) => chunks.push(bytes));
          } catch (error) {
            if (error instanceof ExportError) throw error;
            item.status = ['object_missing', 'part_not_uploaded'].includes(error.message) ?
              error.message : 'integrity_check_failed';
          }
          if (item.status === 'index_missing') {
            item.status = 'included';
            item.path = 'content/' + owner_id + '/' + sha256;
            zip.addFile(item.path, Buffer.concat(chunks, Number(row.bytes)));
          }
        }
        contents.set(key, item);
      }
      const { status, path } = contents.get(key);
      event.content.push({ role: ref.role, sha256, status, path });
    }
  }
  return [...contents.values()];
}

function csvCell(value) {
  if (value == null) return '""';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Escape spreadsheet formulas in user-controlled scalar text. JSONL preserves exact values.
  if (typeof value === 'string' && /^(?:\s*[=+\-@]|[\t\r\n])/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function addTable(zip, name, columns, rows) {
  const jsonl = rows.map((row) => JSON.stringify(row) + '\n').join('');
  const fields = new Set(columns);
  for (const row of rows) for (const field of Object.keys(row)) fields.add(field);
  const headers = [...fields];
  const csv = [headers.map(csvCell).join(','), ...rows.map((row) =>
    headers.map((column) => csvCell(row[column])).join(','))].join('\r\n') + '\r\n';
  zip.addFile(name + '.jsonl', Buffer.from(jsonl));
  zip.addFile(name + '.csv', Buffer.from(csv));
}

export async function buildExport(source, options) {
  const rows = await source.events(options);
  const delivery = await source.delivery(rows.map((row) => row.research_session_id), options.owner);
  const sessions = orderTimeline(rows, delivery);
  const events = sessions.flatMap((session) => session.events.map((event) => {
    event.gap_flags = session.gap_flags;
    const stage = event.event_type.startsWith('simulation.') ? event.event_type.slice('simulation.'.length) : null;
    event.simulation = stage ? {
      stage, run_id: event.run_id ?? event.metadata?.run_id ?? event.metadata?.simulation_run_id ?? null,
      outcome: event.metadata?.outcome ?? event.metadata?.status ?? stage,
    } : null;
    return event;
  }));
  const zip = new AdmZip();
  await resolveLinks(events, source, options.owner);
  const usage = await joinUsage(sessions, source, options);
  const content = await exportContent(events, source, zip);
  addTable(zip, 'timeline', EVENT_COLUMNS, events);
  addTable(zip, 'sessions', SESSION_COLUMNS, sessions.map((session) => ({
    ...sessionIdentity(session), delivery: session.delivery, gap_flags: session.gap_flags,
    first_exported_at: session.first_exported_at, last_exported_at: session.last_exported_at,
  })));
  addTable(zip, 'hosted-model-usage', USAGE_COLUMNS, usage);
  addTable(zip, 'content-index', CONTENT_COLUMNS, content);
  zip.addFile('export.json', Buffer.from(JSON.stringify({
    version: 1, from: options.from, to: options.to, owner_id: options.owner ?? null,
    events: events.length, sessions: sessions.length, reservations: usage.length,
    content_included: content.filter((item) => item.status === 'included').length,
  }, null, 2) + '\n'));
  return { zip, count: events.length };
}

async function writeArchive(path, zip) {
  const scratch = await mkdtemp(join(dirname(path), '.research-export-'));
  try {
    const staged = join(scratch, 'export.zip');
    await writeFile(staged, zip.toBuffer(), { mode: 0o600, flag: 'wx' });
    await link(staged, path);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) return console.log(USAGE);
    const source = createSource({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    if (options.email) options.owner = await source.ownerByEmail(options.email);
    const { zip, count } = await buildExport(source, options);
    await writeArchive(options.out, zip);
    console.log('Exported ' + count + ' research events to ZIP.');
  } catch (error) {
    console.error(error instanceof ExportError ? error.message :
      error.code === 'EEXIST' ? 'The ZIP output already exists.' : 'Research export failed.');
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
