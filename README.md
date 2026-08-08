# HumanStudy-Hub Web

Private Next.js application for HumanStudy-Hub.

## Product areas

- Dataset catalog for the initial test suite and community studies
- Human-study builder with PDF/OSF intake and human review
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

`OPENROUTER_API_KEY` is not a Vercel environment variable. Store it as an
Actions secret in `HumanStudy-Hub/HumanStudy-Bench`. The workflow also expects
the `HUMANSTUDY_PIPELINE_TOKEN` Actions secret and accepts an optional
`OPENROUTER_MODEL` Actions variable, which defaults to `moonshotai/kimi-k3`.

The production server only needs GitHub API access. Do not add PDF files,
pipeline outputs, or tokens to the public web repository.
