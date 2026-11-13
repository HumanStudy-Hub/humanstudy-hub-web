# Online cohort capacity: 50 accounts, 45-minute sessions

## Existing admission mechanism

`online_claim_workspace` takes a transaction-scoped PostgreSQL advisory lock before counting and inserting leases. Each launch must claim successfully before any provider create/resume. The later `Sandbox.list` check reconciles provider sessions, including old sessions that predate admission; it is not the distributed lock. Do not replace this with a process-local semaphore.

Capacity has two independent controls:

- `online_workspace_capacity.max_running`, per `production` or `preview` scope, initially 6. This is the atomic admission limit.
- Vercel `TRY_MAX_RUNNING`, initially 6. This is the provider reconciliation limit.

Both must be 50 in the intended environment for a 50-person cohort. `TRY_SESSION_MINUTES=45` is already the default. Preview branches share their preview capacity; production is a separate pool. Service-role application credentials can read capacity but cannot increase it. Capacity changes require an authorized database operator.

## Activation and rollback

1. Confirm the existing Vercel team's Sandbox quota and creation-rate limit allow 50 sessions /100 vCPUs, alongside any other team workloads. Published plan limits are not proof of a particular team's current entitlement. Provider references: [Sandbox](https://vercel.com/sandbox), [concurrency announcement](https://vercel.com/changelog/vercel-sandbox-increases-concurrency-and-port-limits), checked 2026-11-12.
2. Record current database capacity and deployment settings. Set `TRY_MAX_RUNNING=50` and `TRY_SESSION_MINUTES=45` in the intended environment and redeploy. Increasing this provider guard alone does not bypass the lower database limit.
3. After deployment verification, update only the intended capacity row to 50 with an authorized database connection. Leave the other scope unchanged. Do not modify hosted-model pool/account allowances ($50/1000 request pool remains independent).
4. Verify one existing test account starts, stops, and resumes with its files intact. Do not launch 50 paid sandboxes just to inspect a limit. Real 50-person throughput/latency and model-provider rate limits require separately controlled acceptance.
5. Rollback: lower the database capacity first, then the environment limit. Existing leases are not killed; new accounts are denied until usage drops below the lower cap. A stop/reopen can continue using its existing reservation.

A failed/uncertain provider create conservatively retains its reservation; capacity may remain occupied until expiry. Successful stop releases a slot. Lease expiry is initially session duration plus a 180-second startup margin, then successful startup supplies actual provider expiry. Reconnecting may extend the provider session; 45 minutes is not a hard per-account daily usage allowance.

## Offline verification and its limits

Run `node --test tests/online-workspace-admission.test.mjs tests/try-online.test.mjs`.

Tests submit 100 claims against capacity50, verify exactly50 reservations, 45-minute duration plus startup margin, duplicate-account rejection, existing-account reopen at capacity, stale-owner protection, one-slot refill, preview separation, and inability of the application role to raise capacity. Provider mocks test 49/50 active-session boundaries and that a denied claim makes no provider calls.

PGlite serializes queries; these are real SQL semantic tests plus mocked provider orchestration, **not** a multi-connection PostgreSQL contention benchmark or a paid 50-user load test. The transaction advisory lock supplies cross-function serialization in PostgreSQL. No deployment setting, hosted database row, model allowance, or paid service is changed by these tests.
