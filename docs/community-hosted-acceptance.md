# Private hosted contribution acceptance

This is test infrastructure, not a change to production publication policy.

## Current boundary

Production credit always reads official `HumanStudy-Hub/HumanStudy-Bench` main. Preview reads official dev by default. For a controlled private-repository test only, set `COMMUNITY_CREDIT_PREVIEW_REPO` to the same repository as `COMMUNITY_REPO`. Files are read through authenticated GitHub Contents requests pinned to the resolved dev commit; no token is sent to raw.githubusercontent.com. Proposal head, revision digest and repository checks remain required. The override is ignored outside Vercel preview.

Do not enable the override in a deployment connected to the shared production contribution database: a successful test registers real credit. Use an isolated acceptance database and dedicated GitHub accounts. No source PDFs, private user records or existing production proposals are test fixtures.

## Minimal remaining live acceptance

1. Establish a controlled private repository carrying the trusted Bench dev workflow and a dev branch, plus an isolated contribution database. Check repository ownership and existing contents before reusing it. Never overwrite another project's repository.
2. Configure its preview deployment with matching intake/credit repository, server-side GitHub credentials and isolated database credentials. Ensure the maintainer workflow is enabled. Keep model secrets absent: the dev path uses curator review only.
3. Sign in as the submitter and submit the invented lamp Program, with public-review consent and contributor name. Confirm one proposal and no credit before acceptance.
4. As a different authorized maintainer, dispatch the trusted dev workflow with the exact proposal head and candidate revision. Confirm accepted immutable revision and `user-submitted` provenance. Do not grant Validated or publish fixtures to main.
5. Recheck the submission from the preview UI. Confirm one credit, public contributor name, no private account identifier and no Validated label. Repeat recheck to confirm idempotency.
6. Submit a malformed successor and confirm it cannot replace the accepted revision. Preserve sanitized receipts and remove only owned test resources.

A local mock/PGlite trace is not a hosted pass. A private repository alone is insufficient isolation if the preview shares production database credentials.
