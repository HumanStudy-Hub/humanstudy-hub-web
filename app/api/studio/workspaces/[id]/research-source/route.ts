import { NextResponse } from 'next/server';
import { requireStudioResearchUser } from '@/lib/research-data/consent-server';
import { archiveSource } from '@/lib/research-data/archive-source';
import { assertSameOrigin, isUuid, readJsonBody, routeError, StudioError } from '@/lib/studio/http';
import { getWorkspace } from '@/lib/studio/store';
import { validStoredSource } from '@/lib/studio/resources';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request: Request, context: {params: Promise<{id:string}>}) {
  try {
    assertSameOrigin(request);
    if(process.env.RESEARCH_COLLECTION_V1_ENABLED!=='1')throw new StudioError(503,'research_collection_not_enabled');
    const ctx=await requireStudioResearchUser(),{id}=await context.params;
    const body=await readJsonBody(request,1024) as {sourceId?:string;actionId?:string};
    const workspace=await getWorkspace(ctx,id),source=workspace?.document.sources.find(s=>s.id===body?.sourceId);
    if(!source||!validStoredSource(source,ctx.user.id,id))throw new StudioError(404,'not_found');
    return NextResponse.json(await archiveSource(ctx,id,source,isUuid(body?.actionId)?body.actionId:undefined),{headers:{'Cache-Control':'no-store'}});
  }catch(e){return routeError(e);}
}
