import { NextResponse } from "next/server";
import { requireStudioResearchUser as requireStudioUser } from "@/lib/research-data/consent-server";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { getWorkspace } from "@/lib/studio/store";
import { saveWorkspaceResearch } from "@/lib/research-data/server-capture";
import { versionEvents } from "@/lib/research-data/server-producer";
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
    if(existing.document.project?.copyState&&existing.document.project.copyState!=='ready')throw new StudioError(409,'project_copy_pending');
    // Autosave cannot replace server-owned jobs, accepted package, or proposal
    // decisions. Model edits remain allowed and will stale pending proposals.
    validated.project=existing.document.project;
    validated.pipeline=existing.document.pipeline;
    validated.discussion=existing.document.discussion;
    validated.acceptedPackage=existing.document.acceptedPackage;
    validated.programVersions=existing.document.programVersions;
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
    // Committed human edits: one version per saved change of the program, an artifact or the annotation set.
    const result = await saveWorkspaceResearch(ctx, id, validated, expectedRevision as number, (revision, p) => [{
      producer: "workspace.save", key: `save:${id}:${revision}`,
      events: versionEvents(p, { before: existing.document, after: validated, revision, by: "human" }),
    }]);
    if ("conflict" in result) {
      if (!result.latest) throw new StudioError(404, "not_found");
      return NextResponse.json({ error: "revision_conflict", workspace: result.latest }, { status: 409 });
    }
    return NextResponse.json({ workspace: result });
  } catch (error) { return routeError(error); }
}
