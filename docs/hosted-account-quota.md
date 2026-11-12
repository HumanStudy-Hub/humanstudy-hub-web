# Hosted account allowances (opt-in rollout)

This migration and code are prepared for dev review. No live grant, environment toggle, database migration or production release is implied.

## Rollout

1. Independently review/apply `20261112185733_hosted_account_model_allowances.sql` on a disposable DB, then the approved shared project. It extends `online_dev_model_budget` and preserves the `singleton=true` smoke row/RPC. No allowance rows are added automatically. Smoke retains its original $9/100 schema bounds; an already modified live smoke limit needs explicit migration review before applying, never an unnoticed reset. New pool/account rows use `singleton=NULL`.
2. Provision an approved `dev:pool` row and `dev:account:<auth UUID>` rows, `environment=dev`, scope `pool`/`account`, reviewed model list, finite expiry and explicit micro-USD/request balances. The pool user_id is NULL; the account user_id is the real auth UUID. A missing/revoked/expired row denies every request. Schema maximums are storage bounds, not authorization to spend.
3. Before setting the flag, verify `DESKTOP_DEFAULT_MODEL` has a reviewed price bound and is in `DESKTOP_MODELS`; otherwise config returns 503. The current bound map covers Haiku 5.5 and the explicit DeepSeek 1017 id, not Sonnet or the unversioned DeepSeek alias. Do not silently switch defaults; review pricing before a production rollout. Set `HOSTED_MODEL_QUOTAS=1` only on dev and redeploy. Environment is derived from VERCEL_ENV and exact dev branch. Other preview branches remain closed. Without this flag (or with `0`), the existing fixture-only smoke path and current production behavior are preserved. Invalid nonempty values fail closed on the completion route.
4. Production requires a separately approved release, production pool/account grants and production-scoped `HOSTED_MODEL_QUOTAS=1`. Never use a client JSON field to choose environment/account. All identities come from the verified Desktop key.
5. To revoke immediately, set the account row `revoked=true` or expire it. Revocation is checked on every reservation; settlement cannot un-revoke the row. Zeroing balance temporarily blocks requests but is not durable revocation because later settlement can return unused reservations. Admin grant management is outside public APIs.

Public `/api/desktop/config` remains available so a new app can discover Supabase sign-in configuration. Under rollout it advertises only models with reviewed price bounds and refuses an unsupported default rather than switching models. Authenticated `/api/desktop/v1/models` filters by the caller's own active grants. It returns no balances or other users. The completion RPC rechecks grants atomically; model discovery is not authorization to spend.

## Accounting boundaries

The same existing allowance table holds account and pool balances. Reserve locks pool then account and debits both or neither. A new small `online_model_reservations` table records request UUID, model, account/environment, reserved amount and final state—never prompts or paper content. The service role alone may invoke reserve/settle; anon/authenticated have no access.

`settleHostedCompletion()` is server-only, has no HTTP endpoint, and is deliberately **not connected to streaming refunds yet**. The caller must independently obtain complete trusted provider usage, convert cost to integer micro-USD by rounding up, and finalize the reservation once. Matching repeat settlement does not refund twice; conflicting repeat settlement is rejected. Unknown/disconnected requests retain the reservation. Provider cost above the reserved maximum records an overrun and revokes the account/pool. Deleted grants keep the reservation pending rather than fabricate a refund.

Safe structured logs include the reservation UUID before forwarding and the upstream request id (when returned) with response status. They contain no credentials, source text or chats. A reservation UUID is a correlation key, not a public refund capability. This is **not accurate billing or a paid-credit product** until trusted settlement is connected and accepted. Do not permanently bill users for worst-case reservations or present them as provider spend.

## Payload and failure behavior

Raw request bodies are read with a 4,000,000-byte UTF-8 stream cap in every environment. Oversize returns 413 and cancels reading; no source text is truncated. Invalid UTF-8/JSON returns 400. Quota-enabled requests also use the existing bounded provider payload: known prices/models, supported generation fields, explicit output cap and provider max-price/no-fallbacks. Unsupported content returns 400 without a provider call. Missing grants/DB failure/exhaustion returns 429 before forwarding; saved project files are unaffected.

## Review/test scope

Tests cover byte limits, split multibyte decoding, old production flag-off behavior, denied/oversized requests making no provider call, scope injection rejection, account/pool budgets, concurrent queued attempts, duplicate settlement, revocation/expiry, overrun, privilege denial and unchanged smoke RPC. PGlite exercises real Postgres SQL/functions but serializes work internally; a separate real multi-connection acceptance is required before shared DB enablement. No paid model request is needed for these checks.
