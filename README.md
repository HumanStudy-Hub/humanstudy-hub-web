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
npm run dev
```

Open `http://localhost:3000`.

## Verification

```bash
npm run lint
npm run build
```

## Environment

The legacy contribution endpoint uses:

- `GITHUB_TOKEN`: token permitted to create contribution branches and pull requests
- `GITHUB_REPO`: target repository, defaulting to `HumanStudy-Hub/HumanStudy-Bench`

Pipeline execution, review persistence, ZIP export, and GitHub publishing will be
connected through the private application backend.
