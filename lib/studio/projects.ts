import fs from 'node:fs/promises';
import path from 'node:path';
import type { StudioContext } from './auth';
import type { StudioSource,StudioWorkspace } from './types';
import { studioConfig,studioFetch,StudioError } from './http';
import { getWorkspace,createWorkspace,saveWorkspace } from './store';
import { sourceSpec,sourceStoragePath,validStoredSource } from './resources';
import { validateStudioDocument,validateStudyModel } from './validation';
import { forkDocument,sourceCopyPairs } from './project-copy';

export const sampleId='intentional-action';
const sampleFiles=['KNOBE.pdf','experiment_1_help.json','experiment_1_harm.json','experiment_2_help.json','experiment_2_harm.json'];
const sampleDirectory=path.join(process.cwd(),'data/studio-samples/intentional-action');
const MAX_COPY_BYTES=50*1024*1024;
const encodePath=(value:string)=>value.split('/').map(encodeURIComponent).join('/');

async function uploadSeed(ctx:StudioContext,source:StudioSource) {
 if(!sampleFiles.includes(source.name))throw new StudioError(400,'invalid_sample');
 const bytes=await fs.readFile(path.join(sampleDirectory,source.name));
 if(bytes.length!==source.size)throw new StudioError(409,'sample_changed');
 const {url,key}=studioConfig();
 const response=await fetch(`${url}/storage/v1/object/studio-sources/${encodePath(source.path)}`,{
  method:'POST',headers:{apikey:key,Authorization:`Bearer ${ctx.accessToken}`,'Content-Type':source.mimeType},
  body:new Blob([bytes],{type:source.mimeType}),signal:AbortSignal.timeout(20_000),
 });
 if(!response.ok){const error=await response.json().catch(()=>({}));if(error.error!=='Duplicate')throw new StudioError(502,'project_copy_failed');}
}

async function finishCopy(ctx:StudioContext,workspace:StudioWorkspace):Promise<StudioWorkspace> {
 try {
  if(workspace.document.project?.sampleId===sampleId) {
   for(const source of workspace.document.sources)await uploadSeed(ctx,source);
  } else {
   const from=workspace.document.project?.forkedFrom;
   const original=from&&await getWorkspace(ctx,from.workspaceId);
   if(!original)throw new StudioError(404,'not_found');
   for(const {source,destination} of sourceCopyPairs(original.document.sources,workspace.document.sources)) {
    if(!validStoredSource(source,ctx.user.id,original.id)||!validStoredSource(destination,ctx.user.id,workspace.id))throw new StudioError(400,'invalid_sources');
    const response=await studioFetch('/storage/v1/object/copy',{method:'POST',token:ctx.accessToken,body:{bucketId:'studio-sources',sourceKey:source.path,destinationKey:destination.path}});
    if(!response.ok){const error=await response.json().catch(()=>({}));if(error.error!=='Duplicate')throw new StudioError(502,'project_copy_failed');}
   }
  }
  const result=await saveWorkspace(ctx,workspace.id,{...workspace.document,project:{...workspace.document.project,copyState:'ready'}},workspace.revision);
  if('conflict' in result)throw new StudioError(409,'revision_conflict');
  return result;
 }catch{
  await saveWorkspace(ctx,workspace.id,{...workspace.document,project:{...workspace.document.project,copyState:'failed'}},workspace.revision).catch(()=>undefined);
  throw new StudioError(502,'project_copy_failed',`The project was saved, but its files could not finish copying. Retry from Projects. Project: ${workspace.id}`);
 }
}

export async function loadSample(ctx:StudioContext):Promise<StudioWorkspace> {
 const id=crypto.randomUUID();
 const sources:StudioSource[]=await Promise.all(sampleFiles.map(async name=>{
  const spec=sourceSpec(name)!;const sourceId=crypto.randomUUID();const size=(await fs.stat(path.join(sampleDirectory,name))).size;
  return {id:sourceId,name,path:sourceStoragePath(ctx.user.id,id,sourceId,spec.extension),mimeType:spec.mimeType,size,kind:spec.kind};
 }));
 const program=JSON.parse(await fs.readFile(path.join(sampleDirectory,'program.json'),'utf8'));
 program.evidence=program.evidence.map((e: {path?:string;sourceId?:string})=>({...e,sourceId:sources.find(source=>source.name===e.path)?.id}));
 const model=validateStudyModel(program,{sources});
 const artifacts=await Promise.all(sources.slice(1).map(async source=>({id:crypto.randomUUID(),title:source.name.replace(/\.json$/,'').replaceAll('_',' '),filename:source.name,kind:'instrument' as const,format:'json' as const,sourceIds:[source.id],content:await fs.readFile(path.join(sampleDirectory,source.name),'utf8')})));
 const document=validateStudioDocument({version:1,title:program.title,model,sources,artifacts,annotations:[],conversations:[],reviewResponses:{},project:{sampleId,copyState:'preparing'}});
 return finishCopy(ctx,await createWorkspace(ctx,document,id));
}

export async function forkWorkspace(ctx:StudioContext,original:StudioWorkspace):Promise<StudioWorkspace> {
 if(original.document.project?.copyState&&original.document.project.copyState!=='ready')throw new StudioError(409,'project_copy_pending');
 if(original.document.sources.reduce((n,s)=>n+s.size,0)>MAX_COPY_BYTES)throw new StudioError(413,'project_copy_too_large');
 const id=crypto.randomUUID();
 const document=validateStudioDocument(forkDocument(original.document,ctx.user.id,id,{workspaceId:original.id,revision:original.revision}));
 return finishCopy(ctx,await createWorkspace(ctx,document,id));
}

export async function retryProjectCopy(ctx:StudioContext,workspace:StudioWorkspace) {
 const state=workspace.document.project?.copyState;
 if(state!=='failed'&&!(state==='preparing'&&Date.now()-Date.parse(workspace.updated_at)>120_000))throw new StudioError(409,'project_copy_pending');
 const locked=await saveWorkspace(ctx,workspace.id,{...workspace.document,project:{...workspace.document.project,copyState:'preparing'}},workspace.revision);
 if('conflict' in locked)throw new StudioError(409,'revision_conflict');
 return finishCopy(ctx,locked);
}
