# HumanStudy-Hub Web

Private Next.js application for HumanStudy-Hub.

## Product areas

- Dataset catalog for the initial test suite and community studies
- Human-study builder with PDF/OSF intake and human review
- Playground for running a model through a study and comparing it to the people
- HumanStudy-Bench agent evaluations and leaderboard
- Research projects, partners, and sponsorship

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Build Study jobs are stored in the private `HumanStudy-Hub/humanstudy-hub-jobs`
repository. The Vercel API dispatches the HumanStudy-Bench GitHub Actions
workflow; Claude Code, document tools, and package validation run on the Actions
runner, not inside Vercel.

## Verification

```bash
npm run lint
npm run build
```

## Build Study backend

The browser uploads the paper directly to Vercel Blob and posts only the
resulting URL to the API, because Vercel rejects any function request body over
4.5 MB and most journal PDFs are larger than that. Create a Blob store in the
Vercel project and set `BLOB_READ_WRITE_TOKEN`; Build Study cannot accept
uploads without it. The store uses private access, so the Actions runner
downloads the paper through a signed link recorded in `job.json` and commits it
to the job branch.

Blob is staging rather than storage: once the runner commits the paper, the
branch holds the durable copy. A daily cron calls `/api/blob/cleanup` to delete
anything older than two days, which also collects uploads that never became
jobs. Set `CRON_SECRET` in the Vercel project — the route refuses to run without
it, since it would otherwise let anyone empty the store.

The Node server creates a private job branch and starts a Claude Code agent
through GitHub Actions. The agent uses the paper and optional open-material URL
to build and validate the complete package, then pauses once for final
researcher review. Approval enables ZIP download and optional benchmark
contribution. Set `GITHUB_TOKEN` to enable job storage, workflow dispatch, and
publishing the final package as a contribution branch and pull request.

Build Study never calls OpenRouter from Vercel. Store `OPENROUTER_API_KEY` as an
Actions secret in `HumanStudy-Hub/HumanStudy-Bench`; the one Vercel variable of
the same name is used only by the playground's persona designer, described
below. The workflow also expects
the `HUMANSTUDY_PIPELINE_TOKEN` Actions secret and accepts an optional
`OPENROUTER_MODEL` Actions variable, which defaults to `moonshotai/kimi-k3`.

## Playground backend

`/playground` dispatches `run-playground.yml` in HumanStudy-Bench the same way
Build Study dispatches its workflow. Run state, progress, and results live on a
`runs/<id>` branch of the private jobs repository, and the page polls
`/api/playground/runs/<id>`. Nothing about a run executes inside Vercel.

The runner replays the study with the chosen model through OpenRouter, scores it
with the study's own evaluator, and then has Claude Code chart and interpret the
result. Charts are validated on the runner before they are stored, and a run
that produces no usable chart set falls back to deterministic charts.

Runs use the `OPENROUTER_API_KEY` Actions secret with a small participant cap. A
researcher can paste their own OpenRouter key to run at full size; the key is
sealed with AES-256-GCM before it leaves the server, so the jobs repository only
holds ciphertext and the workflow drops it when the run ends. Set
`PLAYGROUND_KEY_SECRET` here and as an Actions secret in HumanStudy-Bench with
the same value — without it, the playground still runs on the shared key and
only refuses researcher-supplied keys.

## Persona groups

A persona group describes *who* the agents in a run are. It is a population
rather than a fixed cast: each segment carries a share of the participants and
the ranges its members are drawn from, so one saved group fits a run of any size
and any study. `lib/persona-groups.ts` mirrors `playground/personas.py` in
HumanStudy-Bench, which does the sampling — the two validators and the
largest-remainder split must stay in step, so the mix a researcher previews is
the mix the run produces.

The designer chat calls OpenRouter directly from the server and requires
`OPENROUTER_API_KEY` here. It is the one part of the product that does, because
a design conversation needs replies in seconds; everything that touches a study
still runs in Actions. The model returns a whole group as JSON, which is
validated before it reaches the editor, and every field stays editable by hand.
Groups can be downloaded as JSON, loaded back, or contributed to the benchmark,
which opens a pull request adding
`playground/profiles/<study>-<contributor>-<n>.json` with the number rising each
time the same contributor saves another.

The production server only needs GitHub API access. Do not add PDF files,
pipeline outputs, or tokens to the public web repository.
