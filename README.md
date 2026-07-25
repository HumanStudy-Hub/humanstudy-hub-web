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

Set `HUMANSTUDY_BENCH_ROOT` to a HumanStudy-Bench checkout, and use a Python
environment with its `llm` and `pdf` extras installed. Build Study jobs and
review decisions are persisted under `HUMANSTUDY_JOBS_ROOT`.

## Verification

```bash
npm run lint
npm run build
```

## Build Study backend

The Node server starts the existing Python pipeline one stage at a time. Each
successful stage pauses for researcher approval. Stage 4 produces the downloadable
ZIP. Set `GITHUB_TOKEN` to enable publishing that package as a contribution branch
and pull request.

The production server needs a persistent filesystem and access to the benchmark
checkout or an equivalent pipeline worker image.
