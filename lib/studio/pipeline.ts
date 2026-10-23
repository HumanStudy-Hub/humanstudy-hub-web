import { webAgentAllowed } from './web-access';
import { approveStage, createStudioPipelineJob, dispatchStudioPipelineJob, listPackageFiles, readOwnedStudioJob, readOwnedStudioTurn, retryStudioPipelineJob, studioPipelineConfigured, type StudioPipelineJob } from '@/lib/github-jobs';
import type { StudioContext } from './auth';
import type { StudioDocument, StudioMessage, StudioMessageRef, StudioPipeline, StudioWorkspace, SourceSelection } from './types';
import type { ModelAnchor } from '@/app/build-preview/model-review';
import { StudioError } from './http';
import { saveWorkspaceResearch, type ResearchPlan } from '../research-data/server-capture';
import { decisionEvents, decisionId, dispatchEvents, dispatchFailedEvents, finishEvents, packageFileEvents, serverActionId, serverEventId, submitEvents } from '../research-data/server-producer';
import { adaptPipelinePackage, groundStudioModelEvidence } from './pipeline-adapter';
import { validateStudioDocument, validateStudyModel } from './validation';
import { modelFingerprint } from './model-version';
import { scopeConversationsForPrompt } from './conversation-tree';
import { isPaper, validStoredSource } from './resources';
import { isOwnedResourceArchivePath, prepareStudioResourceArchive, signPrivateSource } from './resource-server';

