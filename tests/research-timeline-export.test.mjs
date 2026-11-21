import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { buildExport, parseOptions } from '../scripts/export-research-timeline.mjs';
import { createSource } from '../scripts/lib/research-export-source.mjs';
import {
  absent, content, corrupt, delivery, event, events, from, id, missing, old, other, owner,
  ref, reservations, stamp, stored, to, visits, whole,
} from './fixtures/research-timeline.mjs';

const key = 'sb_secret_fixture';
const project = 'https://research.example.test';
const options = { from, to };
const dateAndFile = ['--from', '2026-11-20', '--to', '2026-11-21', '--out', 'timeline.zip'];

function fixtureSource() {
  const requests = [];
  const tables = {
    research_events: [...events,
      event(999, 1, 'session.start', { occurred_at: stamp(9), id: old }),
      event(10, 9, 'session.end', { occurred_at: to }),
    ],
    research_session_delivery: delivery,
    online_model_reservations: reservations,
    online_workspace_visits: visits,
    research_content: [...stored.map(({ row }) => row), absent.row],
  };
  const source = createSource({ url: project, key, fetcher: async (url, init) => {
    const { pathname, searchParams, origin } = new URL(url);
    assert.equal(origin, project);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.apikey, key);
    assert.equal(init.headers.Authorization, undefined);
    requests.push({ pathname, searchParams });
    if (pathname === '/auth/v1/admin/users') {
      return Response.json({ users: searchParams.get('page') === '1'
        ? [{ id: other, email: 'other@example.test' }]
        : [{ id: owner, email: 'tester@example.test' }] });
    }
    if (pathname.startsWith('/storage/v1/object/authenticated/research-content/')) {
      const [account, sha] = pathname.split('/').slice(-2);
      const object = stored.find(({ row }) => row.owner_id === account && row.sha256 === sha);
      return object ? new Response(object.stored) : Response.json({ statusCode: '404' }, { status: 400 });
    }

    const table = pathname.split('/').at(-1);
    assert.ok(table in tables);
    let rows = [...tables[table]];
    for (const [key, value] of searchParams) {
      const [operator, ...operandParts] = value.split('.');
      const operand = operandParts.join('.');
      if (operator === 'eq') rows = rows.filter((row) => row[key] === operand);
      if (operator === 'in') rows = rows.filter((row) => operand.slice(1, -1).split(',').includes(row[key]));
      if (operator === 'gt') rows = rows.filter((row) => row[key] > operand);
      if (operator === 'gte') rows = rows.filter((row) => Date.parse(row[key]) >= Date.parse(operand));
      if (operator === 'lt') rows = rows.filter((row) => Date.parse(row[key]) < Date.parse(operand));
    }
    const order = searchParams.get('order')?.split(',') ?? [];
    rows.sort((a, b) => order.map((field) => String(a[field]).localeCompare(String(b[field]))).find(Boolean) ?? 0);
    const offset = Number(searchParams.get('offset'));
    rows = rows.slice(offset, offset + 2); // Exercise a server cap below the requested limit.
    const select = searchParams.get('select');
    if (select !== '*') rows = rows.map((row) => Object.fromEntries(select.split(',').map((field) => [field, row[field]])));
    return Response.json(rows);
  } });
  return { source, requests };
}

