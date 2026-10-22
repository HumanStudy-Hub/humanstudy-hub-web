# Research-data contract v1.0.0

One collection contract for HumanStudy Hub **desktop**, **web** and the **headless** OpenCode
worker (HumanStudy-Hub/humanstudy-desktop#27). This document is the normative text. The
machine-readable part is `lib/research-data/contract.ts`; desktop and headless copy that file
verbatim. The database half is `supabase/migrations/20261022120000_research_data_contract_v1.sql`.

Version rules: adding an event type, metadata key or optional column is a minor bump (1.1.0);
changing the meaning of an existing field or type is a major bump (2.0.0). Every row carries the
`contract_version` it was written under, so mixed versions are always identifiable.

## 1. The research session

A **research session** is the container for everything one surface instance captures in one run:
one desktop app launch, one web editor mount, or one headless worker run. It has a random UUID
(`research_session_id`) created when the run starts. Desktop reuses its existing per-run
`telemetry.sessionId`.

A session is defined by its events, not by a separate row. It opens with `session.start`, closes
with `session.end`, and every event in it carries a gap-free `client_seq` (1, 2, 3, ...). Because
events are delivered from offline queues in any order, there is no session table that events must
wait for.

If a run ends without `session.end` (crash, kill, power loss), the next run of the same install
emits `session.end` for the *previous* session id, with `metadata.reason = "recovered"` and the
last sequence number that session assigned. Collectors therefore persist each session's sequence
counter locally.

## 2. Identity and correlation fields

Every event row has these columns (`ResearchEvent` in `contract.ts`). Server-set fields are marked.

| Field | Meaning | Desktop | Web | Headless |
|---|---|---|---|---|
| `id` | Event UUID, assigned at capture and stored with the pending event. A retry sends the same id. | new | new | new |
| `owner_id` (server) | Signed-in account (`auth.uid()`); never sent by the client. | JWT | JWT | JWT of the account the run belongs to |
| `contract_version` | `1.0.0` | | | |
| `surface` | `desktop` \| `web` \| `headless` | | | |
| `install_id` | Random id of the installation/runner (8–80 `[A-Za-z0-9_-]`). Never hardware-derived. | existing `installId` | random id in `localStorage` (fallback: per tab) | runner id |
| `research_session_id` | Session UUID (§1) | existing `sessionId` | per editor mount | per run |
| `client_seq` | 1-based, gap-free per (surface, install, session) | | | |
| `occurred_at` | Client clock at capture | | | |
| `received_at` (server) | Server clock at insert. A client value is overwritten. | | | |
| `project_id` | Local project id (`.humanstudy/project.json`) or web workspace UUID | project id | workspace id | project id |
| `view` | Current view when the event happened (`program`, `source`, `artifacts/…`, `simulation`) | | | `headless` |
| `target` | Semantic name of what was acted on (action name, tool name, panel id) | | | |
| `action_id` | The **primary action** this event belongs to (§4). Equals `id` on the primary event. | | | |
| `caused_by` | The immediate parent event id | | | |
| `thread_id`, `message_id`, `tool_call_id` | Agent conversation identities. Reuse the agent runtime's ids (OpenCode `ses_…`, `msg_…`, `call_…`). | | | |
| `source_id` | sha256 (hex) of the original source file bytes. The same paper has the same id in every project and on every surface. | | | |
| `artifact_id` + `artifact_version` | `program` for the Human Program, otherwise the project-relative path. Version counts committed changes per project, from 1. | | | |
| `duration_ms` | Dwell or elapsed time, ≤ 24 h | | | |
| `metadata` | Event-specific object, ≤ 16 KiB serialized (§5) | | | |
| `content_refs` | References to stored content (§6) | | | |
| `app_version` | Product version | app version | web build id | worker version |
| `collector_version` | Version of the collector module, e.g. `desktop-collector/1.0.0` | | | |
| `consent_version` | Version of the research agreement the account accepted | `CONSENT_VERSION` | to be defined (§13) | inherits the account's |
| `platform` | `darwin` \| `win32` \| `linux` \| `browser` | | `browser` | OS |

## 3. Data types and event taxonomy

`data_type` is one of the seven agreed types, plus `session` for lifecycle and delivery records.
The full list of `event_type`s, with required columns and metadata, is `EVENTS` in `contract.ts`.

| data_type | event_type | Carries |
|---|---|---|
| `session` | `session.start` | `collection_mode`, previous session id if recovering |
| | `session.end` | `captured_through_seq`, `reason` (`quit` \| `recovered` \| `run_end`), `duration_ms` |
| | `delivery.checkpoint` | `captured_through_seq`, `pending_events`, `pending_content` (count and bytes), `oldest_pending_at` |
| | `delivery.rejected` | `rejected_event_id`, `rejected_seq`, HTTP `status`, server reason |
| | `consent.change` | `state` (`granted` \| `changed` \| `withdrawn`), `usage`, `content`, agreement version |
| `interaction` | `action.invoke` | **primary event**. `target` = action name from the product's action registry (`tab.open`, `artifact.open`, `program.ask`, `simulation.run`, …), `view`, `via` (`pointer` \| `keyboard` \| `shortcut` \| `menu` \| `touch` \| `system`), `shortcut` as a modifier combo (`Mod+K`) when relevant, and the ids of what was acted on (`source_id`, `artifact_id`+`artifact_version`, `thread_id`) |
| `navigation` | `view.dwell` | `target` = view/tab left, `duration_ms` foreground time in it |
| | `app.foreground` | foreground interval of the app/page, `duration_ms` |
| | `source.page_dwell` | `source_id`, `page`, `duration_ms` on that page |
| | `scroll.settle` | `view`, optional `source_id`/`page`, `position` (0–1), `direction`, `distance` (fraction travelled). Emitted when scrolling stops for ≥ 1 s or the view/page changes, never per frame |
| `selection_layout` | `selection.commit` | final selection when the gesture ends: `kind` (`source_text` \| `program_entity` \| `artifact_text`), `source_id`+`page`+`anchor` (quote, prefix, suffix, page-normalized rects) or entity ids; selected text inline or as a `text` ref |
| | `annotation.commit` | `annotation_id`, `op` (`create` \| `update` \| `delete`), `source_id`, `page`, `anchor`, note text |
| | `layout.commit` | `target` = panel, `state` (`open` \| `folded` \| `resized`), from/to size, `duration_ms` of the previous state |
| `conversation` | `conversation.message` | `thread_id`, `message_id`, `role`, `part`, `part_kind` (`text` \| `reasoning` \| `native`), `status` (`complete` \| `partial` \| `interrupted` \| `error`), `edit_of` / `retry_of` message ids, complete text (inline ≤ 8 KiB or `text` ref), the user turn's `workspace` context |
| | `conversation.question` | `question_id`, `status` (`pending` \| `answered` \| `dismissed`), complete `questions` with options, exact `answers` |
| | `conversation.error` | `status`, error text |
| `agent_execution` | `agent.runtime` | agent kernel `state` (`started` \| `error`), elapsed time |
| | `agent.recovery` | context recovered for a thread after restart, `reason` |
| | `agent.turn_start` / `agent.turn_end` | `model`, provider, `status` (`done` \| `error` \| `aborted`), `duration_ms` |
| | `agent.usage` | per message: `model`, tokens, cost as reported by the provider |
| | `tool.start` / `tool.end` | `tool_call_id`, `target` = tool, complete `input` and `output` (inline or refs), `status` (`completed` \| `error` \| `denied` \| `interrupted`), `duration_ms`, error |
| | `permission.request` / `permission.decision` | `permission_id`, `target` = permission type, patterns, `reply` (`once` \| `always` \| `reject`), `automatic` |
| `knowledge_artifact` | `program.version` | `artifact_id = "program"`, `artifact_version`, `by` (`human` \| `agent` \| `open`), `diff` summary (ids added/removed/changed per section, keys), complete program as a `program` ref |
| | `artifact.version` | project-relative `artifact_id`, `artifact_version`, `by`, `ext`, complete file as a `file` ref (binary files too) |
| `source_input` | `source.import` | `source_id` = sha256, `provenance` (`upload` \| `doi` \| `url` \| `community` \| `sample`), file basename, DOI/URL, `replaces_source_id` for a new version; the original bytes as a `source` ref |

Opening an artifact is `action.invoke` (`target = "artifact.open"`) carrying `artifact_id` and
`artifact_version`. Annotations are `selection_layout`, but `annotation.commit` carries the full
note, so it is research knowledge as well; it is not duplicated as an artifact version.

## 4. Actions and linking

One user operation produces **one** `action.invoke`. Its `action_id` is its own `id`. Everything the
operation causes (the user message it submits, the agent turn, tool calls, permission decisions,
program versions written by the agent, the artifact it opens) carries the same `action_id` and a
`caused_by` pointing to its parent.

- A submitted chat message that is not triggered by a button is itself primary
  (`conversation.message` with `role = "user"` and `action_id = id`).
- Mouse and keyboard routes to the same operation emit the same `target`; only `via` differs.
- A generic listener (web `click` on the editor root) must not emit an action when a semantic
  handler already did. Collectors deduplicate per user gesture: the semantic handler wins, and
  elements without a semantic action name produce no event at all.
- Events with no user cause (file watcher picks up an external edit, scheduled checkpoint) leave
  `action_id` null.

## 5. Metadata

Per-type keys are listed in `EVENTS`. Text up to 8 KiB (UTF-8) may sit inline; anything longer goes
to content (§6) with the complete value. A long value is **never** kept as a truncated prefix in
place of the full content. A tool that produced no output records `output_absent: true`.

## 6. Content

Large or binary content (long messages, tool inputs/outputs, program versions, written files,
imported sources) lives in Storage and is referenced from events:

```json
"content_refs": [{ "role": "program", "sha256": "<64 hex>", "bytes": 48213, "mime": "application/json" }]
```

- `sha256` is over the **original, uncompressed bytes after sanitization** (§8). For binary sources
  (PDF) nothing is rewritten, so the hash is the file's own hash and equals `source_id`.
- Object path: bucket `research-content`, name `<owner_id>/<sha256>`. One object per content per
  account, reused by every later event that references it. A source imported again, or opened in a
  second project, is not uploaded again.
- Objects are gzip-compressed (`encoding = "gzip"`) unless already compressed (`identity`, e.g.
  PDF/ZIP/PNG may use either).
- Content larger than 4 MiB is split into 4 MiB parts. Each part is its own object at
  `<owner_id>/<part sha256>` (row `kind = "part"`). The whole content's sha256 names a **manifest**
  object (row `kind = "manifest"`, `parts` = part hashes in order):
  `{ "format": "humanstudy-content-parts-v1", "encoding": "bytes" | "utf8", "bytes": N, "sha256": "…", "parts": [{ "sha256": "…", "bytes": n }] }`.
  Reassembly: decompress each part, concatenate in order, check the sha256. A Unicode character may
  span two parts; decode only after concatenation. Splitting never drops bytes.
- After the object upload succeeds, the collector inserts one `research_content` row
  (`sha256, kind, bytes, stored_bytes, mime, encoding, parts, surface`). The server only accepts the
  row when the object exists, so **a row means the object is stored**. The same content recorded
  twice is a no-op (`on_conflict=owner_id,sha256`, ignore duplicates).
- Storage has no update or delete policy for this bucket: an upload of an existing object fails as
  a duplicate, which the collector treats as "already stored" and then inserts the row.

### Delivery rule

> **An event is delivered when its row exists and every content it references is present**
> (a `research_content` row, and for a manifest all its parts).

Collectors keep a local state per event (`DeliveryState`): `captured` → `event_stored` →
`delivered`, or `rejected`. Upload success of one request is not delivery. Events and content may
upload in any order; the event is not complete until both have.

## 7. Prohibitions

Never collected, on any surface:

- continuous mouse/pointer movement or trajectories (including sampled pointer positions);
- individual keystrokes or draft text before it is submitted/saved (input text is captured on
  submission or save);
- continuous screen, DOM or video recording (rrweb, snapshots);
- activity in other applications, window titles of other apps, clipboard contents not pasted into
  the product;
- credentials, account tokens, API keys, cookies, email addresses, machine-specific absolute paths.

Annotation geometry and selection rects are allowed: they belong to a deliberate annotation or
selection, captured once when it completes. The database rejects event types that name a
prohibited stream (`PROHIBITED_EVENT_RE`, mirrored by a CHECK constraint).

## 8. Sanitization

Every string in `target`, `view`, `metadata` and every text content passes
`scrubResearchString`/`scrubResearchValue` before it is hashed, queued or uploaded. This is the
existing desktop sanitizer (`telemetry-core.ts` `scrubString`), now shared:

- the account email and any email address → `[email]`;
- key/token-shaped strings (`sk-…`, `hsk_…`, JWTs, GitHub/Slack tokens, long opaque tokens) →
  `[secret]`; a 64-hex sha256 is kept;
- paths inside the project → project-relative; any other absolute path → `[path]`;
- keys named like credentials (`password`, `token`, `api_key`, `authorization`, `cookie`, `email`,
  …) are dropped.

The database repeats the most important checks (tokens and home-directory paths in `target`, `view`
and `metadata`) and rejects the row. That is a client bug: the collector quarantines the event
locally and emits `delivery.rejected`, so the loss is visible. Original source files (PDFs) are
stored as imported and are not rewritten.

## 9. Delivery, offline use and completeness

- Pending events and content are persisted locally before any network call and survive restart.
  Nothing is pruned by age or count; disk usage above a threshold is reported, not trimmed.
- Retries reuse event ids (PK) and content hashes (PK), so a retry never creates a duplicate
  logical event. A *different* event with an existing `client_seq` is rejected (unique violation):
  that is a collector bug and is reported, not silently overwritten.
- Offline captures of any age are accepted. The server only rejects `occurred_at` more than
  10 minutes in the future and dates before 2026.
- On a 4xx other than 401/403, a collector bisects the batch, quarantines the offending events and
  emits `delivery.rejected` for each. 401/403/408/429/5xx are retried with backoff.
- Collectors emit `delivery.checkpoint` periodically and at `session.end`, declaring
  `captured_through_seq`. The server can then see what is missing, not just what arrived.

Two views (RLS applies; owners see their own sessions, the team uses the service role):

- `research_session_delivery`: per session, `events_received`, `expected_events`
  (max of received and declared sequence), `events_missing`, `events_missing_content`,
  `rejected_reports`, delivery lag, and `complete` (ended, gap-free, all content present).
- `research_missing_content`: each event and referenced sha256 that is not present
  (`object_missing` or `parts_missing`).

A small storage total is therefore never read as "everything was captured": a session is complete
only when the view says so.

## 10. Coverage map

Status: **now** = shipped in the current client; **v1** = to be implemented by the follow-up PR for
that surface. All v1 destinations are `research_events` (rows) and `research_content` + bucket
`research-content` (content).

| Data type | Desktop capture points | Web capture points | Headless capture points | Cloud destination |
|---|---|---|---|---|
| Clicks, shortcuts, controls | now: ~40 semantic `track()` calls (tab, artifact, program, simulation, settings, community, shortcut). v1: one `action.invoke` per operation with `via` | now: generic root `click` (tag names) + `chat`/`review` tracks. v1: `action.invoke` from semantic handlers only (`data-event`) | `action.invoke` with `via = system` for scripted steps (e.g. "build program") | now: `desktop_events`, `studio_events`. v1: `research_events` |
| Reading and navigation | now: `tab.switch` dwell, `source.page` dwell, `thread.switch`. v1: `view.dwell`, `source.page_dwell`, `app.foreground`, `scroll.settle` | now: `visibility` dwell, per-event `scroll`. v1: `view.dwell`, `source.page_dwell`, `app.foreground`, settled `scroll.settle` | n/a (no viewer) | as above |
| Selection, annotation, layout | now: `selection.change` (ids), `pane.fold`, `source.compare_resized`. v1: `selection.commit` with source anchor, `annotation.commit`, `layout.commit` | now: `selection`, `layout` (ids/counts). v1: same three events with anchors | n/a | as above |
| User–agent conversation | now: `conversation.user/assistant/reasoning/native/question/error` per final part + `_blob`. v1: `conversation.message` incl. `partial`/`interrupted` status, `edit_of`/`retry_of`; `conversation.question` | now: `chat` metadata event; text only in `studio_research_history` snapshots. v1: `conversation.message` per submitted/received message | v1: same events from the OpenCode event stream the worker already logs to `events.jsonl` | now: `desktop_events` + `desktop-replays/<uid>/<session>/blobs/<uuid>.gz`. v1: `research_events` + `research-content` |
| Agent execution | now: `agent.turn_*`, `conversation.tool` (final state), `conversation.permission`, `conversation.usage`, `kernel.*`. v1: `tool.start`/`tool.end` with complete input/output, `permission.request/decision`, `agent.usage`, `agent.runtime` | v1: turn and tool events from the server chat route's agent calls | v1: same as desktop | as above |
| Research knowledge and artifacts | now: `project.program_version` (+ full blob), `project.file_written` (text files only). v1: `program.version`, `artifact.version` (all files), content-addressed | now: `studio_research_history` trigger snapshots. v1: `program.version` per committed revision with a `program` ref, keeping the trigger | v1: `program.version` / `artifact.version` for every file the run commits | now: `desktop_events`+blobs, `studio_research_history`. v1: `research_events` + `research-content` |
| Original research inputs | now: **not collected** (`sources/`, `paper.pdf` excluded). v1: `source.import` + original bytes | now: PDF in `studio-sources/<uid>/<workspace>/<uuid>.pdf` (working copy). v1: `source.import` + content-addressed copy | v1: `source.import` for each input file | v1: `research-content/<uid>/<sha256>` |
| Delivery / completeness | now: local `pending` count, `replay.dropped`. v1: `delivery.checkpoint`, `delivery.rejected`, `session.end` with `captured_through_seq` | now: in-memory queue, dropped count shown. v1: persisted queue (IndexedDB) + checkpoints | v1: queue on disk, flush at run end, checkpoint | `research_session_delivery`, `research_missing_content` |

## 11. Legacy data

Legacy tables stay in place and writable for clients already shipped (desktop ≤ 0.6.6, current
web). They are labelled with `COMMENT ON TABLE` and are **never** merged with `research_events` or
reported as contract data. Analyses that use them say so and name the version.

| Legacy | Identified by | v1 counterpart | Not equivalent because |
|---|---|---|---|
| `desktop_events` (consent_version 1–2) | table, `app_version` | `research_events` (surface `desktop`) | no `client_seq` (gaps invisible), no action linking, content in random-named blobs, 30-day cutoff dropped offline events |
| `desktop-replays/<uid>/<session>/blobs/<uuid>.gz` | bucket, path | `research-content/<uid>/<sha256>` | not content-addressed: the same content may be stored many times and an event can reference a blob that never arrived without the server knowing |
| `desktop_replay_chunks` + `desktop-replays/<uid>/<session>/<seq>.json.gz` | table | none | rrweb DOM recording: **prohibited** in v1. Inserts already disabled (2026-10-15); retained for export only |
| `studio_events` | table | `research_events` (surface `web`) | `pointer` rows are sampled pointer movement (**prohibited**, not mapped); `click` rows are generic tag names, not semantic actions; `scroll` is per event, not settled; no content |
| `studio_research_history` | table | `program.version` events | snapshots are reliable committed knowledge and stay the web's source of truth; v1 adds events that link each revision to the action that produced it |

Legacy `desktop_events.event_type` → v1 (explains meaning only; legacy rows are not rewritten or copied into `research_events`):

- `app.session_start/end` → `session.start/end`
- `consent.*` → `consent.change`
- `tab.switch` (durationMs) → `view.dwell`
- `source.page` → `source.page_dwell`
- `selection.change` → `selection.commit`
- `pane.fold`, `source.compare_resized` → `layout.commit`
- `shortcut` → `action.invoke` (`via = shortcut`)
- other UI names (`tab.open`, `artifact.*`, `program.*`, `simulation.*`, `settings.*`, `study.*`, `community.*`, `citation.click`, `amber.jump`, `model.change`, `file.open`, …) → `action.invoke` with that name as `target`
- `composer.send` → `action.invoke` + `conversation.message`
- `composer.typing_start` → dropped (input episode marker)
- `question.reply/reject` → `conversation.question`
- `permission.reply` → `permission.decision`
- `conversation.user/assistant/reasoning/native` → `conversation.message`
- `conversation.tool` → `tool.end`
- `conversation.permission` → `permission.request/decision`
- `conversation.usage` → `agent.usage`
- `agent.turn_*` → `agent.turn_start/end`
- `kernel.session_*` → `agent.runtime`
- `agent.recovery` → `agent.recovery`
- `project.program_version` → `program.version`
- `project.file_written`, `artifact.created`, `export.created` → `artifact.version`
- `replay.dropped` → `delivery.checkpoint`

The separate migration `20261022120100_desktop_events_allow_offline_capture.sql` removes the
30-day lower bound on legacy `desktop_events` inserts, so events that desktop ≤ 0.6.6 kept in its
local queue while offline can still be delivered. It narrows nothing.

## 12. Storage and access rules (summary)

- `research_events`, `research_content`: owners insert and select their own rows. No update, no
  delete (beta policy 2026-10-13: deletion requests go to the team).
- Bucket `research-content`: private; insert and read only under `<own uid>/`, object name must be
  a sha256; no update, no delete.
- Content is deduplicated **per account**, not globally. A global store would let any account test
  whether another account had uploaded a given file and would mix ownership for deletion requests.
  Cross-account comparison of the same source joins on `source_id`/`sha256` with the service role.
- Direct PostgREST/Storage writes with the user's JWT; RLS is the enforcement point, as for
  `desktop_events` today. The web collector posts through its existing authenticated route, which
  validates with `validateResearchEvent` and forwards with the user's token.

## 13. Open questions (owner)

1. **Web consent.** The web editor collects `studio_events` without a research agreement in the
   UI. v1 requires `consent_version`; the web collector needs the same agreement as desktop
   (or a documented web agreement version) before it writes `research_events`.
2. **Original sources.** Desktop deliberately never uploads `sources/` or `paper.pdf` today.
   Collecting original inputs (agreed in #27) changes what the desktop agreement describes; decide
   whether that needs a new `CONSENT_VERSION`.
3. **Hash verification.** RLS cannot re-hash uploaded bytes, so a faulty client could store bytes
   under the wrong sha256 in its own prefix. A service-role verifier that sets
   `research_content.verified_at` is proposed as a follow-up.
4. **Retention of legacy blobs.** `desktop-replays/…/blobs` stays as is. Re-uploading them
   content-addressed is possible but not planned.
5. **Headless credentials.** The headless worker has no signed-in UI. Proposed: it writes the same
   contract events and content into a local queue directory and uploads with the account session
   the desktop app already holds (or a scoped token passed by the operator); runs without an account
   stay local and are reported as undelivered sessions.


## Owner decisions accepted — 2026-10-22

The owner approved all five collection decisions: mandatory first-use web agreement; renewed
desktop agreement before original sources upload; offline desktop events older than 30 days;
individual collaborator identities for headless (a separate service identity only for shared
batch workers); and server-side stored-byte verification. Agreement version 3 explicitly includes
original sources and is recorded per account and surface in `research_consents`. Version 2 is
not migrated automatically. The optional offline-policy migration is approved for inclusion in
the rollout, but has not been applied to the shared project.

### Implementation and rollout

- Web: the actual workspace stays unmounted until the agreement check passes. Study API routes
  enforce the same record. Login/password recovery and account data export remain accessible.
- Original web sources stay in operational private storage while a background task archives
  them into the per-owner hash-addressed research store. The original stored source is the
  durable retry input if a request or function stops. Research records use deterministic IDs.
  Operational source copies remain per project; deduplication here concerns the research archive.
- Desktop: agreement version 3 re-prompts existing users. Only papers/resources in explicitly
  opened projects are collected; no general disk scan. Original bytes are privately staged in
  4 MiB parts before upload. Pending content survives restart and has no age/count pruning.
  A new account cannot upload the previous account's queued files.
- Headless: use a personal private account profile, refresh and verify it against Supabase,
  and verify that any hosted model key belongs to that account. Source bytes use the same
  collector as desktop. See the desktop PR's `docs/headless-research.md`.
- Integrity: `/api/cron/research-integrity` requires `CRON_SECRET` and server-only
  `SUPABASE_SERVICE_ROLE_KEY`. A daily Vercel job checks a bounded batch, verifies decompressed
  bytes/ordered manifest parts and hashes, and updates only verification columns. Failed or
  incomplete objects rotate so they cannot starve new content. No file text is logged.
  Delivery completeness is still distinct from `verified_at`; do not label unchecked bytes
  as verified. Higher-volume verification can use the same function from a dedicated worker.

Apply migrations to a disposable database and verify real Storage/RLS behavior first. Reconcile
live migration history before applying to the shared project; obtain the owner's approval for
that application. Configure the cron secrets server-side and test one bounded batch after
application. Never ship a service-role key in a web, desktop or headless client.

This implements the five approved decisions, not the entirety of issue #27: the general web and
headless conversation/tool adapters, legacy web queue durability, and the full cross-surface
action/causality/completeness coverage are still separate follow-up work. No deployment, release
or shared database application is implied by these branches.

Deployment is staged behind server-only `RESEARCH_COLLECTION_V1_ENABLED=1` (off by default).
While off, existing workspace access continues, original-source archival is disabled, and the
new verifier returns disabled. Mouse-movement capture remains removed independently. Deploy
code, validate/apply the schema with owner approval, configure server-only cron credentials,
then explicitly enable collection. This prevents a code-first deployment from locking out
existing users when the new tables are not present yet.
