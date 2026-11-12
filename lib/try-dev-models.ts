import { getVercelOidcToken } from "@vercel/oidc";
import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

const protectedDesktopRoutes = [
  ["/api/desktop/config", "GET"],
  ["/api/desktop/v1/models", "GET"],
  ["/api/desktop/v1/chat/completions", "POST"],
] as const;

export function isDevPreview() {
  return process.env.VERCEL_ENV === "preview" && process.env.VERCEL_GIT_COMMIT_REF === "dev";
}

export function devModelAccess(userId: string) {
  return isDevPreview() && process.env.TRY_DEV_MANAGED_MODELS === "1" && process.env.TRY_DEV_MODEL_USER_ID === userId;
}

export function devHubOrigin() {
  if (!isDevPreview()) return "";
  const host = process.env.VERCEL_BRANCH_URL ?? "";
  const origin = `https://${host}`;
  return /^[a-z0-9-]+\.vercel\.app$/.test(host) && origin === process.env.TRY_DEV_HUB_ORIGIN ? origin : "";
}

export async function devModelNetwork(origin: string, sessionMinutes: number): Promise<NetworkPolicy | null> {
  if (!origin || origin !== devHubOrigin()) return null;
  try {
    const token = await getVercelOidcToken();
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.environment !== "preview" || !Number.isSafeInteger(claims.exp)
      || claims.exp * 1000 <= Date.now() + (sessionMinutes + 1) * 60_000) return null;
    const rules: NetworkPolicyRule[] = protectedDesktopRoutes.map(([path, method]) => ({
      match: { path: { exact: path }, method: [method] },
      transform: [{ headers: { "x-vercel-trusted-oidc-idp-token": token } }],
    }));
    rules.push({ response: { statusCode: 403 } });
    const denyProduction = [{ response: { statusCode: 403 } }];
    return { allow: { [new URL(origin).hostname]: rules, "humanstudy-hub.com": denyProduction, "www.humanstudy-hub.com": denyProduction, "*": [] } };
  } catch {
    return null;
  }
}
