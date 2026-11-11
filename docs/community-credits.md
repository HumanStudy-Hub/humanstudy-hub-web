# Community credits

The paper detail keeps original authors separate from contributors. Existing public
contributor names remain visible. A verified Hub contribution links to a public profile
with a randomly generated ID and the display name supplied for public credit.
The Community leaderboard shows the top 50 accepted study contributions or contributors.
Ranks use Helpful votes received. Contributor ties use accepted contribution count,
then public profile ID. Study ties use submission date, then submission ID.

## Acceptance and voting

Credit requires a matching Hub submission, Bench acceptance report, immutable revision
manifest and GitHub pull request head. The signed Bench webhook checks this evidence
on a pinned Bench commit. The contribution receipt can retry the check. An accepted
historical revision keeps its credit after another revision becomes current. A
closed or merged pull request, or an unchanged review, does not grant credit by itself.

The server resolves the voter from the existing Hub session. Each account can add or
remove one Helpful vote for each accepted submission. The database enforces the
unique vote key, and its vote function rejects self-votes and mismatched revisions.
Public views show counts and contributor display names. Scientific review and the
Validated protocol badge follow the independent publication provenance contract.

## Verification and rollout

Apply the migration to an approved deployment database before enabling the branch there.
The migration and test fixtures have no production data. Bench webhook redelivery
or an authenticated receipt recheck can enroll older Hub submissions with verifiable
acceptance evidence.

```sh
npm test
npm run build
node scripts/check-community-credit.mjs /path/to/playwright
```

The browser check runs a local Next server with fixture authentication and a temporary
PGlite database. It verifies the real vote endpoint and saves paper, contributor
profile and leaderboard screenshots. It accepts a browser executable as a second
argument and `COMMUNITY_CREDIT_TEST_OUTPUT` as an output directory.
