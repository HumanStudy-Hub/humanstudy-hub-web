import { ownedPipeline } from "@/lib/studio/pipeline";
import { approveStage } from "@/lib/github-jobs";
import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, isUuid, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { getWorkspace, saveWorkspace } from "@/lib/studio/store";
import { validateStudioDocument } from "@/lib/studio/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const ctx = await requireStudioUser();
    const { id } = await params;
    const body = await readJsonBody(request, 16_000) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body) || !isUuid(body.proposalId) || !["apply", "reject"].includes(body.decision as string)) throw new StudioError(400, "invalid_decision");
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) throw new StudioError(400, "invalid_revision");
    const workspace = await getWorkspace(ctx, id);
    if (!workspace) throw new StudioError(404, "not_found");
    if (workspace.revision !== body.revision) return NextResponse.json({ error: "revision_conflict", latest: workspace }, { status: 409 });
    const document = validateStudioDocument(workspace.document);
    const proposals = document.conversations.flatMap(conversation => conversation.messages.map(message => message.proposal).filter(Boolean));
    const proposal = proposals.find(item => item?.id === body.proposalId);
    if (!proposal) throw new StudioError(404, "proposal_not_found");
    if (proposal.status !== "pending") throw new StudioError(409, "proposal_already_decided");
    const status = body.decision === "apply" ? "applied" as const : "rejected" as const;
    const nextModel = status === "applied" && proposal.changesModel !== false ? proposal.model : document.model;
    const nextArtifacts = status === "applied" ? proposal.artifacts ?? document.artifacts : document.artifacts;
    const firstEntity = nextModel.entities[0]?.id || "";
    const liveIds = new Set(nextModel.entities.map(entity => entity.id));
    const conversations = document.conversations.map(conversation => ({
      ...conversation,
      selected: status === "applied" && !liveIds.has(conversation.selected) ? firstEntity : conversation.selected,
      modelAnchor: status === "applied" && conversation.modelAnchor && !conversation.modelAnchor.entityIds.every(entityId => liveIds.has(entityId)) ? null : conversation.modelAnchor,
      messages: conversation.messages.map(message => message.proposal?.id === body.proposalId
        ? { ...message, proposal: { ...message.proposal, status } }
        : message),
    }));
    // Live annotation links still block deletion. Historical messages and proposal
    // snapshots retain their original references, while live focus is reset safely.
    let updated;
    try { updated = validateStudioDocument({ ...document, model: nextModel, ...(nextArtifacts !== undefined ? { artifacts: nextArtifacts } : {}), conversations }); }
    catch { throw new StudioError(409, "proposal_breaks_references"); }
    if(document.pipeline?.proposalId===proposal.id){
      const job=await ownedPipeline(ctx,workspace);
      if(body.decision==='apply'){if(job.status==='review')await approveStage(job.id,{decision:'approved'},{ownerId:ctx.user.id,workspaceId:id});updated.pipeline={...document.pipeline,status:'complete',message:'Study package approved',updatedAt:new Date().toISOString()};}
      if(body.decision==='reject'&&job.status==='review')await approveStage(job.id,{decision:'changes_requested',note:'Researcher rejected the proposed package in the study workspace.'},{ownerId:ctx.user.id,workspaceId:id});
    }
    const saved = await saveWorkspace(ctx, id, updated, body.revision as number);
    if ("conflict" in saved) return NextResponse.json({ error: "revision_conflict", latest: saved.latest }, { status: 409 });
    return NextResponse.json({ workspace: saved, proposalId: body.proposalId, status });
  } catch (error) { return routeError(error); }
}
