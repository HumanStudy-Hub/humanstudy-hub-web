import { NextResponse } from "next/server";
import { encryptToken } from "@/lib/community";
import { fail, requireHubUser } from "@/lib/community-auth";
import { saveIdentity } from "@/lib/community-store";

export const runtime = "nodejs";

/** One poll of the device flow. Returns {status:'pending'} until the user approves on github.com. */
export async function POST(request: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  const body = (await request.json().catch(() => ({}))) as { deviceCode?: unknown };
  if (typeof body.deviceCode !== "string" || !body.deviceCode) return fail(400, "bad_request", "Start the GitHub connection first.");

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, device_code: body.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    cache: "no-store",
  }).catch(() => null);
  const data = (await response?.json().catch(() => null)) as { access_token?: string; scope?: string; error?: string; interval?: number } | null;
  if (!data) return fail(502, "github_unavailable", "GitHub did not answer. Try again in a moment.");
  if (data.error === "authorization_pending") return NextResponse.json({ status: "pending" });
  if (data.error === "slow_down") return NextResponse.json({ status: "pending", interval: data.interval ?? 10 });
  if (data.error === "expired_token") return fail(410, "expired", "The code expired. Start the GitHub connection again.");
  if (data.error === "access_denied") return fail(403, "denied", "GitHub access was declined.");
  if (!data.access_token) return fail(502, "github_unavailable", "GitHub did not complete the connection. Start again.");

  const profile = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${data.access_token}`, Accept: "application/vnd.github+json" }, cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ login?: string }>) : null))
    .catch(() => null);
  if (!profile?.login) return fail(502, "github_unavailable", "Could not read your GitHub account name. Start again.");
  try {
    await saveIdentity({ owner_id: user.id, login: profile.login, token_encrypted: encryptToken(data.access_token), scopes: data.scope ?? "" });
  } catch {
    return fail(503, "database_unavailable", "Could not save the GitHub connection. Try again in a minute.");
  }
  return NextResponse.json({ status: "connected", login: profile.login });
}