const identity = (ctx:StudioContext,w:StudioWorkspace) => ({ownerId:ctx.user.id,workspaceId:w.id});
const active=(state?:StudioPipeline)=>state&&['preparing','queued','running'].includes(state.status);
const publicJob=(job:StudioPipelineJob)=>({id:job.id,status:job.status,message:job.message,progress:job.progress,packageReady:job.packageReady});
const jobIdFor=(w:StudioWorkspace,requestId:string)=>`studio-${w.id}-${requestId}`;
export async function ownedPipeline(ctx:StudioContext,w:StudioWorkspace) {
 if(!w.document.pipeline)throw new StudioError(404,'pipeline_not_found');
 try{return await readOwnedStudioJob(w.document.pipeline.jobId,identity(ctx,w));}
 catch{throw new StudioError(404,'pipeline_not_found');}
}
async function save(ctx:StudioContext,w:StudioWorkspace,document:StudioDocument,research?:ResearchPlan){
 const result=await saveWorkspaceResearch(ctx,w.id,validateStudioDocument(document),w.revision,research);
 if('conflict' in result)throw new StudioError(409,'revision_conflict');
 return result;
}
async function signedPaper(ctx:StudioContext,w:StudioWorkspace,sourceId:string){
 const source=w.document.sources.find(s=>s.id===sourceId);
 if(!source||!isPaper(source)||!validStoredSource(source,ctx.user.id,w.id))throw new StudioError(403,'invalid_source');
 return signPrivateSource(ctx,source.path);
}
function choosePaper(ctx:StudioContext,w:StudioWorkspace,sourceId?:string){
 const sources=w.document.sources;
 const source=sources.find(s=>s.id===sourceId&&isPaper(s)&&s.includeInBuild!==false)||sources.find(s=>isPaper(s)&&s.includeInBuild!==false);
 if(!source)throw new StudioError(400,'paper_required','Upload a PDF before asking the study-building agent.');
 if(!validStoredSource(source,ctx.user.id,w.id))throw new StudioError(403,'invalid_source');
 return source;
}
function failureMessage(error:unknown){
 if(error instanceof StudioError)return ({
  resources_too_large:'Attached resources exceed the 20 MB combined build limit.',
  resource_unavailable:'An attached resource could not be read. Re-upload it and retry.',
  resource_upload_failed:'The resource bundle could not be saved. Retry when storage is available.',
  invalid_source:'An attached file has invalid metadata. Re-upload it.',
 } as Record<string,string>)[error.code];
 return undefined;
}
// Research producers (T08). Causality: the browser's primary action (or a server action when the
// browser sent none) -> turn -> dispatch tool call -> result. researchActionId persists the link.
const turnStart=(d:StudioDocument,s:StudioPipeline)=>d.conversations.find(c=>c.id===s.conversationId)?.messages.find(m=>m.id===s.requestId)?.createdAt;
const attemptOf=(job:Pick<StudioPipelineJob,'status'|'updatedAt'>)=>`${job.status}:${job.updatedAt||'unknown'}`;
const toolEndId=(owner:string,jobId:string,attempt:string)=>serverEventId(owner,`tool.end:${jobId}:${attempt}`);
type StartInput={actionId?:string;sourceId?:string;conversationId:string;requestId:string;text:string;modelAnchor:ModelAnchor|null;sourceSelection:SourceSelection|null;parent?:StudioMessageRef;replyTo?:StudioMessageRef;mergedFrom?:StudioMessageRef;intent?:'discuss'|'build'};
const promptDocument=(document:StudioDocument)=>{const {programVersions,...current}=document;void programVersions;return current;};
const promptConversations=(items:StudioDocument['conversations'])=>items.map(c=>({...c,messages:c.messages.map(({proposal,...message})=>{void proposal;return message;})}));
export async function startPipeline(ctx:StudioContext,w:StudioWorkspace,input:StartInput) {
 if(w.document.project?.copyState&&w.document.project.copyState!=='ready')throw new StudioError(409,'project_copy_pending');
 if(!studioPipelineConfigured())throw new StudioError(503,'pipeline_setup_required','Configure the original GitHub pipeline token and STUDIO_PIPELINE_REF.');
 const document=validateStudioDocument(w.document),mode=input.intent==='build'?'build':'discuss';
 if(document.conversations.some(c=>c.messages.some(m=>m.id===input.requestId)))return w;
 if(!webAgentAllowed(document,mode))throw new StudioError(403,'continue_in_app','The first build runs on the web. Continue this study in HumanStudy Desktop.');
 if(active(document.discussion))throw new StudioError(409,'discussion_busy','The agent is answering a previous message.');
 if(mode==='build'&&active(document.pipeline))throw new StudioError(409,'pipeline_busy','The study package is still building.');
 const source=choosePaper(ctx,w,input.sourceId||input.sourceSelection?.sourceId||document.pipeline?.sourceId);
 const paperUrl=await signedPaper(ctx,w,source.id);
 const now=new Date().toISOString(),jobId=jobIdFor(w,input.requestId);
 const researchActionId=input.actionId||serverActionId(ctx.user.id,input.requestId);
 const state:StudioPipeline={jobId,requestId:input.requestId,conversationId:input.conversationId,sourceId:source.id,status:'preparing',message:mode==='build'?'Preparing the original study-building agent':'Preparing the agent response',updatedAt:now,baseModelFingerprint:modelFingerprint(document.model),researchActionId,...(mode==='build'?{kind:'initial' as const}:{})};
 const userMessage:StudioMessage={id:input.requestId,role:'user',text:input.text,createdAt:now,...(input.modelAnchor?{modelAnchor:input.modelAnchor}:{}),...(input.sourceSelection?{sourceSelection:input.sourceSelection}:{}),...(input.replyTo?{replyTo:input.replyTo}:{}),...(input.mergedFrom?{mergedFrom:input.mergedFrom}:{})};
 const existing=document.conversations.find(c=>c.id===input.conversationId);
 const conversation=existing?{...existing,draft:'',messages:[...existing.messages,userMessage],updatedAt:now}:{id:input.conversationId,title:input.text.slice(0,80),messages:[userMessage],...(input.parent?{parent:input.parent}:{}),updatedAt:now,draft:'',modelAnchor:input.modelAnchor,sourceSelection:input.sourceSelection,selected:input.modelAnchor?.entityIds[0]||document.model.entities[0]?.id||''};
 const lane=mode==='build'?'pipeline':'discussion';
 // The CAS reservation precedes every remote mutation and limits each lane to one job.
 const turnLink=serverEventId(ctx.user.id,`turn_start:${input.requestId}`);
 let current=await save(ctx,w,{...document,[lane]:state,activeConversationId:input.conversationId,conversations:[...document.conversations.filter(c=>c.id!==input.conversationId),conversation]},
  (_revision,p)=>[{producer:'chat.submit',key:`turn:${input.requestId}:submit`,events:submitEvents(p,{requestId:input.requestId,conversationId:input.conversationId,text:input.text,mode,jobId,actionId:input.actionId,sourceRecordId:source.id,modelAnchor:input.modelAnchor,sourceSelection:input.sourceSelection,parent:input.parent,replyTo:input.replyTo,mergedFrom:input.mergedFrom})}]);
 let dispatchInput:unknown={job_id:jobId,mode};
 try {
  const materials=await prepareStudioResourceArchive(ctx,current,source.id);
  const scopedConversations=scopeConversationsForPrompt([...document.conversations.filter(c=>c.id!==input.conversationId),conversation],input.conversationId);
  const referencedMessages=([['replyTo',input.replyTo],['mergedFrom',input.mergedFrom]] as const).flatMap(([relation,ref])=>{
   if(!ref)return [];
   const message=document.conversations.find(c=>c.id===ref.conversationId)?.messages.find(m=>m.id===ref.messageId);
   if(!message)throw new StudioError(400,'invalid_message_reference');
   return [{relation,ref,message:{id:message.id,role:message.role,text:message.text,createdAt:message.createdAt,modelAnchor:message.modelAnchor,sourceSelection:message.sourceSelection,evidence:message.evidence,...(message.proposal?{proposal:{model:message.proposal.model,summary:message.proposal.summary,status:message.proposal.status}}:{})}}];
  });
  // Only a previously accepted package may seed a new job. Pending and rejected
  // package bytes must never acquire authority by being copied into a later run.
  const prior=document.acceptedPackage;
  const reusable=mode==='build'&&prior&&document.pipeline?.sourceId===source.id?prior.jobId:undefined;
  const request={version:1,mode,...identity(ctx,w),conversationId:input.conversationId,requestId:input.requestId,primarySourceId:source.id,message:input.text,document:{...promptDocument(document),sources:document.sources.filter(s=>s.includeInBuild!==false),conversations:promptConversations(scopedConversations)},modelAnchor:input.modelAnchor,sourceSelection:input.sourceSelection,parent:input.parent,replyTo:input.replyTo,mergedFrom:input.mergedFrom,referencedMessages};
  // The tool input is what the runner receives; signed paper/material URLs are never recorded.
  dispatchInput={paperName:source.name,openMaterialsSourceIds:materials?.sourceIds||[],previousJobId:reusable??null,request};
  const job=await createStudioPipelineJob({id:jobId,identity:{...identity(ctx,w),requestId:input.requestId,conversationId:input.conversationId},paperName:source.name,paperUrl,openMaterialsUrl:materials?.url,openMaterialsPathname:materials?.path,openMaterialsSourceIds:materials?.sourceIds||[],previousJobId:reusable,request});
  await dispatchStudioPipelineJob(job);
  current=await save(ctx,current,{...current.document,[lane]:{...state,status:'queued',message:job.message,updatedAt:new Date().toISOString()}},
   (_revision,p)=>[{producer:'pipeline.dispatch',key:`tool:${jobId}:dispatch`,events:dispatchEvents(p,{jobId,conversationId:input.conversationId,actionId:researchActionId,causedBy:turnLink,mode,input:dispatchInput})}]);
 }catch(error){
  // A dispatch followed by a CAS conflict can still be recovered by polling.
  if(error instanceof StudioError&&error.code==='revision_conflict')throw error;
  const message=failureMessage(error)||'Could not start the original agent. Check GitHub workflow access, then send again.';
  current=await save(ctx,current,{...current.document,[lane]:{...state,status:'failed',message,updatedAt:new Date().toISOString()}},
   (_revision,p)=>[{producer:'pipeline.dispatch_failed',key:`tool:${jobId}:dispatch-failed`,events:dispatchFailedEvents(p,{jobId,conversationId:input.conversationId,actionId:researchActionId,requestId:input.requestId,startedAt:now,error:message,input:dispatchInput})}]);
 }
 return current;
}

