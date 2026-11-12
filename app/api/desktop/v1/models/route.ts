import { hostedQuotaEnvironment, hostedModelsForAccount } from "@/lib/hosted-model-quota";
import { BOUNDED_HOSTED_MODELS } from "@/lib/try-dev-model-budget";
import { NextResponse } from "next/server";
import { bearer, DESKTOP_MODELS, verifyDesktopKey } from "@/lib/desktop-access";

export const runtime = "nodejs";

/** OpenAI-compatible model list for the desktop key. */
export async function GET(request: Request) {
  const userId = verifyDesktopKey(bearer(request));
  if (!userId) return NextResponse.json({ error: { message: "Invalid or expired desktop key", type: "invalid_api_key" } }, { status: 401 });
  let models = DESKTOP_MODELS;
  if (hostedQuotaEnvironment()) {
    const allowed = await hostedModelsForAccount(userId);
    models = models.filter(model => BOUNDED_HOSTED_MODELS.includes(model) && allowed.includes(model));
  }
  return NextResponse.json({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "humanstudy-hub" })) }, { headers: { "Cache-Control": "no-store" } });
}
