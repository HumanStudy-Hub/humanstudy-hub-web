import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearStudioSession, establishStudioSession, requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, isUuid, readJsonBody, routeError, studioFetch, upstreamJson, StudioError } from "@/lib/studio/http";

const RECOVERY_COOKIE = "studio_password_recovery";
const RECOVERY_SECONDS = 900;

async function checked(response: Response, expired = false): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  const code = body.error_code || body.code;
  if (response.status === 429) throw new StudioError(429, "rate_limited");
  if (["weak_password", "same_password", "reauthentication_needed", "reauthentication_not_valid"].includes(code)) throw new StudioError(400, code);
  if (response.status >= 500) throw new StudioError(502, "service_unavailable");
  throw new StudioError(400, expired ? "recovery_expired" : "invalid_current_password");
}

async function userFor(token: string): Promise<{ id: string; email: string }> {
  const response = await studioFetch("/auth/v1/user", { token });
  await checked(response, true);
  const user = await upstreamJson<{ id?: unknown; email?: unknown }>(response);
  if (!isUuid(user.id) || typeof user.email !== "string") throw new StudioError(400, "recovery_expired");
  return { id: user.id, email: user.email };
}

/** Read claims only AFTER Supabase verified this bearer. Never authorize from user_metadata. */
function freshEmailAuthorization(token: string): boolean {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    return typeof claims.exp === "number" && claims.exp > now && Array.isArray(claims.amr) && claims.amr.some((entry: { method?: unknown; timestamp?: unknown }) =>
      ["otp", "recovery"].includes(String(entry.method)) && typeof entry.timestamp === "number" && entry.timestamp >= now - RECOVERY_SECONDS && entry.timestamp <= now + 60);
  } catch { return false; }
}

export async function GET() {
  try {
    const token = (await cookies()).get(RECOVERY_COOKIE)?.value;
    if (!token) return NextResponse.json({ ready: false }, { headers: { "Cache-Control": "no-store" } });
    const user = await userFor(token);
    if (!freshEmailAuthorization(token)) throw new StudioError(400, "recovery_expired");
    return NextResponse.json({ ready: true, email: user.email }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 16_384) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new StudioError(400, "invalid_request");
    const jar = await cookies();
    const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/api/studio/password", maxAge: RECOVERY_SECONDS };
    if (body.action === "clear") {
      jar.set(RECOVERY_COOKIE, "", { ...cookieOptions, maxAge: 0 });
      return NextResponse.json({ cleared: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "begin") {
      let token: unknown;
      if (typeof body.tokenHash === "string" && /^[a-f0-9]{40,128}$/i.test(body.tokenHash)) {
        const response = await studioFetch("/auth/v1/verify", { method: "POST", body: { token_hash: body.tokenHash, type: "recovery" } });
        await checked(response, true);
        token = (await upstreamJson<{ access_token?: unknown }>(response)).access_token;
      } else if (body.type === "recovery" && typeof body.accessToken === "string") token = body.accessToken;
      if (typeof token !== "string" || !token || token.length > 12_000) throw new StudioError(400, "invalid_recovery");
      const user = await userFor(token);
      if (!freshEmailAuthorization(token)) throw new StudioError(400, "recovery_expired");
      // Recovery authority is isolated: no web sign-in or desktop-key grant.
      jar.set(RECOVERY_COOKIE, token, cookieOptions);
      return NextResponse.json({ ready: true, email: user.email }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action !== "reset" && body.action !== "change") throw new StudioError(400, "invalid_action");
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) throw new StudioError(400, "invalid_password");
    if (body.action === "change") {
      const { user } = await requireStudioUser();
      if (!user.email || typeof body.currentPassword !== "string" || !body.currentPassword || body.currentPassword.length > 128) throw new StudioError(400, "invalid_current_password");
      const response = await studioFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email: user.email, password: body.currentPassword } });
      await checked(response);
      const session = await upstreamJson<{ access_token: string; refresh_token: string; expires_in: number }>(response);
      if ((await userFor(session.access_token)).id !== user.id) throw new StudioError(401, "unauthorized");
      const update = await studioFetch("/auth/v1/user", { method: "PUT", token: session.access_token, body: { password: body.password } });
      await checked(update);
      await establishStudioSession(session);
    } else {
      const token = jar.get(RECOVERY_COOKIE)?.value;
      if (!token) throw new StudioError(401, "recovery_required");
      await userFor(token);
      if (!freshEmailAuthorization(token)) throw new StudioError(400, "recovery_expired");
      const update = await studioFetch("/auth/v1/user", { method: "PUT", token, body: { password: body.password } });
      await checked(update, true);
      jar.set(RECOVERY_COOKIE, "", { ...cookieOptions, maxAge: 0 });
      // Return to normal sign-in rather than leaving an email-link session signed in.
      await clearStudioSession();
    }
    return NextResponse.json({ updated: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeError(error); }
}