const jsonl = (zip, name) => zip.readAsText(name + '.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse);

test('timeline ZIP orders visits and sequence and resolves links without crossing accounts', async () => {
  const { source } = fixtureSource();
  const { zip } = await buildExport(source, options);
  const reopened = new AdmZip(zip.toBuffer());
  const timeline = jsonl(reopened, 'timeline');
  assert.deepEqual(timeline.map((row) => row.id), [1, 2, 3, 4, 5, 6, 8, 7].map(id));
  assert.ok(timeline.slice(0, 6).every((row) => row.visit_id === id(300)));
  assert.equal(timeline[6].visit_id, null);
  assert.equal(timeline[1].metadata.text, 'message');
  assert.deepEqual(timeline[1].links.caused_by, { event_id: old, status: 'outside_export' });
  assert.deepEqual(timeline[5].links.caused_by, { event_id: id(4), status: 'exported' });
  assert.deepEqual(timeline[5].links.action, { event_id: id(1), status: 'exported' });
  assert.equal(timeline[4].links.message, id(2));
  assert.equal(timeline[4].links.tool_call, id(3));
  assert.equal(timeline[4].links.thread, id(2));
  assert.equal(timeline[7].links.caused_by.status, 'missing');
  assert.equal(timeline[7].links.action.status, 'missing');
  assert.equal(timeline[7].links.thread, id(7));
  assert.deepEqual(timeline[5].simulation, { stage: 'completed', run_id: 'run-1', outcome: 'done' });
  assert.equal(timeline[7].simulation.stage, 'future_stage');
  assert.deepEqual(timeline[6].gap_flags, ['delivery_row_missing']);
  assert.deepEqual(timeline[0].gap_flags, [
    'session_end_missing', 'events_missing', 'events_missing_content', 'delivery_rejected', 'delivery_incomplete',
  ]);
  assert.deepEqual(timeline[5].gap_flags, ['session_start_missing']);
  assert.equal(jsonl(reopened, 'sessions')[0].delivery.events_missing, 3);

  const visitRows = jsonl(reopened, 'visits');
  assert.deepEqual(visitRows.map((row) => [row.visit_id, row.hub_record, row.end_reason, row.events_exported]), [
    [id(300), true, 'timeout', 6], [id(301), true, null, 0],
  ], 'Hub visits join runtime sessions; a cohort export omits accounts without exported events');
  assert.deepEqual(visitRows[0].research_session_ids.sort(), [id(101), id(102)].sort());
  assert.equal(visitRows[0].started_at, stamp(10));
  assert.equal(JSON.parse(reopened.readAsText('export.json')).visits, 2);

  const csv = reopened.readAsText('timeline.csv');
  assert.ok(csv.startsWith('"id","owner_id","visit_id"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""potential formula"")"`));
  assert.match(csv, /\r\n$/);
});

test('reservations prefer tenant-scoped exact matches, preserve ambiguous windows and exclude accounts without exported sessions', async () => {
  const { source } = fixtureSource();
  const { zip } = await buildExport(source, options);
  const usage = jsonl(zip, 'hosted-model-usage');
  assert.ok(usage.every((row) => row.matched_by !== 'account_only' || row.account_id === owner));
  assert.deepEqual(usage.map((row) => row.id).slice(0, 2), [501, 502].map(id));
  assert.equal(usage[0].matched_by, 'request_id');
  assert.equal(usage[0].created_at, stamp(4));
  assert.deepEqual(usage[0].event_ids, [2, 3, 4, 5].map(id));
  assert.equal(usage[0].actual_microusd, 65);
  assert.equal(usage[1].matched_by, 'account_time_window');
  assert.equal(usage[1].actual_microusd, null);
  assert.deepEqual(usage[1].sessions.map((row) => row.research_session_id), [101, 102].map(id));
  assert.deepEqual(jsonl(zip, 'timeline').at(-1).hosted_request_ids, []);
});

test('content is verified, deduplicated per account, and reconstructed from private objects', async () => {
  const { source, requests } = fixtureSource();
  const { zip } = await buildExport(source, options);
  assert.deepEqual(zip.readFile('content/' + owner + '/' + ref.sha256), content);
  assert.deepEqual(zip.readFile('content/' + owner + '/' + whole.row.sha256), Buffer.from('an intact whole object'));
  assert.equal(zip.readFile('content/' + other + '/' + ref.sha256), null);
  const index = jsonl(zip, 'content-index');
  assert.deepEqual(index.map((row) => [row.owner_id, row.sha256, row.status]), [
    [owner, ref.sha256, 'included'], [owner, missing, 'index_missing'],
    [owner, corrupt.row.sha256, 'integrity_check_failed'], [owner, absent.row.sha256, 'object_missing'],
    [owner, whole.row.sha256, 'included'], [other, ref.sha256, 'index_missing'],
  ]);
  assert.equal(requests.filter(({ pathname }) => pathname.endsWith('/' + ref.sha256)).length, 1);
  assert.ok(zip.getEntry('content-index.csv'));
});

test('email lookup paginates, single-owner exports filter every table, and empty exports have headers', async () => {
  const { source, requests } = fixtureSource();
  assert.equal(await source.ownerByEmail('TESTER@example.test'), owner);
  assert.equal(requests.filter(({ pathname }) => pathname.startsWith('/auth/')).length, 2);
  const { zip } = await buildExport(source, { ...options, owner });
  assert.equal(jsonl(zip, 'timeline').length, 7);
  assert.ok(jsonl(zip, 'hosted-model-usage').every((row) => row.account_id === owner));
  assert.ok(requests.filter(({ pathname }) => pathname.startsWith('/rest/'))
    .every(({ searchParams }) => ['owner_id', 'account_id'].some((key) => searchParams.get(key) === 'eq.' + owner)));
  assert.doesNotMatch(zip.readAsText('export.json'), /@|fixture/);
  assert.deepEqual(jsonl(zip, 'visits').map((row) => row.visit_id), [id(300), id(301)]);
  const { zip: onlyHub } = await buildExport(source, { ...options, owner: id(400) });
  assert.deepEqual(jsonl(onlyHub, 'visits').map((row) => [row.visit_id, row.end_reason, row.events_exported]),
    [[id(302), 'crash', 0]], 'a single-account export keeps Hub visits the runtime never reached');
  const { zip: emptyZip } = await buildExport(source, { ...options, owner: id(800) });
  assert.equal(emptyZip.readAsText('timeline.jsonl'), '');
  assert.match(emptyZip.readAsText('timeline.csv'), /^"id","owner_id"/);
});

test('CLI validates scope and bounds and never prints invalid credentials', () => {
  assert.deepEqual(parseOptions(['--all', ...dateAndFile]), {
    owner: undefined, email: undefined, from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z',
    out: 'timeline.zip',
  });
  assert.throws(() => parseOptions(['--all', '--user-id', owner, ...dateAndFile]), /Usage/);
  assert.throws(() => parseOptions(['--all', ...dateAndFile, '--to', '2026-02-31']), /UTC date/);
  assert.throws(() => parseOptions(['--all', ...dateAndFile, '--to', '2026-11-20']), /after/);
  const token = 'sb_publishable_fixture';
  const result = spawnSync(process.execPath, ['scripts/export-research-timeline.mjs', '--all', ...dateAndFile], {
    env: { ...process.env, SUPABASE_URL: project, SUPABASE_SERVICE_ROLE_KEY: token }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set SUPABASE_SERVICE_ROLE_KEY/);
  assert.ok(!result.stderr.includes(token));
});
