# Build Study workspace

`/build` is the site-styled introduction with account access and saved studies.
`/build/example` opens a full-window editor in the same workspace used by
`/build/[id]`. The example is stored locally with the agent offline; saved
studies use authenticated storage and the configured live agent. The old
`/build-preview` address redirects to `/build/example`. Studies / Account remains available in the workspace menu. Editor routes hide
the public navigation/footer, while `/build` retains the original site styling. Existing `/pipeline` jobs are unchanged.

## Configure a development service

1. Create or choose a Supabase project. Set `SUPABASE_URL` and
   `SUPABASE_PUBLISHABLE_KEY` in `.env.local`. The browser does not need a
   service-role key; all database and storage requests retain the signed-in
   user's token and RLS policies.
2. Apply `supabase/migrations/202610050001_studio.sql` once through your migration
   runner or Supabase SQL editor. It creates owner-scoped workspaces/events,
   the revision-check RPC, and the private `studio-sources` bucket. Apply
   `supabase/migrations/20261006062534_studio_resources.sql` to enable resource
   MIME types and extend the same owner/workspace storage policies. Apply
   `supabase/migrations/20261006065000_studio_layout_telemetry.sql` for semantic
   layout events and server-assigned event revision stamps.
3. Enable email/password authentication. Set the Auth Site URL to the deployment
   origin and configure confirmation email delivery. Confirmation returns to the
   site; the user signs in at `/build` after confirming. Configure SMTP and rate
   limits before opening registration to a cohort. Password reset and social
   sign-in are not implemented in this version.
4. Connect the original GitHub workflow: `GITHUB_TOKEN` needs Actions write on
   `HumanStudy-Hub/HumanStudy-Bench`; `GITHUB_JOBS_TOKEN` (or its fallback
   `GITHUB_TOKEN`) needs Contents read/write on `HumanStudy-Hub/humanstudy-hub-jobs`.
   Set `STUDIO_PIPELINE_REF=codex/build-study-platform` for this development branch.
   Publish the matching Bench branch first. The runner reuses its existing
   `OPENROUTER_API_KEY` and `HUMANSTUDY_PIPELINE_TOKEN` Actions secrets and model
   configuration. Studio no longer calls a separate web-hosted chat model.
5. Run `npm run dev -- --hostname 127.0.0.1 --port 3100` and open
   `http://127.0.0.1:3100/build`. Restart after changing environment variables.

Development project `humanstudy-hub-dev` (`zigbuogyerivbnxtnjjw`, us-west-1)
was created on 2026-10-05. The base, pipeline, resource and telemetry migrations have been applied. Local
`.env.local` contains its URL and modern publishable key, is ignored by Git,
and has file mode 0600. `/api/studio/auth` reports `configured: true`.
The private source bucket has a 25 MB per-object limit and a MIME allowlist;
PDFs may use that full limit, while individual resources are limited to 20 MB
by the application. No production website was deployed.

Hosted transaction tests passed for revision updates, stale-write rejection,
cross-owner workspace/event/file visibility and cross-owner event insertion
denial. Fixtures were rolled back. These tests exercise database roles and
policies, not the complete browser signup/upload journey.

Remaining configuration: Auth Site URL/redirects and cohort email delivery.
The connected MCP does not expose Auth configuration; the browser dashboard
is signed out and the CLI has no management access token. Existing default
email confirmation was preserved. The local development server now uses the
existing GitHub login token in ignored `.env.local`; do not copy that personal
credential to a shared deployment.

