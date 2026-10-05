import { cookies } from "next/headers";
import type { StudioUser } from "./types";
import { isUuid, StudioError, studioConfig, studioFetch, upstreamJson } from "./http";

const ACCESS_COOKIE = "studio_access";
const REFRESH_COOKIE = "studio_refresh";
type AuthSession = { access_token: string; refresh_token: string; expires_in: number; user?: StudioUser };
export type StudioContext = { user: StudioUser; accessToken: string };

function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge };
}

export async function setStudioSession(session: AuthSession): Promise<void> {
  if (!session.access_token || !session.refresh_token) throw new StudioError(502, "invalid_service_response");
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, session.access_token, cookieOptions(Math.max(60, Math.min(session.expires_in || 3600, 3600))));
  jar.set(REFRESH_COOKIE, session.refresh_token, cookieOptions(60 * 60 * 24 * 30));
}

export async function clearStudioSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

async function verifiedUser(token: string): Promise<StudioUser | null> {
  const response = await studioFetch("/auth/v1/user", { token });
  if (response.status === 401 || response.status === 403) return null;
  const user = await upstreamJson<{ id?: unknown; email?: unknown }>(response);
  if (!isUuid(user.id)) throw new StudioError(502, "invalid_service_response");
  return { id: user.id, ...(typeof user.email === "string" ? { email: user.email } : {}) };
}

export async function requireStudioUser(): Promise<StudioContext> {
  studioConfig();
  const jar = await cookies();
  const accessToken = jar.get(ACCESS_COOKIE)?.value;
  if (accessToken) {
    const user = await verifiedUser(accessToken);
    if (user) return { user, accessToken };
  }
  const refreshToken = jar.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) throw new StudioError(401, "unauthorized");
  const response = await studioFetch("/auth/v1/token?grant_type=refresh_token", {
    method: "POST", body: { refresh_token: refreshToken },
  });
  if (!response.ok) {
    await clearStudioSession();
    throw new StudioError(401, "unauthorized");
  }
  const session = await upstreamJson<AuthSession>(response);
  if (!session.access_token || !session.refresh_token) throw new StudioError(502, "invalid_service_response");
  const user = await verifiedUser(session.access_token);
  if (!user) {
    await clearStudioSession();
    throw new StudioError(401, "unauthorized");
  }
  await setStudioSession(session);
  return { user, accessToken: session.access_token };
}
