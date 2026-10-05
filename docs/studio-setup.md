# Build Study workspace

`/build` is the site-styled introduction with account access and saved studies.
`/build/example` opens the example in the same three-pane workspace used by
`/build/[id]`. The example is stored locally and uses the demo agent; saved
studies use authenticated storage and the configured live agent. The old
`/build-preview` address redirects to `/build/example`. Studies / Account also
remains available inside the workspace. Existing `/pipeline` jobs are unchanged.

## Configure a development service

1. Create or choose a Supabase project. Set `SUPABASE_URL` and
   `SUPABASE_PUBLISHABLE_KEY` in `.env.local`. The browser does not need a
   service-role key; all database and storage requests retain the signed-in
   user's token and RLS policies.
2. Apply `supabase/migrations/202610050001_studio.sql` once through your migration
   runner or Supabase SQL editor. It creates owner-scoped workspaces/events,
   the revision-check RPC, and the private `studio-sources` PDF bucket.
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
was created on 2026-10-05. Both studio migrations have been applied. Local
`.env.local` contains its URL and modern publishable key, is ignored by Git,
and has file mode 0600. `/api/studio/auth` reports `configured: true`.
The private PDF bucket has a 25 MB limit. No production website was deployed.

Hosted transaction tests passed for revision updates, stale-write rejection,
cross-owner workspace/event/file visibility and cross-owner event insertion
denial. Fixtures were rolled back. These tests exercise database roles and
policies, not the complete browser signup/upload journey.

Remaining configuration: Auth Site URL/redirects and cohort email delivery.
The connected MCP does not expose Auth configuration; the browser dashboard
is signed out and the CLI has no management access token. Existing default
email confirmation was preserved. The local development server now uses the
existing GitHub login token in ignored `.env.local`; do not copy that personal
credential to a shared deployment. Vercel needs team-managed GitHub credentials,
Supabase variables and `STUDIO_PIPELINE_REF` in its Preview environment.

## Workflow and persisted data

A study begins with an empty model. Upload one or more PDFs; original PDFs go
directly to signed private storage URLs. PDF.js renders the original pages and
extracts selectable text in the browser. Select text or a region, add a comment,
or send that source reference to the agent. Select or circle model objects to
ask contextual questions through the same conversation.

Upload a PDF and select **Build study**, or send a request in the agent panel.
The API reserves the request with the workspace revision, signs the selected
private PDF for the runner and starts the original `run-humanstudy-pipeline.yml`
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
with a revision. A stale save is rejected, and the UI offers a local JSON copy
before loading the current server version. Account separation is enforced by
RLS and verified server sessions, independent of the legacy promo-code gate.

Workspace telemetry captures clicks, normalized pointer positions (up to four
per second), scrolling, selection length, visibility duration and explicit
chat/review actions. Events have stable IDs, bounded queues and bounded retries.
No password, keypress or DOM-wide text capture is performed. Conversations are
saved in the study document. Settings disclose recording. Events are in
`studio_events`; this version does not provide a researcher analytics dashboard.

Export produces a ZIP with the versioned document, study model, conversations,
annotations, review responses, source manifest, available original PDFs,
applied auxiliary files and `HANDOFF.md`. It lists unresolved choices and pending proposals. The handoff is
research design data and draft materials. Packaging and validation of a runnable
study, execution and result analysis remain work for the local agent or the
legacy pipeline.

## Limits and verification

- PDFs: 25 MB each; first 40 pages rendered; 30,000 extracted characters per page
  and 990,000 per source. Scanned PDFs support region selection but need an OCR
  service for text extraction. No OCR service is configured in this version.
- Agent context: the runner reads the selected original PDF plus a bounded Studio
  context excerpt; the full context file remains available to the agent. A build
  uses the currently selected PDF as its primary source. Other attached PDFs are
  represented by extracted text and metadata in the context, not separate downloads.
- Materials: up to 30 applied files and 120 KB of combined UTF-8 content.
  Accepted formats are Markdown, CSV, JSON, text, Python and R.
- Saved document requests: 2 MB. Export includes up to 50 MB of source PDFs and
  records omissions in its manifest. Viewer truncation does not alter the stored
  original PDF.
- PDF text placement for unusual fonts or right-to-left text is approximate;
  the original raster page remains the visual reference.
- The reported `removeChild` error has no reproducible stack yet. Native text
  ranges are cleared before source/page changes, workspace translation is
  disabled, and route error boundaries provide reload recovery. These guards
  are not evidence that the original cause has been confirmed or eliminated.

The development and build scripts use Webpack. The default Turbopack build
stalled during local validation; Webpack completed on the same checkout.

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
email delivery and the Vercel team's Preview environment still need configuration.
