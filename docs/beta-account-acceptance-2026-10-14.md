# Beta account acceptance · 2026-10-14

Implements checklist items 1–3 alongside the desktop account UI. No billing quotas,
automatic key renewal, ORCID requirement or production rollout is added.

## Implemented

- `/auth/reset`: request a recovery email, explicit custom-link verification,
  default Supabase implicit callback, password/confirmation, expiry guidance,
  reload an already-verified recovery page, and return to normal sign-in.
- `/auth/reset?mode=change`: logged-in users verify the current password first.
- `POST /api/studio/auth` supports `forgot-password` and preserves registration,
  confirmation and resend. Success does not disclose account existence; real email
  delivery failures and rate limits remain failures.
- Recovery uses a separate 15-minute httpOnly, strict SameSite cookie scoped to
  `/api/studio/password`. Supabase verifies each bearer before its signed AMR and
  expiry claims are checked. Ordinary password login is not recovery authority.
  Recovery never establishes normal web sign-in or issues a desktop key.
- All `/auth/*` pages are excluded from website metrics. The reset page scrubs
  tokens from browser history, has no-referrer/noindex metadata and never stores
  a password in local storage or telemetry.
- Desktop config can supply `authOrigin` from `STUDIO_AUTH_ORIGIN`, keeping email
  callbacks stable when the desktop backend is a Vercel preview.

## Local validation

- 192 web tests pass, including 12 confirmation/password route tests using mocked
  Auth responses. TypeScript and changed-file ESLint pass.
- Companion desktop account tests exercise reset/resend callbacks, delivery
  failures, current-password verification, failed update preservation and new
  password login against a stub. Desktop regression suite: 38 checks passed.
- These tests are not evidence of live SMTP receipt. No real password was changed.

## Deployment and real-service acceptance

1. Deploy this branch to Preview; deploy the companion desktop test build only
   after the preview has been checked. Keep the original research projects intact.
2. The configured auth origin must serve this new reset page and API. An existing
   production `STUDIO_AUTH_ORIGIN` whose site lacks the page will not work merely
   because a preview was deployed. Do not silently change production configuration.
3. Supabase Auth redirect allowlist must contain the chosen origin's `/auth/reset`
   and `/auth/confirm`. Use an exact trusted origin; avoid wildcard redirects.
4. Default recovery template may use `{{ .ConfirmationURL }}`. A custom template
   can link to `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`.
   Confirmation and recovery must not be mixed into the same callback type.
5. With a controlled test account/mailbox, verify actual receipt, expired/reused
   links, password replacement and normal sign-in on web and desktop. Do not alter
   the owner's real password as an automated test. Delivery errors must stay visible.

The unrelated offline-event RLS migration is explicitly excluded from this change.

Preview setup: branch-scoped STUDIO_AUTH_ORIGIN points to this branch's stable
Preview alias. SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY were added only for this
Preview branch, using the existing website's public configuration. No production
secret was copied. Supabase redirect allowlist now includes this exact Preview's
/auth/reset and /auth/confirm; existing redirects and Site URL are preserved.
The recovery email template already uses ConfirmationURL and required no change.

Desktop source correction: the installed app is 0.5.2, from local integration
commit c0b8587. The companion account changes have been ported to an isolated
worktree based on that commit (not older upstream main); 49 regressions pass there.
The beta desktop keeps its existing production model backend, with a build-time
auth callback override for these Preview pages. Its next test build is 0.5.3-beta.1.
