import { NextResponse } from 'next/server';
import { requireStudioUser } from '@/lib/studio/auth';
import { assertSameOrigin,readJsonBody,routeError,StudioError } from '@/lib/studio/http';
import { getWorkspace,saveWorkspace } from '@/lib/studio/store';
import { forkWorkspace,retryProjectCopy } from '@/lib/studio/projects';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
 try {
  assertSameOrigin(request);const ctx=await requireStudioUser();const {id}=await params;
  const body=await readJsonBody(request,4000) as Record<string,unknown>;
  if(!body||!['fork','rename','archive','restore','retry-copy'].includes(body.action as string))throw new StudioError(400,'invalid_request');
  const workspace=await getWorkspace(ctx,id);if(!workspace)throw new StudioError(404,'not_found');
  if(body.revision!==workspace.revision)throw new StudioError(409,'revision_conflict');
  if(body.action==='fork')return NextResponse.json({workspace:await forkWorkspace(ctx,workspace)},{status:201});
  if(body.action==='retry-copy')return NextResponse.json({workspace:await retryProjectCopy(ctx,workspace)});
  if(workspace.document.project?.copyState==='preparing')throw new StudioError(409,'project_copy_pending');
  const document=structuredClone(workspace.document);
  if(body.action==='rename'){
   if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>160)throw new StudioError(400,'invalid_title');
   document.title=body.title.trim();
  }else document.project={...document.project,archived:body.action==='archive'};
  const saved=await saveWorkspace(ctx,id,document,workspace.revision);if('conflict' in saved)throw new StudioError(409,'revision_conflict');
  return NextResponse.json({workspace:saved});
 }catch(error){return routeError(error);}
}
