# Usage plans (Free allowance + Pro)

Off by default. Set `USAGE_PLANS_ENABLED=1` only after the migration below is applied.

## How model access worked before this change

| Piece | What it does |
|---|---|
| `lib/access.ts`, `lib/access-edge.ts`, `proxy.ts`, `POST /api/access` | One site-wide `PROMO_CODE`. A cookie (`hs_unlock`, HMAC of a fixed message) opens `/pipeline`, `/playground`, `/contribute` and their APIs. This cookie is not tied to any user. |
| `POST /api/desktop/key` | A signed-in Supabase session plus an invitation code (`PROMO_CODE` or one of `DESKTOP_INVITE_CODES`) gets a **desktop key**: `hsd_v1.<payload>.<hmac>`, carrying the user id and a 30-day expiry, signed with `ACCESS_COOKIE_SECRET`. The proxy checks it without a database call. |
| `POST /api/desktop/v1/chat/completions` | The **hosted route**. It checks the desktop key and the model (`DESKTOP_MODELS`), then forwards to OpenRouter with the **one shared server key** (`OPENROUTER_API_KEY`), tagging `user: hsd:<uid>`. There were no per-user keys, limits or metering. The only bound was the key's 30-day expiry. |
| `GET /api/desktop/v1/models`, `GET /api/desktop/config` | The model list (public config: Supabase URL and key, default model, models). |
| `POST /api/try`, `lib/try-online.ts` | Try online: a signed-in user plus an invitation code (remembered in the `hs_try` cookie) gets a per-user Vercel Sandbox running the desktop app. That app is seeded with a minted desktop key, so it spends through the same hosted route. At most `TRY_MAX_RUNNING` sandboxes run at once. |
| Desktop (`humanstudy-desktop` `account-core.ts`, `model-relay.ts`) | The agent conversation (building a study) calls the hosted route directly. Simulations on macOS go through a per-run local relay with a token cap (`run-limits.ts`: 40k tokens per participant, 1-60 per condition), which then calls the hosted route. On Linux and Windows the package code holds the hosted key itself, so only the server can bound spend. |
| Web playground and build (`/api/playground`, `/api/pipeline`) | These run on GitHub Actions with the Actions secret key. They are gated by the promo cookie only, are anonymous (no user id), and their pages are hidden. They are **not metered** by this change. |

## Design

- **One config:** `lib/plans-config.ts` holds each plan's monthly budget (US dollars), allowed models,
  default model, participants per arm, batch runs and priority. The numbers there are proposals for
  the owner to set.
- **Spend is OpenRouter's reported cost.** The hosted route asks for `usage: {include: true}` (and
  `stream_options.include_usage` for streams) and records `usage.cost`, so the code keeps no price
  table.
  - Metered calls are always read to their end, even when the client disconnects. The cost comes
    last, and OpenRouter bills a generation once it has started. For the same reason the client's
    abort is not passed upstream; `max_tokens` and `maxDuration` bound the call.
  - A reply without a cost is looked up via `GET /api/v1/generation?id=`. If no cost can be found,
    the call is charged its full reservation, so an unpriced call is never free.
  - Failed upstream calls are not charged.
  - OpenRouter routing fields (`models`, `route`, `preset`) are dropped, so a call cannot reach a
    model outside the plan.
- **Month = calendar month, UTC.** The allowance renews at 00:00 UTC on the 1st.
- **Enforcement is on the server, in the hosted route** (`lib/usage-meter.ts`). Before a call is
  forwarded:
  - The model must be in the plan, otherwise 403 `model_not_in_plan`.
  - Each call takes an **atomic reservation** (`begin_model_call`, one lock per account): the
    plan's `reservePerCallUsd` is held against the month while the call runs.
    - Refused when spend plus every live reservation plus this one would pass the budget.
    - Refused with 429 `too_many_in_flight` (clients retry) above `maxConcurrentCalls`.
    - The overrun is bounded by how far one call's real cost exceeds its reservation.
    - `end_model_call` swaps the reservation for the real cost, charged to the month the call was
      admitted in.
    - A reservation left behind by a crashed function stops counting after 10 minutes.
  - The month must not be used up, otherwise 402 `allowance_exhausted` with
    "You've used this month's free allowance. It renews on December 1, 2026." (`message`, plus
    `message_zh`). It is 402, not 429, so clients do not retry.
  - If the usage store cannot be reached, the call is refused (503 `usage_unavailable`). This fails
    closed on purpose: without the store nothing bounds spend.
