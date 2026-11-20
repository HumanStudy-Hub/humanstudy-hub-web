import { NextResponse } from "next/server";
import { bearer, verifyDesktopKey } from "@/lib/desktop-access";
import { accountAllowance } from "@/lib/model-allowance";
import { requireStudioUser } from "@/lib/studio/auth";
import { StudioError } from "@/lib/studio/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** Hosted model allowance left for the signed-in account: desktop key bearer or web session. Percent only, no dollar amounts. */
export async function GET(request: Request) {
  const key = bearer(request);
  let userId: string | null = null;
  if (key) userId = verifyDesktopKey(key);
  else {
    try { userId = (await requireStudioUser()).user.id; } catch (error) {
      if (!(error instanceof StudioError) || error.status !== 401) return NextResponse.json({ error: "service_unavailable" }, { status: 503, headers });
    }
  }
  if (!userId) return NextResponse.json({ error: "not_signed_in" }, { status: 401, headers });
  return NextResponse.json(await accountAllowance(userId), { headers });
}
