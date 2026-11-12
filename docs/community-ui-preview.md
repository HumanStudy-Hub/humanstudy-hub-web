# Community UI review

`/review/community` exists only when the server's `VERCEL_ENV` is `preview`.
It returns 404 in production and local development unless explicitly run as a
preview. It does not change invitation or account checks on real routes.

The page uses the same credit list, Helpful button, contributor summary and
submission-history components as the real pages. Example mode is explicit:
votes and status checks only update component state, never call community APIs,
and reset on reload. The banner identifies the data as examples. Links to Forum,
Study Library and submission lead to real pages; their usual access rules apply.

No database migration, seeded account, auth secret or hosted service is required.
This preview demonstrates appearance and local interactions, not successful
publication or hosted database acceptance.

Verification: `node scripts/check-community-preview.mjs /path/to/playwright`
(with optional Chrome executable argument) checks production 404, preview vote
and cancellation, status check, reload reset, zero community API calls even with
a fixture session cookie, and mobile overflow. Screenshots are saved to
`COMMUNITY_PREVIEW_OUTPUT` or `/tmp/humanstudy-community-review`.
