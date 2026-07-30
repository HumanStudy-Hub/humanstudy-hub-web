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
workflow; Python and PDF dependencies run on the Actions runner, not inside
Vercel.

## Verification

```bash
npm run lint
npm run build
```

## Build Study backend

The Node server creates a private job branch, starts the existing Python
pipeline through GitHub Actions, and polls the saved stage state. Each
successful stage pauses for researcher approval. Stage 4 produces the
downloadable ZIP. Set `GITHUB_TOKEN` to enable job storage, pipeline dispatch,
and publishing the final package as a contribution branch and pull request.

The production server only needs GitHub API access. Do not add PDF files,
pipeline outputs, or tokens to the public web repository.
