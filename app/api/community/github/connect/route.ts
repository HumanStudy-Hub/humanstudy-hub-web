import { NextResponse } from "next/server";
import { fail, requireHubUser } from "@/lib/community-auth";
import { deleteIdentity } from "@/lib/community-store";

export const runtime = "nodejs";

const notConfigured = () => NextResponse.json({ error: "not_configured" }, { status: 503 });

/** Starts GitHub's device flow: the user opens verificationUri and types userCode. */
export async function POST(request: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return notConfigured();
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "public_repo" }),
    cache: "no-store",
  }).catch(() => null);
  const data = (await response?.json().catch(() => null)) as { user_code?: string; verification_uri?: string; device_code?: string; interval?: number; error?: string } | null;
  if (!response?.ok || !data?.device_code || !data.user_code) return fail(502, "github_unavailable", "GitHub did not start the connection. Try again in a minute.");
  return NextResponse.json({ userCode: data.user_code, verificationUri: data.verification_uri ?? "https://github.com/login/device", deviceCode: data.device_code, interval: data.interval ?? 5 });
}

/** Disconnects GitHub: later publishes go through the Hub bot again. */
export async function DELETE(request: Request) {
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  try {
    await deleteIdentity(user.id);
    return NextResponse.json({ ok: true });
  } catch {
    return fail(503, "database_unavailable", "Could not disconnect GitHub. Try again in a minute.");
  }
}
