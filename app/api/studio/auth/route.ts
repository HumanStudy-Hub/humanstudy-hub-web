import { NextResponse } from "next/server";
import { migrateStudioSession, clearStudioSession, establishStudioSession, requireStudioUser, studioConfirmationUrl } from "@/lib/studio/auth";
import { assertSameOrigin, readJsonBody, routeError, studioConfig, studioFetch, upstreamJson, StudioError } from "@/lib/studio/http";
import type { StudioUser } from "@/lib/studio/types";

async function checkAuthResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  const code = body.error_code || body.code;
  if (response.status === 429 || ["over_email_send_rate_limit", "over_request_rate_limit"].includes(code)) throw new StudioError(429, "rate_limited");
  if (code === "email_not_confirmed") throw new StudioError(400, "email_not_confirmed");
  if (code === "email_address_not_authorized") throw new StudioError(503, "email_delivery_setup_required");
  if (code === "otp_expired") throw new StudioError(400, "confirmation_expired");
  throw new StudioError(response.status >= 500 ? 502 : 400, response.status >= 500 ? "email_service_unavailable" : "authentication_failed");
}

export async function GET() {
  try {
    studioConfig();
    try {
      const { user } = await requireStudioUser();
      await migrateStudioSession();
      return NextResponse.json({ user, configured: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof StudioError && error.status === 401) {
        return NextResponse.json({ user: null, configured: true }, { headers: { "Cache-Control": "no-store" } });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof StudioError && error.code === "setup_required") {
      return NextResponse.json({ user: null, configured: false, error: "setup_required" }, { status: 503 });
    }
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    studioConfig();
    assertSameOrigin(request);
    const body = await readJsonBody(request, 8_192);
    if (!body || typeof body !== "object") throw new StudioError(400, "invalid_request");
    const { action, email, password, tokenHash, type, returnTo } = body as Record<string, unknown>;
    if (action === "save-profile") {
      const { user, accessToken } = await requireStudioUser();
      const { name, affiliation } = body as Record<string, unknown>;
      if (typeof name !== "string" || !name.trim() || name.length > 200 ||
        typeof affiliation !== "string" || affiliation.length > 300 || /[\u0000-\u001f\u007f]/.test(name + affiliation)) {
        throw new StudioError(400, "invalid_profile");
      }
      const profile = { name: name.trim(), affiliation: affiliation.trim() };
      const response = await studioFetch("/auth/v1/user", { method: "PUT", token: accessToken,
        body: { data: { hub_name: profile.name, hub_affiliation: profile.affiliation } } });
      await checkAuthResponse(response);
      return NextResponse.json({ user: { ...user, profile } }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "change-email") {
      const { user } = await requireStudioUser();
      const { currentPassword } = body as Record<string, unknown>;
      const nextEmail = typeof email === "string" ? email.trim() : "";
      if (!user.email || typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 128) {
        throw new StudioError(400, "invalid_current_password");
      }
      if (!/^\S+@\S+\.\S+$/.test(nextEmail) || nextEmail.length > 254 || nextEmail.toLowerCase() === user.email.toLowerCase()) {
        throw new StudioError(400, "invalid_new_email");
      }
      const response = await studioFetch("/auth/v1/token?grant_type=password", {
        method: "POST", body: { email: user.email, password: currentPassword },
      });
      if ([400, 401, 403].includes(response.status)) {
        const detail = await response.clone().json().catch(() => ({}));
        if (!["over_email_send_rate_limit", "over_request_rate_limit"].includes(detail.error_code || detail.code)) {
          throw new StudioError(400, "invalid_current_password");
        }
      }
      await checkAuthResponse(response);
      const session = await upstreamJson<{ access_token?: string; user?: { id?: string } }>(response);
      if (!session.access_token || session.user?.id !== user.id) throw new StudioError(401, "unauthorized");
      const redirectTo = studioConfirmationUrl(request, "account");
      const update = await studioFetch(`/auth/v1/user?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "PUT", token: session.access_token, body: { email: nextEmail },
      });
      if ([400, 422].includes(update.status)) {
        const detail = await update.clone().json().catch(() => ({}));
        if (!["over_email_send_rate_limit", "over_request_rate_limit"].includes(detail.error_code || detail.code)) {
          throw new StudioError(400, "email_change_failed");
        }
      }
      await checkAuthResponse(update);
      return NextResponse.json({ confirmationRequested: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "signout") {
      let currentToken: string | undefined;
      try { currentToken = (await requireStudioUser()).accessToken; }
      catch (error) { if (!(error instanceof StudioError && error.status === 401)) throw error; }
      if (currentToken) {
        // Online workspaces and other devices use independent Supabase sessions.
        const result = await studioFetch("/auth/v1/logout?scope=local", { method: "POST", token: currentToken });
        if (!result.ok && result.status !== 401 && result.status !== 403) throw new StudioError(502, "service_unavailable");
      }
      await clearStudioSession();
      return NextResponse.json({ user: null });
    }
    if (action === "confirm") {
      // Only email verification is supported here, not recovery/email-change tokens.
      if (type !== "email" || typeof tokenHash !== "string" || !/^[a-f0-9]{40,128}$/i.test(tokenHash)) throw new StudioError(400, "invalid_confirmation");
      const response = await studioFetch("/auth/v1/verify", { method: "POST", body: { token_hash: tokenHash, type: "email" } });
      await checkAuthResponse(response);
      const session = await upstreamJson<{access_token: string; refresh_token: string; expires_in: number}>(response);
      const user = await establishStudioSession(session);
      return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action !== "signup" && action !== "signin" && action !== "resend" && action !== "forgot-password") throw new StudioError(400, "invalid_action");
    if (typeof email !== "string" || email.trim().length > 254 || !/^\S+@\S+\.\S+$/.test(email.trim())) throw new StudioError(400, "invalid_credentials");
    if (action === "resend" || action === "forgot-password") {
      const reset = action === "forgot-password";
      const response = await studioFetch(`/auth/v1/${reset ? 'recover' : 'resend'}?redirect_to=${encodeURIComponent(studioConfirmationUrl(request, reset ? 'reset' : 'confirm', returnTo))}`, { method: "POST", body: { email: email.trim(), ...(!reset ? { type: "signup" } : {}) } });
      // Do not disclose whether an address has an account.
      if (!response.ok) {
        const detail = await response.clone().json().catch(() => ({}));
        if (!["user_not_found", "email_already_confirmed"].includes(detail.error_code || detail.code)) await checkAuthResponse(response);
      }
      return NextResponse.json(reset ? { sent: true } : { requiresEmailConfirmation: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      throw new StudioError(400, "invalid_credentials");
    }
    const response = await studioFetch(action === "signup" ? `/auth/v1/signup?redirect_to=${encodeURIComponent(studioConfirmationUrl(request, "confirm", returnTo))}` : "/auth/v1/token?grant_type=password", {
      method: "POST", body: { email: email.trim(), password },
    });
    await checkAuthResponse(response);
    const result = await upstreamJson<{ access_token?: string; refresh_token?: string; expires_in?: number; user?: StudioUser }>(response);
    if (result.access_token && result.refresh_token) {
      const user = await establishStudioSession({ access_token: result.access_token, refresh_token: result.refresh_token, expires_in: result.expires_in || 3600 });
      return NextResponse.json({ user, requiresEmailConfirmation: false });
    }
    if (action === "signup") return NextResponse.json({ user: null, requiresEmailConfirmation: true });
    throw new StudioError(401, "authentication_failed");
  } catch (error) {
    return routeError(error);
  }
}
