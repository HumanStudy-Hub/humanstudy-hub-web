# Research catalog integration

Coordinated review branch: `codex/community-research-index` in web, Bench and desktop.
The owner must approve before merging or applying the production migration.

## Read paths

- `GET /api/research/search?q=framing+effect&offset=0&limit=30`
- `GET /api/research/search?q=框架效应`
- `GET /api/research/search?concept=phenomenon:framing&capability=traceable`
- `GET /api/research/papers/<stable-paper-id>`

Responses include total, nextOffset, snapshot, taxonomyVersion, source (`database` or `snapshot`)
and scope (`indexed-corpus`). Empty later pages retain the corpus total. Search includes reviewed
concept aliases and untagged text matches; it does not claim all world literature is indexed.

Postgres uses GIN full-text/alias/concept indexes. Public reads are limited to the current index
snapshot by RLS. Only service-role publication can update it, using an expected snapshot and a
transaction/row lock. Historical accepted asset manifests are immutable; original estimates,
human reanalysis and AI simulation have separate result kinds and explicit sample/evidence fields.

When the database is not yet initialized or unavailable, a clearly labeled public snapshot is
used. `RESEARCH_INDEX_URL` can point at the Bench review branch in Preview; the default is main.
Public-source metadata does not imply complete material access or validated execution.

## Write paths

Community uploads use the existing verified Hub identity (desktop bearer or same-origin web
session). The server assigns a unique proposal ID and canonical paper metadata; it does not
publish competing visible versions. `paperId` and `baseRevision` are carried from the actual fork.
Research artifacts and cited resources are included by default; private state/chat paths are
rejected, not silently published. Original materials retain their own licenses.

The old `/api/contribute/*` paths alias the shared authenticated handlers. When
`COMMUNITY_CATALOG_ENABLED=true`, the old numbered-study pipeline publisher returns a migration
message instead of creating another entry. Enable this at the coordinated rollout, not before.

## Database validation and rollout

The migration is `supabase/migrations/20261021191855_research_catalog.sql`. It was created with
the Supabase CLI and tested with real embedded PostgreSQL, including anonymous/authenticated
permissions, GIN search, Chinese aliases, atomic rollback, stale writes and pagination.

```bash
npm ci
npm run test:studio
npx tsc --noEmit
npm run build
```

After approval, apply in Preview first. Sync from the reviewed catalog file:

```bash
node scripts/sync-research-index.mjs <research_index.json>
```

The command needs existing server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; it does
not load .env files or print credentials. Public clients never receive the service role.
Public search calls `search_research_catalog` with `SUPABASE_PUBLISHABLE_KEY` only, so RLS applies;
if that key, the migration or the first sync is missing, the Bench (or bundled) snapshot is served.
Subsequent Bench updates can call `POST /api/research/sync` with an exact `sourceCommit` and
the shared `RESEARCH_INDEX_SYNC_SECRET`. The source repository is fixed, and every publication
uses the current snapshot as its optimistic-lock baseline. A failed sync preserves the old data.

No production SQL was run to prepare this branch. The complete maintenance/rollout contract
is in the Bench PR's `docs/community-catalog.md`.