Vercel Preview configuration was completed on 2026-10-06 using `xuanl17` in
`xuanl17s-projects`, project `humanstudy-hub-web`. Preview variables scoped to
`codex/build-study-platform` are `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
`STUDIO_PIPELINE_REF=codex/build-study-platform`. The deployment inherits the
project's existing GitHub credentials; no local personal token was copied.
The [branch Preview](https://humanstudy-hub-web-git-codex-build-stu-0b1c60-xuanl17s-projects.vercel.app)
is Ready, and `/api/studio/auth` returns `configured: true`. Production was not
changed. This configuration check does not verify signup, email delivery or a
signed-in end-to-end agent run.

## Workflow and persisted data

A study begins with an empty model. Upload a primary PDF and optional additional
papers or research resources. Originals go to signed private storage URLs.
The resource selector switches between PDFs, raw text, images and ZIP directory
previews. DOCX/XLSX originals can be downloaded; they have no inline preview.
Resource previews do not execute uploaded scripts or interpret their contents.
Include in build is reversible: excluded files stay available for preview, download
and export but their original contents do not enter the next agent request.
Previously extracted model evidence and conversation references remain in context. Existing files default to included.

PDF.js renders original pages and extracts selectable text in the browser.
Zoom is relative to the available viewer width, from 75% to 300%. Select text
or drag a region, save a highlight without a comment, add a comment, or send
that reference to the agent. Highlights and comments survive a saved-study
reload. Scanned pages support region marks; text requires OCR. Select or circle
model objects to attach them to the left Agent composer. Need input discussions
use that same composer; there is no separate model-side prompt form. Panels can
be resized with the separators (keyboard arrows also work), independently
collapsed into rails, and reopened with the view buttons. At least one stays
open. Layout preferences are stored on the current device; narrow screens show
one active pane. PDF and study contents stay mounted while collapsed.

The editor auto-saves changes to the signed-in account after a 900 ms debounce;
Save or Cmd/Ctrl+S immediately flushes the same revision-checked save queue.
The example saves locally. The status bar distinguishes account/local saves and
reports conflicts or failures; saving does not run the agent. The interface uses
English with no language switch. Theme and account access are in the header menu.
Human Program and Resources switch artifact views, Compare opens both, and
Study agent toggles the conversation pane. Advanced focus/restore/layout commands
remain in the command palette rather than competing toolbar buttons.

History is a single searchable conversation list. Program version DAG and past
model preview have been removed; accepted proposals remain in their conversations.
Acceptance no longer creates program version metadata. Previously recorded metadata
remains compatible with storage and export so reverting the feature loses no data.

Human Program organizes background/hypotheses, study design, participant
procedure, data/variables, analysis and reported results. Background, hypothesis,
design and result entity kinds extend the original six kinds. The runner's optional
sidecar and the older-package adapter share this contract. Legacy findings with
hypotheses/planned tests remain distinct from observed results. Unreported results
are labeled as absent rather than invented or treated as required runtime data.
Quotes and provenance remain attached to detail cards, with original artifacts
available as the complete underlying output.

Chat history uses a simple indented branch list. Reply references an earlier
message; Side talk forks context at that message. Later parent messages and
sibling conversations stay out of a branch's agent context. Bring to main
copies the selected side-talk message into a main-line draft with an explicit
reference. Sending that draft asks the agent to reconcile it; applying a
proposal remains a separate action. Conversations share the current study model;
branches are discussion paths, not independent model versions.

Upload a PDF and select **Build study**, or send a request in the agent panel.
The API reserves the request with the workspace revision, signs the selected
private PDF for the runner, freezes all additional sources in a private resource
archive, and starts the original `run-humanstudy-pipeline.yml`
workflow. Each feedback request has its own private job branch; completed output
from the previous request is copied for refinement when the source is unchanged.
The existing Claude Code tools and package validator still run in Actions.

The runner receives bounded model, conversation, annotation and Need input context
in `studio_request.json`. An optional validated `studio-model.json` sidecar carries
the visualization schema. Older packages use a conservative adapter; unsupported
or missing facts remain available in materials or unresolved review fields.
The original eight-file package remains authoritative. The runner writes a
request-specific completion marker last, so a copied package cannot finish a
new refinement prematurely.

The UI polls actual job progress while allowing source inspection and drafting.
Completed output becomes an explicit proposal; it never replaces the current model
automatically. Apply/reject records review in the original pipeline. A subsequent
message sends selected source/model context and saved review answers back to that
same agent. Queued builds older than five minutes, failed builds, or running jobs
older than the workflow's 90-minute ceiling (with a ten-minute margin) can be
recovered with **Recover build**. Retry uses the same job/concurrency group.

Quotes must match the attached page text; model-provided rectangles are removed
and the viewer derives boxes from PDF text. Missing citations are not invented.
Artifacts displayed in the UI are bounded; export also includes the original
agent package under `build-package/` (up to 40 MB), with status/omissions recorded
in its manifest. A download does not imply that research decisions are approved.

Drafts, conversations, references, review decisions and annotations are saved
with a revision. The revision is a concurrency counter, not an immutable document history.
Resaving a review answer replaces that answer; conversation proposal snapshots
remain available. A stale save is rejected, and the UI offers a local JSON copy
before loading the current server version. Account separation is enforced by
RLS and verified server sessions, independent of the legacy promo-code gate.

Workspace telemetry captures clicks, normalized pointer positions (up to four
per second), scrolling, selection length, visibility duration and explicit
chat/review actions and explicit panel layout changes. Selection events record
source/page, selection mode, length and rectangle count, not selected text.
The server stamps events with the owned workspace revision at receipt; this
links events to saved state but is not an exact reconstruction of unsaved drafts. Events have stable IDs, bounded queues and bounded retries.
Listeners rebind after keyed workspace refreshes while retaining the session ID.
No password, keypress or DOM-wide text capture is performed. Conversations are
saved in the study document. Settings disclose recording. Events are in
`studio_events`; this version does not provide a researcher analytics dashboard.

Export produces a ZIP with the versioned document, study model, conversations,
annotations, review responses, source manifest, available original source files,
applied auxiliary files and `HANDOFF.md`. It lists unresolved choices and pending proposals. The handoff is
research design data and draft materials. Packaging and validation of a runnable
study, execution and result analysis remain work for the local agent or the
legacy pipeline.

Need input uses optional agent-produced `model.reviewIssues` with blocking,
researcher-decision and check priorities. Each issue can preserve the audit
reason, downstream impact, suggested next step and source pointer. If older
output only supplies unresolved fields, it stays a conservative check without
invented severity or impact. Saved answers remain pending application. Agent
output and audit files still require review; the UI does not independently
establish that every research decision has been found.

## Limits and verification

- PDFs: 25 MB each; first 40 pages rendered; 30,000 extracted characters per page
  and 990,000 per source. Scanned PDFs support region selection but need an OCR
  service for text extraction. No OCR service is configured in this version.
- Agent context: the runner reads the selected original PDF plus a bounded Studio
  context excerpt; the full context file remains available to the agent. A build
  still requires a primary PDF. Selecting a non-PDF resource retains the selected
  primary paper. All other included papers and resources enter a private archive, limited
  to 20 MB combined, passed through the original worker's `openMaterialsUrl`.
  Retry re-signs its private URL. Original resource types include TXT, MD, CSV,
  JSON, Python, R, PNG, JPEG, WebP, ZIP, DOCX and XLSX; downloadable inputs do not
  imply the agent successfully understood each format. Required Studio attachments
  fail the build visibly if unavailable or invalid. ZIP extraction allows the
  outer resource bundle and one uploaded ZIP level, with a shared 100 MiB
  expansion, 2,000-file and 4,000-entry limit; traversal, links and collisions
  are rejected.
- Materials: up to 30 applied files and 120 KB of combined UTF-8 content.
  Accepted formats are Markdown, CSV, JSON, text, Python and R.
- Saved document requests: 2 MB. Export includes up to 50 MB of original sources and
  records omissions in its manifest. Viewer truncation does not alter the stored
  original PDF.
- PDF text placement for unusual fonts or right-to-left text is approximate;
  the original raster page remains the visual reference.
- A reproduced `removeChild` stack points to Webpack's bundled
  `mini-css-extract-plugin/hmr/hotModuleReplacement.js`: its link load/error
  callback accesses a detached link's parent. Development now uses Turbopack
  to avoid that CSS HMR path; production still builds with Webpack. Native text
  ranges are also cleared before source/page changes and workspace translation
  is disabled. Other DOM errors must still be investigated from their own stack.

The production build uses Webpack because a prior local Turbopack production
build stalled. Turbopack development starts and serves the editor successfully.

Run `npm run test:studio`, `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
The tests mock service boundaries; they do not validate hosted RLS or email.
Before inviting users, verify two accounts cannot read each other's study/file,
then exercise signup → confirmation → study → PDF → selection/comment → chat →
proposal → apply/reject → reload → ZIP. Also use two tabs to verify revision
conflicts preserve local work, and inspect recorded events in the database.

