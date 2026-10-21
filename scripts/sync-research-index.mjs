// Explicit operator/CI sync. Requires a reviewed catalog file and server-side environment.
// Never reads local .env files or prints credentials. Production execution is a separate rollout step.
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/sync-research-index.mjs <research_index.json>');
const catalog = JSON.parse(await readFile(file, 'utf8'));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.papers)) throw new Error('Invalid research index');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the server environment');
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const state = await fetch(`${url}/rest/v1/research_catalog_state?select=snapshot&id=eq.true`, { headers });
if (!state.ok) throw new Error(`Cannot read catalog state (${state.status}); apply the reviewed migration first`);
const previous = (await state.json())[0]?.snapshot ?? null;
const response = await fetch(`${url}/rest/v1/rpc/publish_research_catalog`, {
  method: 'POST', headers, body: JSON.stringify({ payload: catalog, expected_snapshot: previous }),
});
if (!response.ok) throw new Error(`Catalog publication failed (${response.status}); inspect the database logs and retry from current state`);
console.log(JSON.stringify({ snapshot: await response.json(), papers: catalog.papers.length }));
