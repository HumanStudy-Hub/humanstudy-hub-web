import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearStudioSession, requireStudioUser, setStudioSession } from "@/lib/studio/auth";
import { assertSameOrigin, isUuid, readJsonBody, routeError, studioConfig, studioFetch, upstreamJson, StudioError } from "@/lib/studio/http";
import type { StudioUser } from "@/lib/studio/types";

export async function GET() {
  try {
    studioConfig();
    try {
      const { user } = await requireStudioUser();
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
    const { action, email, password } = body as Record<string, unknown>;
    if (action === "signout") {
      const currentToken = (await cookies()).get("studio_access")?.value;
      if (currentToken) await studioFetch("/auth/v1/logout", { method: "POST", token: currentToken }).catch(() => undefined);
      await clearStudioSession();
      return NextResponse.json({ user: null });
    }
    if (action !== "signup" && action !== "signin") throw new StudioError(400, "invalid_action");
    if (typeof email !== "string" || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== "string" || password.length < 8 || password.length > 128) {
      throw new StudioError(400, "invalid_credentials");
    }
    const response = await studioFetch(action === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password", {
      method: "POST", body: { email: email.trim(), password },
    });
    if (!response.ok) {
      throw new StudioError(response.status === 429 ? 429 : 400, response.status === 429 ? "rate_limited" : "authentication_failed");
    }
    const result = await upstreamJson<{ access_token?: string; refresh_token?: string; expires_in?: number; user?: StudioUser }>(response);
    if (result.access_token && result.refresh_token) {
      const user = await (async () => {
        const verified = await studioFetch("/auth/v1/user", { token: result.access_token });
        return upstreamJson<StudioUser>(verified);
      })();
      if (!isUuid(user?.id)) throw new StudioError(502, "invalid_service_response");
      await setStudioSession({ access_token: result.access_token, refresh_token: result.refresh_token, expires_in: result.expires_in || 3600 });
      return NextResponse.json({ user, requiresEmailConfirmation: false });
    }
    if (action === "signup") return NextResponse.json({ user: null, requiresEmailConfirmation: true });
    throw new StudioError(401, "authentication_failed");
  } catch (error) {
    return routeError(error);
  }
}
