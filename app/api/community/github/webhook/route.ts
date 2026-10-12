import { NextResponse } from "next/server";
import { statusChangeFor, verifyGithubSignature } from "@/lib/community-webhook";
import { storeConfigured, updateStatus } from "@/lib/community-store";

export const runtime = "nodejs";

/** GitHub webhook on the community repository. Does nothing (200) until COMMUNITY_WEBHOOK_SECRET is set. */
export async function POST(request: Request) {
  const secret = process.env.COMMUNITY_WEBHOOK_SECRET;
  if (!secret || !storeConfigured()) return NextResponse.json({ ok: true, ignored: "not_configured" });
  const raw = await request.text();
  if (!verifyGithubSignature(secret, raw, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "bad_signature", message: "Signature check failed." }, { status: 401 });
  }
  const event = request.headers.get("x-github-event") || "";
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_payload", message: "Body is not JSON." }, { status: 400 });
  }
  const change = statusChangeFor(event, payload);
  if (!change) return NextResponse.json({ ok: true, ignored: event });
  try {
    const updated = await updateStatus(change.match, { status: change.status, error: change.error });
    return NextResponse.json({ ok: true, updated });
  } catch {
    return NextResponse.json({ error: "database_unavailable", message: "Could not record the change." }, { status: 503 });
  }
}
