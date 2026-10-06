# Build Study platform implementation

Build the reviewed three-pane interface into an authenticated, source-grounded research workspace. Preserve the existing website and legacy pipeline. Work on `codex/build-study-platform`; do not deploy or migrate a hosted database until its configuration is supplied.

## Delivery sequence

1. Fix the reported `removeChild` crash. Check React-owned DOM, source selection, dialogs and translations; avoid patching native DOM methods. Keep recovery paths for persisted work.
2. Add `/build` for account access and a project list, and `/build/[id]` for the workspace. Email accounts use Supabase Auth. Workspace documents and revisions use Postgres with owner-only RLS; source PDFs use a private storage bucket. Missing configuration must produce an explicit setup state, never a fake authenticated session.
3. Replace isolated local state with saved workspace documents, resumable conversations and source/model selection references. Keep `/build-preview` as the visual sandbox. Save through revision checks to avoid overwriting work from another tab.
4. Add PDF intake and original-page viewing, selectable text and region annotations. Source anchors include document identity, page, rectangles and quoted text. Preserve original instruments; label absent information rather than fabricate it.
5. Connect contextual requests to the existing Claude Code GitHub Actions workflow, reusing its package contract, tools and secrets. Do not substitute a separate chat model. The assistant proposes a validated study model; the researcher reviews and applies changes explicitly. Keep inputs, actors, procedure, records, statistical variables and analyses distinct. Need input remains tied to objects and source evidence.
6. Record website clicks, timing, scrolling, selection and sampled pointer locations, plus conversations. Use authenticated, bounded batches and idempotent event IDs; do not record password fields or keystrokes. Raw research content belongs in workspace records rather than DOM-wide text capture.
7. Export a versioned ZIP containing the model, original-source references, source files when available, annotations, conversations, review decisions, auxiliary material manifest and a local-agent handoff. Do not describe unresolved drafts as executable studies.

## Implementation contracts

`lib/studio/types.ts` is the shared wire format. `StudioDocument` stores the study and durable interaction state. A workspace has a monotonic revision. Mutation requests carry their expected revision; stale writes return 409 and the latest workspace. Project and object identifiers are generated on the server or as UUIDs, never derived from filenames. No endpoint may accept an unverified owner identifier from the browser.

New endpoints live under `/api/studio` and verify an account independently of the old promotional access gate. Auth routes use secure session cookies and same-origin mutation checks. Database access uses the user's verified token, retaining RLS. Supabase service-role credentials are not needed in the browser.

The web app stores conversational co-design, anchors and bounded file metadata. The original Claude Code Action has two execution modes: discussion produces a reply and optional model proposal without generating the eight-file package; build produces the original complete package and mandatory Studio sidecars. Both use the configured Actions model and tools. Actions startup latency remains; this is not a persistent or streaming session. Discussion and package synchronization have independent durable job lanes.

## Verification and deployment gates

Run lint and type checks, schema and revision tests, malformed-provider response tests, authorization/ownership checks, bounded telemetry tests, and an end-to-end account → workspace → source → selection → chat → apply → export exercise when service credentials are available. Distinguish local contract tests from a live service test.

Production requires a Supabase project URL and publishable key, applied SQL migrations, a private source bucket, configured email confirmation/redirects and GitHub workflow/job access with the selected backend branch. Model credentials stay in Actions. No such credentials are present in the checked-out web repository. Email confirmation and multi-user RLS need live verification before external users are invited.

## Current task ownership

GPT-6 Sol handles targeted runtime repair and independent backend modules. The coordinating agent owns shared contracts, frontend integration, source handling, code review and acceptance checks. The current visual design is retained; branding can be revisited after the end-to-end workflow works.


## Implementation checkpoint

Implemented in this branch: verified account endpoints; private PDFs; saved,
revisioned studies; shared source/model context; conversation history; explicit
model and material proposals; Need input responses; bounded interaction events;
and ZIP handoff. The existing interface is the basis of the live workspace.

The reported DOM crash remains unconfirmed: native selection cleanup,
translation isolation and reload recovery are in place, but a triggering action
and stack trace are still needed. Automated checks cover service contracts with
mocks. Browser tool access to the loopback preview was denied by the tool's URL
policy, so no browser-driven interaction pass is claimed. Hosted authentication,
RLS, storage and AI require configuration and a real two-account acceptance pass.

The next gate is to configure the development Supabase project and model key,
apply the migration, and run the account-to-export flow. Scanned-source OCR,
password recovery and cohort analytics are follow-up work; generated study
execution is intentionally outside this Build Study workspace.

## Accepted interaction refinement (2026-10-06)

Default layout shows Agent and the study overview. Source/resources opens on demand; all panes remain resizable and independently collapsible. The overview leads to selected-node details. Source navigation follows citations without changing the primary build paper. UI updates keep the workspace mounted, preserving PDF position/zoom and layout.

The left conversation owns all prompts and one prioritized Need input item. Additional questions and side-talk actions use progressive disclosure. A saved answer remains pending application. Proposals preview only semantic differences and affected nodes; accepting a proposal establishes the authoritative model before package work starts. Old proposals carry their original model fingerprint and cannot overwrite a changed model, while rejection remains available.

Initial package acceptance reuses that result. Accepting a discussion proposal synchronizes the package in the background; subsequent accepted changes coalesce into a new sync when the previous result arrives. Worker output must preserve the accepted model exactly. Remote approval can reconcile after a successful workspace save. Export includes original program bytes only when their accepted model fingerprint matches the current model; a draft manifest identifies absent/stale program packages.

Local verification: 88 web tests, TypeScript, lint and production build; 36 focused Bench tests. The new discussion/build modes have not yet received a live Actions acceptance run or browser interaction pass. An attempted isolated live test was rejected by automatic approval review because resending its existing benchmark PDF to Claude/OpenRouter lacked explicit document-specific authorization. No test job was dispatched. The original isolated successful run predates these changes.
