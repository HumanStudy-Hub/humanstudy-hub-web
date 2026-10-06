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
    const existing = await getWorkspace(ctx,id);
    if(!existing)throw new StudioError(404,"not_found");
    // Autosave cannot replace server-owned jobs, accepted package, or proposal
    // decisions. Model edits remain allowed and will stale pending proposals.
    validated.pipeline=existing.document.pipeline;
    validated.discussion=existing.document.discussion;
    validated.acceptedPackage=existing.document.acceptedPackage;
    const authoritative=new Map(existing.document.conversations.map(c=>[c.id,c] as const));
    validated.conversations=validated.conversations.map(c=>{
      const saved=authoritative.get(c.id);authoritative.delete(c.id);
      if(!saved)return {...c,messages:c.messages.map(m=>({...m,proposal:undefined}))};
      const messages=new Map(saved.messages.map(m=>[m.id,m] as const));
      const incoming=c.messages.map(m=>{
        const original=messages.get(m.id);messages.delete(m.id);
        return original?.proposal?{...m,proposal:original.proposal}:{...m,proposal:undefined};
      });
      return {...c,messages:[...incoming,...messages.values()]};
    });
    validated.conversations.push(...authoritative.values());
    const result = await saveWorkspace(ctx, id, validated, expectedRevision as number);
    if ("conflict" in result) {
      if (!result.latest) throw new StudioError(404, "not_found");
      return NextResponse.json({ error: "revision_conflict", workspace: result.latest }, { status: 409 });
    }
    return NextResponse.json({ workspace: result });
  } catch (error) { return routeError(error); }
}
