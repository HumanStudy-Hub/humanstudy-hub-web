import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { getWorkspace } from "@/lib/studio/store";
import { syncPipeline, retryPipeline, getPipelineJobs, startPackageSync, reconcilePackageApproval } from "@/lib/studio/pipeline";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
export const runtime="nodejs";
export const maxDuration=60;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{assertSameOrigin(request);const ctx=await requireStudioUser();const {id}=await params;
 const body=await readJsonBody(request,1000) as {revision:number;action?:string;lane?:'pipeline'|'discussion';proposalId?:string};const workspace=await getWorkspace(ctx,id);
 if(!workspace)throw new StudioError(404,"not_found");
 if(!body||body.revision!==workspace.revision)throw new StudioError(409,"revision_conflict");
 if(body.action==='retry')return NextResponse.json({workspace:await retryPipeline(ctx,workspace,body.lane==='discussion'?'discussion':'pipeline')});
 if(body.action==='reconcile-approval')return NextResponse.json({workspace:await reconcilePackageApproval(ctx,workspace)});
 if(body.action==='sync-package'){
  if(typeof body.proposalId!=='string')throw new StudioError(400,'invalid_proposal_id');
  const proposal=workspace.document.conversations.flatMap(c=>c.messages).find(m=>m.proposal?.id===body.proposalId)?.proposal;
  if(!proposal||proposal.status!=='applied')throw new StudioError(409,'proposal_not_applied');
  return NextResponse.json({workspace:await startPackageSync(ctx,workspace,body.proposalId)});
 }
 return NextResponse.json(await syncPipeline(ctx,workspace),{headers:{"Cache-Control":"no-store"}});
 }catch(error){return routeError(error);}
}

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 try{const ctx=await requireStudioUser();const {id}=await params;const workspace=await getWorkspace(ctx,id);
 if(!workspace)throw new StudioError(404,'not_found');
 return NextResponse.json(await getPipelineJobs(ctx,workspace),{headers:{'Cache-Control':'no-store'}});
 }catch(error){return routeError(error);}
}