export async function startPackageSync(ctx:StudioContext,w:StudioWorkspace,proposalId:string,actionId?:string){
 if(w.document.project?.copyState&&w.document.project.copyState!=='ready')throw new StudioError(409,'project_copy_pending');
 const document=validateStudioDocument(w.document);
 if(active(document.pipeline))throw new StudioError(409,'pipeline_busy');
 const source=choosePaper(ctx,w,document.pipeline?.sourceId);
 const requestId=crypto.randomUUID(),jobId=jobIdFor(w,requestId),now=new Date().toISOString();
 const fingerprint=modelFingerprint(document.model);
 const proposalMessage=document.conversations.flatMap(c=>c.messages).find(m=>m.proposal?.id===proposalId);
 const conversationId=document.conversations.find(c=>c.messages.includes(proposalMessage!))?.id||document.activeConversationId||document.conversations[0]?.id;
 if(!conversationId)throw new StudioError(409,'pipeline_conversation_missing');
 const researchActionId=actionId||decisionId(ctx.user.id,proposalId);
 const state:StudioPipeline={jobId,requestId,conversationId,sourceId:source.id,status:'preparing',message:'Preparing package for the accepted model',updatedAt:now,kind:'sync',targetModelFingerprint:fingerprint,researchActionId};
 let dispatchInput:unknown={job_id:jobId,mode:'sync'};
 let current=await save(ctx,w,{...document,pipeline:state});
 try{
  const paperUrl=await signedPaper(ctx,current,source.id);
  const materials=await prepareStudioResourceArchive(ctx,current,source.id);
  const prior=document.acceptedPackage;
  const previousJobId=prior&&document.pipeline?.sourceId===source.id?prior.jobId:undefined;
  const request={version:1,mode:'build',purpose:'accepted-model-sync',...identity(ctx,w),conversationId,requestId,primarySourceId:source.id,message:'Build the complete study package for the authoritative accepted model. Preserve its model semantics and identifiers.',document:{...promptDocument(document),sources:document.sources.filter(s=>s.includeInBuild!==false),conversations:promptConversations(scopeConversationsForPrompt(document.conversations,conversationId))},targetModelFingerprint:fingerprint};
  dispatchInput={paperName:source.name,openMaterialsSourceIds:materials?.sourceIds||[],previousJobId:previousJobId??null,request};
  const job=await createStudioPipelineJob({id:jobId,identity:{...identity(ctx,w),requestId,conversationId},paperName:source.name,paperUrl,openMaterialsUrl:materials?.url,openMaterialsPathname:materials?.path,openMaterialsSourceIds:materials?.sourceIds||[],previousJobId,request});
  await dispatchStudioPipelineJob(job);
  current=await save(ctx,current,{...current.document,pipeline:{...state,status:'queued',message:job.message,updatedAt:new Date().toISOString()}},
   (_revision,p)=>[{producer:'pipeline.dispatch',key:`tool:${jobId}:dispatch`,events:dispatchEvents(p,{jobId,conversationId,actionId:researchActionId,causedBy:decisionId(ctx.user.id,proposalId),mode:'sync',input:dispatchInput})}]);
 }catch(error){
  if(error instanceof StudioError&&error.code==='revision_conflict')throw error;
  const message=failureMessage(error)||'Package sync could not start. Retry from the package status.';
  current=await save(ctx,current,{...current.document,pipeline:{...state,status:'failed',message,updatedAt:new Date().toISOString()}},
   (_revision,p)=>[{producer:'pipeline.dispatch_failed',key:`tool:${jobId}:dispatch-failed`,events:dispatchFailedEvents(p,{jobId,conversationId,actionId:researchActionId,error:message,input:dispatchInput})}]);
 }
 return current;
}