- **Every signed-in account is on Free.** With plans on, `/api/desktop/key` needs no invitation
  code. Pro is a row in `account_plans`, set by an admin (SQL below). There is no payment integration.
- **Plan-aware config:** `/api/desktop/config` and `/api/desktop/v1/models`, called with a desktop
  key, return the plan's models and default. The config response also carries `plan` and `usage`.
- **Desktop claim:** `/api/desktop/config` carries `plans: true` when plans are on. Only then does
  the desktop ask for a key without a code.
- **Usage visible:**
  - `GET /api/usage` (website session or desktop key) returns
    `{enabled, plan, label, usedUsd, limitUsd, remainingUsd, period, renewsAt, exhausted, line, line_zh, message?}`.
  - The website `/account` page shows one line.
  - Desktop Settings → Account shows it on the existing "Model access" line.
- **Entitlements without server enforcement yet:**
  - `maxParticipantsPerArm`, `batchAcrossModels` and `priority` are in the config and returned to
    clients.
  - The desktop relay still caps participants per condition at 60, and no feature reads batch or
    priority yet.
  - The budget is the hard bound in every case.

## Database (migration written, not applied)

`supabase/migrations/20261109120000_usage_plans.sql` is additive and safe to re-run.

- **Tables:**
  - `account_plans(user_id, plan, note, updated_at)`
  - `model_usage_monthly(user_id, period, cost_usd, requests, prompt_tokens, completion_tokens, updated_at)`
  - `model_calls_inflight` (reservations; service role only)
- **Access:** both tables have RLS. Users can select their own rows and nothing else. Writes go
  through the service role only.
- **RPCs:** `model_allowance`, `begin_model_call`, `end_model_call` and `add_model_usage`,
  executable by the service role only.
- A deleted account's key fails at `begin_model_call` (foreign key), so the call is refused with
  503 instead of running unmetered.

Apply it, then turn plans on:

1. Review the SQL, then apply it to the project in the Supabase SQL editor, or with
   `supabase migration up` against a linked project. Do it in a maintenance window you choose. It
   only creates new objects.
2. Make sure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set for the web project. They
   already are wherever the community store runs.
3. Set `USAGE_PLANS_ENABLED=1` (Preview first) and redeploy.

Set Pro for an account:

```sql
insert into public.account_plans (user_id, plan, note) values ('<user uuid>', 'pro', '<why>')
on conflict (user_id) do update set plan = excluded.plan, note = excluded.note, updated_at = now();
```

See an account's month: `select * from public.model_usage_monthly where user_id = '<uuid>' order by period desc;`

## Rollout notes

- Older desktop builds (before the matching desktop change):
  - They still show the invitation-code box. With plans on, any text unlocks them.
  - They request their saved model. If that model is not in Free (e.g. Sonnet 5.5), they get the
    clear `model_not_in_plan` message until they update, or until the model is added to Free's list.
- Free keys for anyone who can sign up make each new account worth one monthly allowance. Email
  confirmation is the only brake today.
- Try online keeps its invitation code (sandbox capacity is a separate limit).

## Tests

`tests/usage-plans.test.mjs` covers:

- month and renewal boundaries
- plan limits from the config
- plan models
- the exhaustion and usage messages in English and Chinese
- SSE usage parsing
- admission (fail closed, model gating, exhaustion)
- parallel-call reservations and the in-flight cap
- routing fields dropped
- metering of JSON replies, streams, and streams cancelled before or after their first chunk
- unpriced replies, and failed calls releasing their reservation
- accumulation up to refusal
- the store RPCs
- the hosted route, with no upstream call once exhausted and no change with the flag off
- the key route without a code
- the migration on real PostgreSQL (PGlite): accumulation, month separation, the plan default,
  reservations (in-flight cap, release, stale rows, deleted accounts), RLS and grants
