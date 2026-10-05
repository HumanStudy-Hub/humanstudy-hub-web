import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { getWorkspace, saveWorkspace } from "@/lib/studio/store";
import { validateStudioDocument } from "@/lib/studio/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireStudioUser();
    const { id } = await context.params;
    const workspace = await getWorkspace(ctx, id);
    if (!workspace) throw new StudioError(404, "not_found");
    return NextResponse.json({ workspace }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const ctx = await requireStudioUser();
    const { id } = await context.params;
    const body = await readJsonBody(request, 2_000_000);
    if (!body || typeof body !== "object") throw new StudioError(400, "invalid_request");
    const { document, expectedRevision } = body as Record<string, unknown>;
    const validated = validateStudioDocument(document);
    const result = await saveWorkspace(ctx, id, validated, expectedRevision as number);
    if ("conflict" in result) {
      if (!result.latest) throw new StudioError(404, "not_found");
      return NextResponse.json({ error: "revision_conflict", workspace: result.latest }, { status: 409 });
    }
    return NextResponse.json({ workspace: result });
  } catch (error) { return routeError(error); }
}