function validateTurn(input:unknown,requestId:string,document:StudioDocument){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new StudioError(502,'invalid_discussion_result');
 const turn=input as Record<string,unknown>;
 if(turn.requestId!==requestId||typeof turn.reply!=='string'||!turn.reply.trim()||turn.reply.length>20000)throw new StudioError(502,'invalid_discussion_result');
 const model=turn.model===undefined?undefined:groundStudioModelEvidence(validateStudyModel(turn.model,{sources:document.sources}),document);
 const summary=turn.summary===undefined?undefined:turn.summary;
 if(summary!==undefined&&(typeof summary!=='string'||summary.length>4000))throw new StudioError(502,'invalid_discussion_result');
 return {reply:turn.reply,model,summary:summary as string|undefined};
}
async function syncDiscussion(ctx:StudioContext,w:StudioWorkspace){
 const state=w.document.discussion;
 let research:ResearchPlan|undefined;
 if(!state)return {workspace:w,job:null};
 let job:StudioPipelineJob;
 try{job=await readOwnedStudioJob(state.jobId,identity(ctx,w));}catch{if(state.status==='failed'||state.status==='preparing')return {workspace:w,job:null};throw new StudioError(404,'discussion_not_found');}
 const pipeline:StudioPipeline={...state,status:job.status,message:job.message.slice(0,4000),updatedAt:job.updatedAt};
 let document=validateStudioDocument(w.document);
 if(job.status==='complete'&&!state.resultMessageId){
  let turn:ReturnType<typeof validateTurn>,raw:unknown;
  try{raw=await readOwnedStudioTurn(job.id,identity(ctx,w));turn=validateTurn(raw,state.requestId,document);}
  catch{pipeline.status='failed';pipeline.message='The agent response was incomplete or invalid. Retry this message.';turn={reply:'',model:undefined,summary:undefined};}
  const received=raw&&typeof raw==='object'&&typeof (raw as {reply?:unknown}).reply==='string'?(raw as {reply:string}).reply:'';
  if(pipeline.status!=='failed'){
   const changed=turn.model!==undefined&&modelFingerprint(turn.model)!==modelFingerprint(document.model);
   const proposalId=changed?crypto.randomUUID():undefined;
   const message:StudioMessage={id:crypto.randomUUID(),role:'agent',createdAt:new Date().toISOString(),text:turn.reply,...(changed&&proposalId?{proposal:{id:proposalId,model:turn.model!,changesModel:true,summary:turn.summary||'Suggested model update',status:'pending',baseModelFingerprint:state.baseModelFingerprint||modelFingerprint(document.model),jobId:job.id}}:{})};
   if(!document.conversations.some(c=>c.id===state.conversationId))throw new StudioError(409,'pipeline_conversation_missing');
   document={...document,conversations:document.conversations.map(c=>c.id===state.conversationId?{...c,messages:[...c.messages,message],updatedAt:message.createdAt}:c)};
   pipeline.resultMessageId=message.id;
   pipeline.proposalId=proposalId;
   research=(_r,p)=>[{producer:'agent.discussion_result',key:`tool:${job.id}:${attemptOf(job)}`,events:finishEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt:attemptOf(job),status:'completed',output:raw,startedAt:turnStart(w.document,state),turn:{requestId:state.requestId,startedAt:turnStart(w.document,state)},reply:{messageId:message.id,text:turn.reply,status:'complete',...(message.proposal?{proposal:message.proposal}:{})},proposalId})}];
  }else{
   // Preserve what the runner returned, marked partial, with the error that made it unusable.
   research=(_r,p)=>[{producer:'agent.discussion_result',key:`tool:${job.id}:${attemptOf(job)}`,events:finishEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt:attemptOf(job),status:'error',...(raw===undefined?{}:{output:raw}),startedAt:turnStart(w.document,state),turn:{requestId:state.requestId,startedAt:turnStart(w.document,state)},...(received?{reply:{messageId:`partial-${job.id}`.slice(0,120),text:received,status:'partial' as const,reason:'invalid_result'}}:{}),error:pipeline.message})}];
  }
 }else if(job.status==='failed'&&state.status!=='failed'){
  research=(_r,p)=>[{producer:'agent.discussion_failed',key:`tool:${job.id}:${attemptOf(job)}`,events:finishEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt:attemptOf(job),status:'error',output:{status:job.status,message:job.message},startedAt:turnStart(w.document,state),turn:{requestId:state.requestId,startedAt:turnStart(w.document,state)},error:job.message||'The agent run failed.'})}];
 }
 document={...document,discussion:pipeline};
 const changed=JSON.stringify(w.document.discussion)!==JSON.stringify(pipeline);
 return {workspace:changed?await save(ctx,w,document,research):w,job:publicJob(job)};
}
async function syncPackage(ctx:StudioContext,w:StudioWorkspace){
 const state=w.document.pipeline;
 let research:ResearchPlan|undefined;
 if(!state)return {workspace:w,job:null};
 let job:StudioPipelineJob;
 try{job=await ownedPipeline(ctx,w);}catch(error){if(state.status==='failed'||state.status==='preparing')return {workspace:w,job:null};throw error;}
 let document=validateStudioDocument(w.document);
 const pipeline:StudioPipeline={...state,status:job.status,message:job.message.slice(0,4000),updatedAt:job.updatedAt};
 if(state.kind==='sync'&&state.proposalId&&state.status==='complete'){pipeline.status='complete';pipeline.message='Package synchronized with the accepted model';}
 if(state.kind!=='sync'&&state.status==='complete'&&document.acceptedPackage?.jobId===job.id){pipeline.status='complete';pipeline.message='Study package accepted';}
 if((job.status==='review'||job.status==='complete')&&job.packageReady===true&&!state.proposalId){
  if(state.kind==='sync'){
   if(modelFingerprint(document.model)!==state.targetModelFingerprint){
    pipeline.status='failed';pipeline.message='The model changed during package sync. Starting a new package for the current model.';
    research=(_r,p)=>[{producer:'pipeline.sync_result',key:`tool:${job.id}:${attemptOf(job)}`,events:finishEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt:attemptOf(job),status:'interrupted',output:{status:job.status,packageReady:true,superseded:true},startedAt:state.updatedAt,error:pipeline.message})}];
   }else{
    document={...document,acceptedPackage:{jobId:job.id,modelFingerprint:state.targetModelFingerprint!,acceptedAt:new Date().toISOString(),...(job.status==='review'?{approvalPending:true}:{})}};
    pipeline.proposalId=state.requestId; // Receipt prevents repeated processing.
    pipeline.status='complete';pipeline.message='Package synchronized with the accepted model';
    research=(_r,p)=>[{producer:'pipeline.sync_result',key:`tool:${job.id}:${attemptOf(job)}`,events:finishEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt:attemptOf(job),status:'completed',output:{status:job.status,packageReady:true,acceptedPackage:document.acceptedPackage},startedAt:state.updatedAt})}];
   }
  }else{
   const files=(await listPackageFiles(job.id,identity(ctx,w))).filter(f=>/\.(json|md|txt|csv|py|r)$/i.test(f.path));
   if(files.reduce((n,f)=>n+f.content.length,0)>10*1024*1024)throw new StudioError(413,'package_preview_too_large');
   const adapted=adaptPipelinePackage(files.map(f=>({path:f.path,content:f.content.toString('utf8')})),document);
   const proposalId=crypto.randomUUID();
   const reply=files.find(f=>f.path.endsWith('studio-reply.md'))?.content.toString('utf8').slice(0,12000);
   const message:StudioMessage={id:crypto.randomUUID(),role:'agent',createdAt:new Date().toISOString(),text:[reply||'The study-building agent finished the package.',adapted.summary].join('\n\n').slice(0,20000),proposal:{id:proposalId,model:adapted.model,changesModel:modelFingerprint(adapted.model)!==(state.baseModelFingerprint||modelFingerprint(document.model)),artifacts:adapted.artifacts,summary:adapted.summary.slice(0,4000),status:'pending',baseModelFingerprint:state.baseModelFingerprint||modelFingerprint(document.model),jobId:job.id}};
   if(!document.conversations.some(c=>c.id===state.conversationId))throw new StudioError(409,'pipeline_conversation_missing');
   document={...document,conversations:document.conversations.map(c=>c.id===state.conversationId?{...c,messages:[...c.messages,message]}:c)};
   pipeline.proposalId=proposalId;
   const attempt=attemptOf(job),started=turnStart(w.document,state),listing=files.map(f=>({path:f.path,bytes:f.content.length}));
   research=(revision,p)=>[{producer:'pipeline.build_result',key:`tool:${job.id}:${attempt}`,events:[
    ...finishEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt,status:'completed',output:{status:job.status,packageReady:true,files:listing},startedAt:started,turn:{requestId:state.requestId,startedAt:started},reply:{messageId:message.id,text:message.text,status:'complete',proposal:message.proposal},proposalId}),
    // Generated research materials as received from the runner's job branch.
    ...packageFileEvents(p,{jobId:job.id,revision,files,actionId:state.researchActionId??null,causedBy:toolEndId(p.ownerId,job.id,attempt)}),
   ]}];
  }
 }else if(job.status==='failed'&&state.status!=='failed'&&state.status!=='complete'){
  research=(_r,p)=>[{producer:state.kind==='sync'?'pipeline.sync_failed':'pipeline.build_failed',key:`tool:${job.id}:${attemptOf(job)}`,events:finishEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt:attemptOf(job),status:'error',output:{status:job.status,message:job.message},startedAt:turnStart(w.document,state)??state.updatedAt,...(state.kind==='sync'?{}:{turn:{requestId:state.requestId,startedAt:turnStart(w.document,state)}}),error:job.message||'The study-building run failed.'})}];
 }
 document={...document,pipeline};
 const changed=JSON.stringify(w.document.pipeline)!==JSON.stringify(pipeline)||JSON.stringify(w.document.acceptedPackage)!==JSON.stringify(document.acceptedPackage);
 let workspace=changed?await save(ctx,w,document,research):w;
 if(workspace.document.acceptedPackage?.jobId===job.id&&workspace.document.acceptedPackage.approvalPending){
  try{workspace=await reconcilePackageApproval(ctx,workspace);}catch{/* The accepted package remains durable; polling can reconcile approval. */}
 }
 if(state.kind==='sync'&&state.status!=='failed'&&pipeline.status==='failed'&&state.targetModelFingerprint!==modelFingerprint(document.model)){
  const applied=workspace.document.conversations.flatMap(c=>c.messages).filter(m=>m.proposal?.status==='applied').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(m=>m.proposal!).find(p=>modelFingerprint(p.model)===modelFingerprint(document.model))
    ||workspace.document.conversations.flatMap(c=>c.messages).map(m=>m.proposal).filter(p=>p?.status==='applied').at(-1);
  if(applied){try{return {workspace:await startPackageSync(ctx,workspace,applied.id),job:publicJob(job)};}catch{/* Leave a visible failed state and manual retry path. */}}
 }
 return {workspace,job:publicJob(job)};
}
export async function syncPipeline(ctx:StudioContext,w:StudioWorkspace){
 // Each lane commits by CAS, so a simultaneous autosave causes a recoverable conflict.
 const packageResult=await syncPackage(ctx,w);
 const discussionResult=await syncDiscussion(ctx,packageResult.workspace);
 return {workspace:discussionResult.workspace,job:packageResult.job,discussion:discussionResult.job};
}
export async function getPipelineJobs(ctx:StudioContext,w:StudioWorkspace){
 let job:ReturnType<typeof publicJob>|null=null,discussion:ReturnType<typeof publicJob>|null=null;
 if(w.document.pipeline){try{job=publicJob(await ownedPipeline(ctx,w));}catch(error){if(!['preparing','failed'].includes(w.document.pipeline.status))throw error;}}
 if(w.document.discussion){try{discussion=publicJob(await readOwnedStudioJob(w.document.discussion.jobId,identity(ctx,w)));}catch(error){if(!['preparing','failed'].includes(w.document.discussion.status))throw error;}}
 return {job,discussion};
}
export async function reconcilePackageApproval(ctx:StudioContext,w:StudioWorkspace){
 const accepted=w.document.acceptedPackage;
 if(!accepted||!accepted.approvalPending)return w;
 const job=await readOwnedStudioJob(accepted.jobId,identity(ctx,w));
 if(job.status==='review')await approveStage(job.id,{decision:'approved'},identity(ctx,w));
 else if(job.status!=='complete')throw new StudioError(409,'package_approval_not_ready');
 const confirmed={jobId:accepted.jobId,modelFingerprint:accepted.modelFingerprint,acceptedAt:accepted.acceptedAt};
 const thread=w.document.pipeline?.jobId===accepted.jobId?w.document.pipeline.conversationId:w.document.activeConversationId;
 // The server approves the runner's review stage on the user's behalf once the package is accepted.
 return save(ctx,w,{...w.document,acceptedPackage:confirmed},thread?(_r,p)=>[{producer:'pipeline.stage_approval',key:`approval:${accepted.jobId}`,events:decisionEvents(p,{proposalId:accepted.jobId,decision:'apply',conversationId:thread,target:'pipeline.stage_approval',automatic:true,actionId:w.document.pipeline?.jobId===accepted.jobId?w.document.pipeline.researchActionId??null:null})}]:undefined);
}
export async function retryPipeline(ctx:StudioContext,w:StudioWorkspace,lane:'pipeline'|'discussion'='pipeline'){
 const state=w.document[lane];
 if(!state)throw new StudioError(404,lane==='pipeline'?'pipeline_not_found':'discussion_not_found');
 // A first build that failed or stalled may run again; once it has succeeded, the study continues in the app.
 if(lane!=='pipeline'||state.status==='review'||state.status==='complete')throw new StudioError(403,'continue_in_app','Continue this study in HumanStudy Desktop.');
 const age=Date.now()-Date.parse(state.updatedAt);
 try{
  const job=await readOwnedStudioJob(state.jobId,identity(ctx,w));
  if(job.status==='review'||job.status==='complete')return (await syncPipeline(ctx,w)).workspace;
  const remoteAge=Date.now()-Date.parse(job.updatedAt||job.createdAt);
  if(!(job.status==='failed'||job.status==='queued'&&remoteAge>300000||job.status==='running'&&remoteAge>6000000))throw new StudioError(409,'pipeline_busy');
  const paperUrl=await signedPaper(ctx,w,state.sourceId);
  const materialsPath=job.openMaterialsPathname;
  if(materialsPath&&!isOwnedResourceArchivePath(materialsPath,ctx,w.id))throw new StudioError(403,'invalid_source');
  const materialsUrl=materialsPath?await signPrivateSource(ctx,materialsPath):undefined;
  const retried=await retryStudioPipelineJob(job.id,identity(ctx,w),paperUrl,materialsUrl);
  return save(ctx,w,{...w.document,[lane]:{...state,status:'queued',message:retried.message,updatedAt:retried.updatedAt}},
   (_r,p)=>[{producer:'pipeline.retry',key:`tool:${job.id}:retry:${retried.updatedAt}`,events:dispatchEvents(p,{jobId:job.id,conversationId:state.conversationId,actionId:state.researchActionId??null,causedBy:null,mode:lane,input:{job_id:job.id,retry:true,previous_status:job.status,materials:Boolean(materialsPath)},retryOf:retried.updatedAt})}]);
 }catch(error){
  if((state.status==='preparing'&&age>300000||state.status==='failed')&&(error as {status?:number}).status===404){
   return save(ctx,w,{...w.document,[lane]:{...state,status:'failed',message:'No remote job was created. Send again to restart.',updatedAt:new Date().toISOString()}},
    (_r,p)=>[{producer:'pipeline.missing_job',key:`tool:${state.jobId}:missing`,events:finishEvents(p,{jobId:state.jobId,conversationId:state.conversationId,actionId:state.researchActionId??null,attempt:'missing',status:'interrupted',output:{status:'not_found'},startedAt:state.updatedAt,...(state.kind==='sync'?{}:{turn:{requestId:state.requestId,startedAt:turnStart(w.document,state)}}),error:'No remote job was created.'})}]);
  }
  throw error;
 }
}
