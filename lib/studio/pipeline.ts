import { createStudioPipelineJob, dispatchStudioPipelineJob, listPackageFiles, readOwnedStudioJob, retryStudioPipelineJob, studioPipelineConfigured, type StudioPipelineJob } from '@/lib/github-jobs';
import type { StudioContext } from './auth';
import type { StudioDocument, StudioMessage, StudioPipeline, StudioWorkspace, SourceSelection } from './types';
import type { ModelAnchor } from '@/app/build-preview/model-review';
import { studioConfig, studioFetch, upstreamJson, StudioError } from './http';
import { saveWorkspace } from './store';
import { adaptPipelinePackage } from './pipeline-adapter';
import { validateStudioDocument } from './validation';

const identity = (ctx:StudioContext,w:StudioWorkspace) => ({ownerId:ctx.user.id,workspaceId:w.id});
export async function ownedPipeline(ctx:StudioContext,w:StudioWorkspace) {
  if(!w.document.pipeline)throw new StudioError(404,'pipeline_not_found');
  try{return await readOwnedStudioJob(w.document.pipeline.jobId,identity(ctx,w));}
  catch{throw new StudioError(404,'pipeline_not_found');}
}
async function save(ctx:StudioContext,w:StudioWorkspace,document:StudioDocument){
 const result=await saveWorkspace(ctx,w.id,validateStudioDocument(document),w.revision);
 if('conflict' in result)throw new StudioError(409,'revision_conflict');
 return result;
}
async function signedPaper(ctx:StudioContext,w:StudioWorkspace,sourceId:string){
 const source=w.document.sources.find(s=>s.id===sourceId);
 if(!source||source.path!==`${ctx.user.id}/${w.id}/${source.id}.pdf`)throw new StudioError(403,'invalid_source');
 const path=source.path.split('/').map(encodeURIComponent).join('/');
 const signed=await upstreamJson<{signedURL?:string;signedUrl?:string}>(await studioFetch(`/storage/v1/object/sign/studio-sources/${path}`,{method:'POST',token:ctx.accessToken,body:{expiresIn:86400}}));
 const raw=signed.signedURL||signed.signedUrl;
 if(!raw)throw new StudioError(502,'invalid_service_response');
 const url=studioConfig().url;
 const signedUrl=new URL(raw.startsWith('/object/')?`${url}/storage/v1${raw}`:raw,`${url}/storage/v1/`);
 if(signedUrl.origin!==url||signedUrl.pathname!==`/storage/v1/object/sign/studio-sources/${path}`)throw new StudioError(502,'invalid_service_response');
 const paperUrl=signedUrl.href;
 return paperUrl;
}
export async function startPipeline(ctx:StudioContext,w:StudioWorkspace,input:{sourceId?:string;conversationId:string;requestId:string;text:string;modelAnchor:ModelAnchor|null;sourceSelection:SourceSelection|null}) {
 if(!studioPipelineConfigured())throw new StudioError(503,'pipeline_setup_required','Configure the original GitHub pipeline token and STUDIO_PIPELINE_REF.');
 const document=validateStudioDocument(w.document), previous=document.pipeline;
 if(document.conversations.some(c=>c.messages.some(m=>m.id===input.requestId)))return w;
 if(previous&&['preparing','queued','running'].includes(previous.status))throw new StudioError(409,'pipeline_busy','The study-building agent is still working. Your draft can be sent when it finishes.');
 const source=document.sources.find(s=>s.id===(input.sourceId||input.sourceSelection?.sourceId||previous?.sourceId))||document.sources[0];
 if(!source)throw new StudioError(400,'paper_required','Upload a PDF before asking the study-building agent.');
 if(source.path!==`${ctx.user.id}/${w.id}/${source.id}.pdf`)throw new StudioError(403,'invalid_source');
 const paperUrl=await signedPaper(ctx,w,source.id);
 const now=new Date().toISOString(),jobId=`studio-${w.id}-${input.requestId}`;
 const state:StudioPipeline={jobId,requestId:input.requestId,conversationId:input.conversationId,sourceId:source.id,status:'preparing',message:'Preparing the original study-building agent',updatedAt:now};
 const userMessage:StudioMessage={id:input.requestId,role:'user',text:input.text,createdAt:now,...(input.modelAnchor?{modelAnchor:input.modelAnchor}:{}),...(input.sourceSelection?{sourceSelection:input.sourceSelection}:{})};
 const existing=document.conversations.find(c=>c.id===input.conversationId);
 const conversation=existing?{...existing,draft:'',messages:[...existing.messages,userMessage],updatedAt:now}:{id:input.conversationId,title:input.text.slice(0,80),messages:[userMessage],updatedAt:now,draft:'',modelAnchor:input.modelAnchor,sourceSelection:input.sourceSelection,selected:input.modelAnchor?.entityIds[0]||document.model.entities[0]?.id||''};
 // Reserve by revision before any remote side effect: simultaneous sends cannot
 // launch two agents. A failed preparation is shown explicitly and is retryable.
 let current=await save(ctx,w,{...document,pipeline:state,activeConversationId:input.conversationId,conversations:[...document.conversations.filter(c=>c.id!==input.conversationId),conversation]});
 try {
  const reusable=previous&&['review','complete'].includes(previous.status)&&previous.sourceId===source.id;
  const job=await createStudioPipelineJob({id:jobId,identity:{...identity(ctx,w),requestId:input.requestId,conversationId:input.conversationId},paperName:source.name,paperUrl,previousJobId:reusable?previous?.jobId:undefined,request:{version:1,...identity(ctx,w),conversationId:input.conversationId,requestId:input.requestId,message:input.text,document,modelAnchor:input.modelAnchor,sourceSelection:input.sourceSelection}});
  await dispatchStudioPipelineJob(job);
  current=await save(ctx,current,{...current.document,pipeline:{...state,status:'queued',message:job.message,updatedAt:new Date().toISOString()}});
 }catch(error){
  // If dispatch succeeded but the final CAS failed, don't claim that the agent
  // failed: polling the trusted GitHub job will recover its actual status.
  if(error instanceof StudioError&&error.code==='revision_conflict')throw error;
  current=await save(ctx,current,{...current.document,pipeline:{...state,status:'failed',message:'Could not start the study-building agent. Check GitHub access and workflow configuration, then send again.',updatedAt:new Date().toISOString()}});
 }
 return current;
}
export async function syncPipeline(ctx:StudioContext,w:StudioWorkspace) {
 const state=w.document.pipeline;
 if(!state)return {workspace:w,job:null};
 let job:StudioPipelineJob;
 try{job=await ownedPipeline(ctx,w);}catch(error){
  if(state.status==='failed')return {workspace:w,job:null};
  throw error;
 }
 let document=validateStudioDocument(w.document);
 const pipeline:StudioPipeline={...state,status:job.status,message:job.message.slice(0,4000),updatedAt:job.updatedAt};
 if((job.status==='review'||job.status==='complete')&&!state.proposalId){
  const files=(await listPackageFiles(job.id,identity(ctx,w))).filter(f=>/\.(json|md|txt|csv|py|r)$/i.test(f.path));
  if(files.reduce((n,f)=>n+f.content.length,0)>10*1024*1024)throw new StudioError(413,'package_preview_too_large');
  const adapted=adaptPipelinePackage(files.map(f=>({path:f.path,content:f.content.toString('utf8')})),document);
  const proposalId=crypto.randomUUID();
  const reply=files.find(f=>f.path.endsWith('studio-reply.md'))?.content.toString('utf8').slice(0,12000);
  const message:StudioMessage={id:crypto.randomUUID(),role:'agent',createdAt:new Date().toISOString(),text:[reply||'The study-building agent finished the package.',adapted.summary].join('\n\n').slice(0,20000),proposal:{id:proposalId,model:adapted.model,changesModel:true,artifacts:adapted.artifacts,summary:adapted.summary.slice(0,4000),status:'pending'}};
  if(!document.conversations.some(c=>c.id===state.conversationId))throw new StudioError(409,'pipeline_conversation_missing');
  document={...document,conversations:document.conversations.map(c=>c.id===state.conversationId?{...c,messages:[...c.messages,message]}:c)};
  pipeline.proposalId=proposalId;
 }
 document={...document,pipeline};
 const changed=JSON.stringify(w.document.pipeline)!==JSON.stringify(pipeline)||pipeline.proposalId!==state.proposalId;
 const workspace=changed?await save(ctx,w,document):w;
 // Never expose signed paper links, identity metadata or raw logs to the UI.
 return {workspace,job:{id:job.id,status:job.status,message:job.message,progress:job.progress,packageReady:job.packageReady}};
}