## Live original-agent verification (2026-10-05)

The isolated development run [37383149808](https://github.com/HumanStudy-Hub/HumanStudy-Bench/actions/runs/37383149808)
completed successfully on the matching Bench branch using the existing Claude Code
workflow and its Actions secrets. It built the Asian disease framing experiment
from the benchmark paper into 11 files, including the optional model/reply sidecars.
The web adapter loaded and validated 9 model entities, 3 procedure steps and 2
variables from that actual result. A null categorical unit and list-valued variable
references observed in this run are normalized without discarding the model.
The test job remains in the private jobs repository and is not a user study.

This verifies real workflow dispatch, runner execution, package validation and
presentation mapping. It does not verify a full browser signup/upload session;
email delivery still needs configuration. The Vercel Preview environment was
configured and checked separately on 2026-10-06, as documented above.

## Discussion and package synchronization (2026-10-06)

`POST /api/studio/workspaces/[id]/chat` defaults to a discussion turn. `intent: "build"` starts the initial package build. Both dispatch the original Claude Code Action with `studio_request.json.mode`; no separate web-hosted model is introduced. Discussion writes a validated job-root `studio-turn.json` with reply and optional proposal, marks the job complete with `packageReady: false`, and never requires the eight-file package. It still waits for GitHub runner startup.

`document.discussion` and `document.pipeline` are independent durable lanes. `GET /pipeline` reports both; `POST /pipeline` imports results through CAS. Incoming proposals use the model fingerprint captured when their request started. Autosave preserves server-owned jobs, proposals and accepted package pointers. Discussion quotes are grounded against attached page text using the same evidence sanitizer as initial build results.

Accepting the initial build records its package without rebuilding it. Accepting a discussion proposal saves the model before queueing an accepted-model sync. Changes accepted during an existing sync are coalesced into a later sync. `POST /pipeline` supports `action: "retry"` with `lane`, `action: "sync-package"` with an applied `proposalId`, and `action: "reconcile-approval"` for remote approval after the durable save. Exports contain a package only when its accepted fingerprint matches the current model.

Current local checks: 88 web tests and 36 focused Bench tests, TypeScript, lint and production build. These modes still need a real Actions run and browser acceptance testing. Automatic approval review rejected reusing the existing benchmark PDF for a new external-processing test; no new job was dispatched.


## Workspace layout refinement (2026-10-06)

Artifact tabs switch between source/resources and the model beside the Agent.
Split view opens both artifacts and retains resize handles. Closing a panel
removes its reserved rail; tabs and the Agent toggle reopen it. Narrow screens
activate a view instead of toggling the selected view off.

Each panel supports temporary Focus. Restore or Escape returns to its previous
open panels and widths; focus does not overwrite the saved layout. Opening an
anchored source or sending a selection to the Agent exits focus so the target
is visible. Source and model contents remain mounted, preserving PDF page/zoom
and the inspection view. Need input remains above the conversation. Save and
package status share the bottom strip.

Commands opens a searchable keyboard palette (Cmd/Ctrl+Shift+P). It offers
layout presets, artifact navigation, conversation history, settings and export;
only executing a command changes a view. No command submits an Agent prompt or
accepts a proposal. This is a layout refinement; the existing real-agent protocol
and review flow remain unchanged.
