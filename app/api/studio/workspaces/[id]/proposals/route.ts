import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, isUuid, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { getWorkspace, saveWorkspace } from "@/lib/studio/store";
import { validateStudioDocument } from "@/lib/studio/validation";
import { modelFingerprint } from "@/lib/studio/model-version";
import { reconcilePackageApproval, startPackageSync } from "@/lib/studio/pipeline";
import { readOwnedStudioJob } from "@/lib/github-jobs";
import { acceptedProgramVersions } from "@/lib/studio/program-versions";

export const runtime = "nodejs";
export const maxDuration = 60;
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
    const proposal = document.conversations.flatMap(conversation => conversation.messages.map(message => message.proposal).filter(Boolean)).find(item => item?.id === body.proposalId);
    if (!proposal) throw new StudioError(404, "proposal_not_found");
    if (proposal.status !== "pending") throw new StudioError(409, "proposal_already_decided");
    // A draft or chat autosave may advance the workspace revision; only a changed
    // authoritative model makes the proposal stale.
    if(body.decision==='apply'&&proposal.baseModelFingerprint&&proposal.baseModelFingerprint!==modelFingerprint(document.model))throw new StudioError(409,'proposal_stale_model','The model changed since this proposal was made. Ask the agent to revise it.');
    const status = body.decision === "apply" ? "applied" as const : "rejected" as const;
    const nextModel = status === "applied" && proposal.changesModel !== false ? proposal.model : document.model;
    const nextArtifacts = status === "applied" ? proposal.artifacts ?? document.artifacts : document.artifacts;
    const programVersions=status==='applied'?acceptedProgramVersions(document,proposal.id,new Date().toISOString()):document.programVersions;
    const initialJobId=status==='applied'&&document.pipeline?.kind!=='sync'&&document.pipeline?.proposalId===proposal.id&&document.pipeline.jobId===(proposal.jobId||document.pipeline.jobId)?document.pipeline.jobId:undefined;
    let initialJobStatus:'review'|'complete'|undefined;
    if(initialJobId){
      const job=await readOwnedStudioJob(initialJobId,{ownerId:ctx.user.id,workspaceId:id});
      if(!job.packageReady||!['review','complete'].includes(job.status))throw new StudioError(409,'package_not_ready');
      initialJobStatus=job.status as 'review'|'complete';
    }
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
    // Live annotation links still block deletion. Historical message/proposal
    // snapshots keep their original references and need no rewrite.
    let updated;
    try { updated = validateStudioDocument({ ...document, programVersions, model: nextModel, ...(nextArtifacts !== undefined ? { artifacts: nextArtifacts } : {}), conversations,...(initialJobId?{acceptedPackage:{jobId:initialJobId,modelFingerprint:modelFingerprint(nextModel),acceptedAt:new Date().toISOString(),...(initialJobStatus==='review'?{approvalPending:true}:{})},pipeline:{...document.pipeline!,status:'complete',message:'Study package accepted',updatedAt:new Date().toISOString()}}:{}) }); }
    catch { throw new StudioError(409, "proposal_breaks_references", "This model would break live annotation references. Reassign those annotations first."); }
    const saved = await saveWorkspace(ctx, id, updated, body.revision as number);
    if ("conflict" in saved) return NextResponse.json({ error: "revision_conflict", latest: saved.latest }, { status: 409 });
    // Save the authoritative model before any remote work. A sync failure leaves
    // an applied proposal and an explicit retry path, never a half-approved job.
    let result=saved;
    if(status==='applied'){
      try{result=initialJobId?await reconcilePackageApproval(ctx,saved):await startPackageSync(ctx,saved,proposal.id);}
      catch{return NextResponse.json({workspace:saved,proposalId:body.proposalId,status,packageSync:'retry_required'});}
    }
    return NextResponse.json({ workspace: result, proposalId: body.proposalId, status });
  } catch (error) { return routeError(error); }
}
