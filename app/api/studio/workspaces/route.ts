import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { createWorkspace, listWorkspaces } from "@/lib/studio/store";
import { validateStudioDocument } from "@/lib/studio/validation";

export async function GET() {
  try {
    const ctx = await requireStudioUser();
    return NextResponse.json({ workspaces: await listWorkspaces(ctx) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const ctx = await requireStudioUser();
    const body = await readJsonBody(request, 2_000_000);
    if (!body || typeof body !== "object" || !("document" in body)) throw new StudioError(400, "invalid_document");
    const document = validateStudioDocument((body as { document: unknown }).document);
    const workspace = await createWorkspace(ctx, document);
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) { return routeError(error); }
}