export async function retryPipeline(ctx:StudioContext,w:StudioWorkspace){
 const state=w.document.pipeline;
 if(!state)throw new StudioError(404,'pipeline_not_found');
 const age=Date.now()-Date.parse(state.updatedAt);
 try{
  const job=await readOwnedStudioJob(state.jobId,identity(ctx,w));
  if(job.status==='review'||job.status==='complete')return (await syncPipeline(ctx,w)).workspace;
  const remoteAge=Date.now()-Date.parse(job.updatedAt||job.createdAt);
  if(!(job.status==='failed'||job.status==='queued'&&remoteAge>300000||job.status==='running'&&remoteAge>6000000))throw new StudioError(409,'pipeline_busy');
  const paperUrl=await signedPaper(ctx,w,state.sourceId);
  const retried=await retryStudioPipelineJob(job.id,identity(ctx,w),paperUrl);
  return save(ctx,w,{...w.document,pipeline:{...state,status:'queued',message:retried.message,updatedAt:retried.updatedAt}});
 }catch(error){
  if((state.status==='preparing'&&age>300000||state.status==='failed')&&(error as {status?:number}).status===404){
   return save(ctx,w,{...w.document,pipeline:{...state,status:'failed',message:'No remote job was created. Send the request again to start a new build.',updatedAt:new Date().toISOString()}});
  }
  throw error;
 }
}
