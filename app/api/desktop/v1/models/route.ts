import { NextResponse } from "next/server";
import { bearer, DESKTOP_MODELS, verifyDesktopKey } from "@/lib/desktop-access";

export const runtime = "nodejs";

/** OpenAI-compatible model list for the desktop key. */
export async function GET(request: Request) {
  if (!verifyDesktopKey(bearer(request))) return NextResponse.json({ error: { message: "Invalid or expired desktop key", type: "invalid_api_key" } }, { status: 401 });
  return NextResponse.json({ object: "list", data: DESKTOP_MODELS.map((id) => ({ id, object: "model", owned_by: "humanstudy-hub" })) });
}
