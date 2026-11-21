import { readStoredObject } from '../../lib/research-data/verify-content.ts';

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/;
const PAGE_SIZE = 200;
const SESSION_ORDER = 'owner_id,surface,install_id,research_session_id';

export class ExportError extends Error {}

function serviceHeaders(key) {
  if (/^sb_secret_[\w-]+$/.test(key ?? '')) return { apikey: key };
  try {
    if (key.split('.').length === 3 &&
        JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'service_role') {
      return { apikey: key, Authorization: 'Bearer ' + key };
    }
  } catch {
    // Configuration errors must not expose the input.
  }
  throw new ExportError('Set SUPABASE_SERVICE_ROLE_KEY to a service role key.');
}

export function createSource({ url, key, fetcher = fetch }) {
  let origin;
  try { origin = new URL(url); } catch { /* handled below */ }
  if (!origin || origin.username || origin.password ||
      !(origin.protocol === 'https:' ||
        (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
    throw new ExportError('Set SUPABASE_URL to the HTTPS project URL.');
  }
  const headers = serviceHeaders(key);
  async function request(path, label) {
    try {
      return await fetcher(origin.origin + path, {
        method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ExportError('Could not reach Supabase for ' + label + '.');
    }
  }

  async function json(path, label) {
    const response = await request(path, label);
    if (!response.ok) throw new ExportError('Supabase ' + label + ' returned HTTP ' + response.status + '.');
    return response.json();
  }

  function rest(table, filters, select, order, offset = 0) {
    const query = new URLSearchParams([
      ['select', select], ['order', order], ['limit', PAGE_SIZE], ['offset', offset], ...filters,
    ]);
    return json('/rest/v1/' + table + '?' + query, table);
  }

  async function byIdPage(table, filters, select = '*') {
    const result = [];
    let after;
    for (;;) {
      const page = await rest(table, after ? [...filters, ['id', 'gt.' + after]] : filters, select, 'id');
      if (!page.length) return result;
      result.push(...page);
      after = page.at(-1).id;
    }
  }

  async function byIds(ids, callback) {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    const result = [];
    for (let i = 0; i < unique.length; i += 50) {
      result.push(...await callback('in.(' + unique.slice(i, i + 50).join(',') + ')'));
    }
    return result;
  }

  const account = (column, owner) => owner ? [[column, 'eq.' + owner]] : [];
  const range = (column, from, to) => [[column, 'gte.' + from], [column, 'lt.' + to]];
  return {
    async ownerByEmail(email) {
      for (let page = 1; ; page++) {
        const { users } = await json('/auth/v1/admin/users?page=' + page + '&per_page=' + PAGE_SIZE, 'Auth user lookup');
        const user = users.find((entry) => entry.email?.toLowerCase() === email.toLowerCase());
        if (user && UUID.test(user.id)) return user.id;
        if (!users.length) throw new ExportError('No account matches that email.');
      }
    },
    events: ({ owner, from, to }) => byIdPage('research_events', [...account('owner_id', owner), ...range('occurred_at', from, to)]),
    eventTargets: (ids, owner) => byIds(ids, (filter) => byIdPage('research_events',
      [...account('owner_id', owner), ['id', filter]], 'id,owner_id')),
    delivery: (ids, owner) => byIds(ids, async (filter) => {
      const filters = [...account('owner_id', owner), ['research_session_id', filter]];
      const rows = [];
      for (let offset = 0; ; ) {
        const page = await rest('research_session_delivery', filters, '*', SESSION_ORDER, offset);
        if (!page.length) return rows;
        rows.push(...page);
        offset += page.length;
      }
    }),
    // Hub visit records (online_workspace_visits) that overlap the range, and any referenced by events.
    visits: ({ owner, from, to }) => byIdPage('online_workspace_visits', [...account('owner_id', owner),
      ['started_at', 'lt.' + to], ['or', '(ended_at.is.null,ended_at.gte.' + from + ')']]),
    visitsById: (ids, owner) => byIds(ids, (filter) => byIdPage('online_workspace_visits',
      [...account('owner_id', owner), ['id', filter]])),
    reservations: ({ owner, from, to }) => byIdPage('online_model_reservations',
      [...account('account_id', owner), ...range('created_at', from, to)]),
    reservationsById: (ids, owner) => byIds(ids, (filter) => byIdPage('online_model_reservations',
      [...account('account_id', owner), ['id', filter]])),
    async row(owner, hash) {
      if (!UUID.test(owner) || !SHA256.test(hash)) throw new Error('invalid_content_path');
      const rows = await rest('research_content', [['owner_id', 'eq.' + owner], ['sha256', 'eq.' + hash]], '*', 'sha256');
      return rows[0] ?? null;
    },
    async object(owner, hash) {
      if (!UUID.test(owner) || !SHA256.test(hash)) throw new Error('invalid_content_path');
      const response = await request('/storage/v1/object/authenticated/research-content/' + owner + '/' + hash, 'research content');
      if (response.status === 404) throw new Error('object_missing');
      if (response.status === 400) {
        const problem = await response.json().catch(() => null);
        if (String(problem?.statusCode) === '404' || problem?.code === 'NoSuchKey') {
          throw new Error('object_missing');
        }
      }
      if (!response.ok) throw new ExportError('Supabase research content returned HTTP ' + response.status + '.');
      return readStoredObject(response);
    },
  };
}
