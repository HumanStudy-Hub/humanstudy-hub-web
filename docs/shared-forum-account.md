# Shared Hub and forum account

The existing Supabase project remains the account authority for web, desktop, and forum. Desktop continues using its existing Supabase tokens; it does not read browser cookies or need a release for this change.

Production web environment:

- `HUB_AUTH_ORIGIN=https://humanstudy-hub.com`
- `HUB_AUTH_COOKIE_DOMAIN=.humanstudy-hub.com`
- Existing `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` must point to the shared Hub project.

Do not enable parent-domain cookies in a preview deployment or on an untrusted subdomain. Every host below humanstudy-hub.com belongs to the same cookie trust boundary. Production shared configuration fails closed for any other origin/domain combination.

## Browser contract

- `/account` displays the shared account or sign-in/sign-up form.
- `/account?returnTo=https%3A%2F%2Fforum.humanstudy-hub.com%2F...` returns to that page once authenticated. Only the explicit Hub, www Hub, and forum HTTPS origins are allowed. Account/auth return destinations, credentials, fragments, and token-bearing return URLs are rejected.
- `/account?action=logout&returnTo=...` asks for explicit sign-out confirmation. The actual sign-out is a same-origin JSON POST to `/api/studio/auth`; GET never logs out.
- `/auth/refresh?returnTo=...` is the central writable browser session maintenance endpoint. It refreshes when required and redirects back; an invalid session returns to `/account`, and a backend outage returns 503 without deleting credentials.
- `hub_access` and `hub_refresh` are HttpOnly, Secure, SameSite=Lax, Path=/ cookies with the configured parent domain. Forum reads only these names and redirects to the central refresh endpoint rather than independently rotating refresh tokens.
- Existing web `studio_access` and `studio_refresh` host cookies are verified, promoted to the shared names, and expired when the account API is visited. Separate names avoid browser ambiguity between old host and new domain scopes.
- API auth still supports host-only studio cookies when shared configuration is not enabled. Read-only server contexts must call `requireStudioUser({ allowRefresh: false })`; refresh writes belong in route handlers.

## Live session validation

Shared cookie authorization calls Supabase `/auth/v1/user` and the additive authenticated RPC `POST /rest/v1/rpc/hub_session_active` with `{}`. The RPC must return the JSON boolean `true` only when the authenticated user's JWT `session_id` still exists in `auth.sessions`. This prevents a revoked access JWT authorizing forum/web requests until its expiry. Missing/malformed RPC or upstream outage is an error, never a reason to clear credentials.

## Email callbacks

Sign-up, resend and password-reset requests accept an allowlisted `returnTo` and include it in the existing `/auth/confirm` or `/auth/reset` redirect. Email templates must preserve the redirect URL, including its query, as an encoded nested callback using the canonical templates below. Do not append `?token_hash=...` directly to `{{ .RedirectTo }}`: the redirect may already contain `?returnTo=...`. Configure Supabase redirect allowlist for those central callback paths, including query parameters. Custom token-hash confirmation remains click-to-confirm; implicit default callback fragments are scrubbed and the user signs in normally. Password recovery authority remains isolated in the existing short-lived recovery cookie. Password reset does not automatically sign a user in. Without `returnTo`, existing desktop/web recovery and confirmation behavior is unchanged.

No access or refresh token is passed between Hub and forum in a URL. Account and callback pages are omitted from website analytics.

### Canonical Supabase email links

Confirm signup (HTML href):

```html
<a href="https://humanstudy-hub.com/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email&amp;callback={{ .RedirectTo | urlquery }}">Confirm email</a>
```

Reset password (HTML href):

```html
<a href="https://humanstudy-hub.com/auth/reset?token_hash={{ .TokenHash }}&amp;type=recovery&amp;callback={{ .RedirectTo | urlquery }}">Reset password</a>
```

The fixed outer URL guarantees that `token_hash` and `type` are actual callback-page parameters. Supabase's Go template `urlquery` encodes the whole RedirectTo URL; the application parses the outer query once, then accepts a nested callback only at the exact `https://humanstudy-hub.com/auth/confirm` or `/auth/reset` path matching the current page. Only its one allowlisted `returnTo` value is retained. Nested credentials, fragments, extra query keys, cross-flow paths, arbitrary hosts and oversized values are discarded. No nested access/refresh tokens are forwarded. Existing bare confirmation and recovery links without `callback` remain supported. Explicit allowlisted `returnTo` on old links also remains supported.

Roll out callback-page support before replacing production email templates. These templates are shared with existing desktop accounts; retain each template's matching email/recovery type.
