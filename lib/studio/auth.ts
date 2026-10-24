import { sharedCookieDomain, accountReturnTo } from "./auth-policy";
import { cookies } from "next/headers";
import type { StudioUser } from "./types";
import { isUuid, StudioError, studioConfig, studioFetch, upstreamJson } from "./http";

const ACCESS_COOKIE = "studio_access";
const REFRESH_COOKIE = "studio_refresh";
type AuthSession = { access_token: string; refresh_token: string; expires_in: number; user?: StudioUser };
export type StudioContext = { user: StudioUser; accessToken: string };

// Use a stable hosted origin when configured, so preview-deployment URLs do not
// need a broad redirect allowlist. Otherwise use the already checked POST origin.
export function studioConfirmationUrl(request: Request, destination: 'confirm' | 'reset' = 'confirm', returnTo?: unknown): string {
  const raw = process.env.HUB_AUTH_ORIGIN || process.env.STUDIO_AUTH_ORIGIN || request.headers.get("origin");
  try {
    const url = new URL(raw || "");
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid origin");
    const target = new URL(`/auth/${destination}`, url.origin);
    const next = accountReturnTo(returnTo);
    if (next) target.searchParams.set("returnTo", next);
    return target.href;
  } catch { throw new StudioError(503, "auth_redirect_setup_required"); }
}

export async function establishStudioSession(session: AuthSession): Promise<StudioUser> {
  if (typeof session.access_token !== "string" || typeof session.refresh_token !== "string" || !session.access_token || !session.refresh_token) throw new StudioError(502, "invalid_service_response");
  const user = await verifiedUser(session.access_token);
  if (!user) throw new StudioError(401, "authentication_failed");
  await setStudioSession(session);
  return user;
}

function cookieOptions(maxAge: number) {
  return { ...(sharedCookieDomain() ? { domain: sharedCookieDomain() } : {}), httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge };
}

export async function setStudioSession(session: AuthSession): Promise<void> {
  if (!session.access_token || !session.refresh_token) throw new StudioError(502, "invalid_service_response");
  const jar = await cookies();
  jar.set(sharedCookieDomain() ? "hub_access" : ACCESS_COOKIE, session.access_token, cookieOptions(Math.max(60, Math.min(session.expires_in || 3600, 3600))));
  jar.set(sharedCookieDomain() ? "hub_refresh" : REFRESH_COOKIE, session.refresh_token, cookieOptions(60 * 60 * 24 * 30));
  if (sharedCookieDomain()) {
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) jar.set(name, "", { ...cookieOptions(0), domain: undefined });
  }
}

export async function clearStudioSession(): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, "", { ...cookieOptions(0), domain: undefined });
  jar.set(REFRESH_COOKIE, "", { ...cookieOptions(0), domain: undefined });
  if (sharedCookieDomain()) {
    jar.set("hub_access", "", cookieOptions(0));
    jar.set("hub_refresh", "", cookieOptions(0));
  }
}

async function verifiedUser(token: string): Promise<StudioUser | null> {
  const response = await studioFetch("/auth/v1/user", { token });
  if (response.status === 401 || response.status === 403) return null;
  const user = await upstreamJson<{ id?: unknown; email?: unknown }>(response);
  if (!isUuid(user.id)) throw new StudioError(502, "invalid_service_response");
  if (sharedCookieDomain()) {
    const active = await studioFetch("/rest/v1/rpc/hub_session_active", { method: "POST", token, body: {} });
    if (active.status === 401) return null;
    if (!active.ok) throw new StudioError(502, "service_unavailable");
    const isActive = await upstreamJson<unknown>(active);
    if (isActive === false) return null;
    if (isActive !== true) throw new StudioError(502, "invalid_service_response");
  }
  return { id: user.id, ...(typeof user.email === "string" ? { email: user.email } : {}) };
}

export async function requireStudioUser({ allowRefresh = true }: { allowRefresh?: boolean } = {}): Promise<StudioContext> {
  studioConfig();
  const jar = await cookies();
  const accessToken = studioSessionToken(jar, "access");
  if (accessToken) {
    const user = await verifiedUser(accessToken);
    if (user) return { user, accessToken };
  }
  if (!allowRefresh) throw new StudioError(401, "unauthorized");
  const refreshToken = studioSessionToken(jar, "refresh");
  if (!refreshToken) throw new StudioError(401, "unauthorized");
  const response = await studioFetch("/auth/v1/token?grant_type=refresh_token", {
    method: "POST", body: { refresh_token: refreshToken },
  });
  if (!response.ok) {
    if (![400, 401, 403].includes(response.status)) throw new StudioError(502, "service_unavailable");
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

export function studioSessionToken(jar: { get(name: string): { value: string } | undefined }, kind: "access" | "refresh"): string | undefined {
  if (sharedCookieDomain() && (jar.get("hub_access")?.value || jar.get("hub_refresh")?.value)) return jar.get(`hub_${kind}`)?.value;
  return jar.get(`studio_${kind}`)?.value;
}

export async function migrateStudioSession(): Promise<void> {
  if (!sharedCookieDomain()) return;
  const jar = await cookies();
  const access = studioSessionToken(jar, "access");
  const refresh = studioSessionToken(jar, "refresh");
  if (access && refresh) {
    await setStudioSession({ access_token: access, refresh_token: refresh, expires_in: 3600 });
  }
}
