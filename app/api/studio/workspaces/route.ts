import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { createWorkspace, listWorkspaces } from "@/lib/studio/store";
import { validateStudioDocument } from "@/lib/studio/validation";
import { loadSample, sampleId } from '@/lib/studio/projects';
export const runtime='nodejs';
export const maxDuration=60;

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
    if(body && typeof body==='object' && 'sampleId' in body){
      if(body.sampleId!==sampleId)throw new StudioError(400,'invalid_sample');
      return NextResponse.json({workspace:await loadSample(ctx)},{status:201});
    }
    if (!body || typeof body !== "object" || !("document" in body)) throw new StudioError(400, "invalid_document");
    const document = validateStudioDocument((body as { document: unknown }).document);
    // Client-created lineage is not accepted. Scientific history is recorded by the database.
    delete document.programVersions;
    delete document.project;
    delete document.pipeline;delete document.discussion;delete document.acceptedPackage;
    const workspace = await createWorkspace(ctx, document);
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) { return routeError(error); }
}
