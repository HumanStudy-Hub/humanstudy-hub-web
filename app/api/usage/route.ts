import { NextResponse } from "next/server";
import { bearer, verifyDesktopKey } from "@/lib/desktop-access";
import { exhaustedMessage, usageLine, usagePlansEnabled } from "@/lib/plans";
import { requireStudioUser } from "@/lib/studio/auth";
import { StudioError } from "@/lib/studio/http";
import { getAllowance } from "@/lib/usage-store";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store" };

/**
 * This month's hosted-model usage for the caller: plan, used, limit, remaining and renewal date.
 * Signed in with the website session, or with a desktop key (`Authorization: Bearer hsd_v1...`).
 * `enabled: false` while usage plans are off (USAGE_PLANS_ENABLED unset).
 */
export async function GET(request: Request) {
  if (!usagePlansEnabled()) return NextResponse.json({ enabled: false }, { headers: noStore });
  let userId = verifyDesktopKey(bearer(request));
  if (!userId) {
    try {
      userId = (await requireStudioUser()).user.id;
    } catch (error) {
      if (error instanceof StudioError && error.status === 401) return NextResponse.json({ error: "not_signed_in" }, { status: 401, headers: noStore });
      return NextResponse.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
    }
  }
  try {
    const usage = await getAllowance(userId);
    return NextResponse.json(
      {
        enabled: true,
        ...usage,
        line: usageLine(usage),
        line_zh: usageLine(usage, "zh"),
        ...(usage.exhausted ? { message: exhaustedMessage(usage), message_zh: exhaustedMessage(usage, "zh") } : {}),
      },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json({ error: "usage_unavailable", message: "Usage accounting is unavailable right now." }, { status: 503, headers: noStore });
  }
}
