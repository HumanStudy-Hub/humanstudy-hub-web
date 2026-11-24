import { NextResponse } from "next/server";
import { bearer, DESKTOP_DEFAULT_MODEL, DESKTOP_MODELS, verifyDesktopKey } from "@/lib/desktop-access";
import { planModels, usagePlansEnabled } from "@/lib/plans";
import { getAllowance } from "@/lib/usage-store";

export const runtime = "nodejs";

/** OpenAI-compatible model list for the desktop key: the account's plan's models when plans are on. */
export async function GET(request: Request) {
  const userId = verifyDesktopKey(bearer(request));
  if (!userId) return NextResponse.json({ error: { message: "Invalid or expired desktop key", type: "invalid_api_key" } }, { status: 401 });
  let ids = DESKTOP_MODELS;
  if (usagePlansEnabled()) {
    const allowance = await getAllowance(userId).catch(() => null);
    if (allowance) ids = planModels(allowance.plan, DESKTOP_MODELS, DESKTOP_DEFAULT_MODEL).models;
  }
  return NextResponse.json({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "humanstudy-hub" })) }, { headers: { "Cache-Control": "no-store" } });
}
