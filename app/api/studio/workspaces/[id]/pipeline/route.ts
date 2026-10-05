import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { getWorkspace } from "@/lib/studio/store";
import { syncPipeline, retryPipeline } from "@/lib/studio/pipeline";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
export const runtime="nodejs";
export const maxDuration=60;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{assertSameOrigin(request);const ctx=await requireStudioUser();const {id}=await params;
 const body=await readJsonBody(request,1000) as {revision:number;action?:string};const workspace=await getWorkspace(ctx,id);
 if(!workspace)throw new StudioError(404,"not_found");
 if(!body||body.revision!==workspace.revision)throw new StudioError(409,"revision_conflict");
 if(body.action==='retry')return NextResponse.json({workspace:await retryPipeline(ctx,workspace)});
 return NextResponse.json(await syncPipeline(ctx,workspace),{headers:{"Cache-Control":"no-store"}});
 }catch(error){return routeError(error);}
}

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 try{const ctx=await requireStudioUser();const {id}=await params;const workspace=await getWorkspace(ctx,id);
 if(!workspace)throw new StudioError(404,'not_found');
 const {ownedPipeline}=await import('@/lib/studio/pipeline');
 const job=await ownedPipeline(ctx,workspace);
 return NextResponse.json({job:{id:job.id,status:job.status,message:job.message,progress:job.progress,packageReady:job.packageReady}},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return routeError(error);}
}
