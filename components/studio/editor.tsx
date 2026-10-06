"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import Workspace,{type ConnectedStudio,type Page} from '@/app/build-preview/workspace';
import type { StudioDocument,StudioSource,StudioWorkspace } from '@/lib/studio/types';
import { useStudioTelemetry } from '@/lib/studio/use-telemetry';
import { loadPdfPages } from '@/lib/studio/pdf-client';
import { studioApi,StudioApiError } from './client';
import { mergeStudioUpdate } from '@/lib/studio/merge-update';
import { isPaper, MAX_PAPER_BYTES, MAX_RESOURCE_BYTES, sourceSpec } from '@/lib/studio/resources';
import { downloadStudioResource, PrimaryPaperHint, ResourceControls, ResourceViewer } from './resources';
import s from './studio.module.css';
import { useT } from '@/app/build-preview/ui';

export default function StudioEditor({id}:{id:string}){
 const [workspace,setWorkspace]=useState<StudioWorkspace|null>(null),[document,setDocument]=useState<StudioDocument|null>(null),[sourceId,setSourceId]=useState(''),[primaryPaperId,setPrimaryPaperId]=useState(''),[pages,setPages]=useState<Page[]>([]),[loading,setLoading]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState('Saved'),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[conflict,setConflict]=useState(false);
 const [pipelineMessage,setPipelineMessage]=useState(''),[refreshVersion,setRefreshVersion]=useState(0);
 const syncPipelineRef=useRef<()=>Promise<void>>(async()=>{});
 const server=useRef<StudioWorkspace|null>(null),pending=useRef<StudioDocument|null>(null),current=useRef<StudioDocument|null>(null),operation=useRef(false),blocked=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null),saving=useRef<Promise<void>|null>(null);
 const telemetry=useStudioTelemetry({workspaceId:id,enabled:Boolean(workspace),surfaceVersion:refreshVersion});
 const setCurrent=useCallback((doc:StudioDocument)=>{current.current=doc;setDocument(doc);},[]);
 const flush=useCallback(async()=>{
  while(saving.current)await saving.current;
  if(blocked.current)throw new Error('Reload the latest revision before saving more changes.');
  const run=async()=>{while(pending.current&&server.current){const snapshot=pending.current;pending.current=null;setStatus('Saving…');try{const result=await studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}`,{method:'PATCH',body:JSON.stringify({document:snapshot,expectedRevision:server.current.revision})});server.current=result.workspace;setWorkspace(result.workspace);setStatus(pending.current?'Unsaved changes':'Saved');}catch(e){pending.current=pending.current||snapshot;if(e instanceof StudioApiError&&e.status===409){blocked.current=true;setConflict(true);}setStatus('Not saved');setError(e instanceof Error?e.message:'Save failed.');throw e;}}};
  const promise=run();saving.current=promise;try{await promise;}finally{if(saving.current===promise)saving.current=null;}
 },[id]);
 const onChange=useCallback((doc:StudioDocument)=>{setCurrent(doc);pending.current=doc;setStatus('Unsaved changes');if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>{if(!operation.current)void flush().catch(()=>{});},900);},[flush,setCurrent]);
 useEffect(()=>{let cancelled=false;studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}`).then(({workspace:w})=>{if(cancelled)return;server.current=w;setWorkspace(w);setCurrent(w.document);const firstPaper=w.document.sources.find(isPaper);setPrimaryPaperId(w.document.pipeline?.sourceId||firstPaper?.id||'');setSourceId(w.document.pipeline?.sourceId||firstPaper?.id||w.document.sources[0]?.id||'');}).catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:'Could not load workspace.');});return()=>{cancelled=true;if(timer.current)clearTimeout(timer.current);};},[id,setCurrent]);
 useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(pending.current||saving.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
 const selectedSource=document?.sources.find(v=>v.id===sourceId);
 const sourcePath=selectedSource&&isPaper(selectedSource)?selectedSource.path:undefined;
 useEffect(()=>{
  if(!sourceId||!sourcePath){setPages([]);setLoading('');return;}
  const controller=new AbortController();let cleanup:(()=>void)|undefined;
  Promise.resolve().then(()=>{if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');setLoading('Loading paper…');window.getSelection()?.removeAllRanges();setPages([]);return studioApi<{url:string}>(`/api/studio/workspaces/${id}/sources/${sourceId}`,{signal:controller.signal});}).then(async({url})=>{const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Could not download the source.');return loadPdfPages(await response.arrayBuffer(),{signal:controller.signal,onProgress:(n,total)=>setLoading(`Rendering ${n} / ${total}…`)});}).then(result=>{
   cleanup=result.dispose;if(controller.signal.aborted){cleanup();return;}setPages(result.pages);setLoading(result.ocrRequiredPages.length?'Scanned pages can be box-selected. OCR is needed for text selection on those pages.':'');
   if(result.truncated)setError(`Only the first ${result.pages.length} of ${result.pageCount} pages are available in this workspace viewer.`);
   const latest=current.current;if(latest){const source=latest.sources.find(x=>x.id===sourceId);if(source&&!source.pages?.length)onChange({...latest,sources:latest.sources.map(x=>x.id===sourceId?{...x,pages:result.textPages}:x)});}
  }).catch(e=>{if(!controller.signal.aborted){setError(e instanceof Error?e.message:'Could not open PDF.');setLoading('Paper could not be opened.');}});
  return()=>{controller.abort();cleanup?.();};
 },[id,sourceId,sourcePath,onChange]);
 const pipelineId=document?.pipeline?.jobId;
 const pipelineState=document?.pipeline?.status;
 const pipelineProposal=document?.pipeline?.proposalId;
 const approvalPending=document?.acceptedPackage?.approvalPending;
 const discussionId=document?.discussion?.jobId;
 const discussionState=document?.discussion?.status;
 useEffect(()=>{
  const buildPending=!!pipelineId&&(!!approvalPending||!pipelineProposal&&!!pipelineState&&['preparing','queued','running'].includes(pipelineState));
  const discussionPending=!!discussionId&&!!discussionState&&['preparing','queued','running'].includes(discussionState);
  if(!buildPending&&!discussionPending)return;
  let cancelled=false,inFlight=false;
  const check=async()=>{
   if(cancelled||inFlight||operation.current)return;inFlight=true;
   try{const result=await studioApi<{job:{status:string;message:string}|null;discussion:{status:string;message:string}|null}>(`/api/studio/workspaces/${id}/pipeline`);
    if(cancelled)return;
    const done=(buildPending&&result.job&&['review','complete','failed'].includes(result.job.status))||(discussionPending&&result.discussion&&['review','complete','failed'].includes(result.discussion.status));
    if(done&&!operation.current)await syncPipelineRef.current();
   }catch(e){if(!cancelled)setPipelineMessage(e instanceof Error?e.message:'Could not check agent progress.');}finally{inFlight=false;}
  };
  void check();const poll=setInterval(()=>void check(),12000);
  return()=>{cancelled=true;clearInterval(poll);};
 },[id,pipelineId,pipelineProposal,pipelineState,approvalPending,discussionId,discussionState]);
 syncPipelineRef.current=async()=>{
  if(operation.current)return;operation.current=true;setBusy(true);
  try{await flush();const result=await studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}/pipeline`,{method:'POST',body:JSON.stringify({revision:server.current!.revision})});
   const late=pending.current;const merged=mergeStudioUpdate(result.workspace.document,late);server.current=result.workspace;pending.current=late?merged:null;setWorkspace(result.workspace);setCurrent(merged);setRefreshVersion(v=>v+1);setStatus(late?'Unsaved changes':'Saved');setPipelineMessage('');if(late)await flush();
  }catch(e){setError(e instanceof Error?e.message:'Could not load the agent result.');}finally{operation.current=false;setBusy(false);}
 };
 async function upload(file:File){
  if(operation.current)return;
  const spec=sourceSpec(file.name);
  if(!spec||file.size<1||file.size>(spec.kind==='paper'?MAX_PAPER_BYTES:MAX_RESOURCE_BYTES)){setError('Choose a supported file under the size limit (PDF 25 MB; resources 20 MB).');return;}
  setUploading(true);setError('');operation.current=true;
  try{await flush();const result=await studioApi<{source:StudioSource;uploadUrl:string;method:string;headers:Record<string,string>}>(`/api/studio/workspaces/${id}/sources`,{method:'POST',body:JSON.stringify({name:file.name,mimeType:spec.mimeType,size:file.size})});const uploaded=await fetch(result.uploadUrl,{method:result.method,headers:result.headers,body:file});if(!uploaded.ok)throw new Error('File upload failed. Please retry.');const latest=server.current!.document;const doc={...latest,sources:[...latest.sources,result.source],model:spec.kind==='paper'?{...latest.model,source:latest.model.source.filename?latest.model.source:{title:file.name,authors:'',filename:file.name}}:latest.model};setCurrent(doc);pending.current=doc;await flush();if(spec.kind==='paper')setPrimaryPaperId(result.source.id);setSourceId(result.source.id);}
  catch(e){setError(e instanceof Error?e.message:'Upload failed.');}finally{setUploading(false);operation.current=false;}
 }
 async function download(source:StudioSource){try{setError('');await downloadStudioResource(id,source);}catch(e){setError(e instanceof Error?e.message:'Could not download resource.');}}
 function selectSource(nextId:string){setSourceId(nextId);if(current.current?.sources.some(source=>source.id===nextId&&isPaper(source)&&source.includeInBuild!==false))setPrimaryPaperId(nextId);}
 function toggleBuild(source:StudioSource){const latest=current.current;if(!latest)return;const included=source.includeInBuild===false;const next={...latest,sources:latest.sources.map(item=>item.id===source.id?{...item,includeInBuild:included}:item)};onChange(next);if(!included&&source.id===primaryPaperId){const replacement=next.sources.find(item=>item.id!==source.id&&isPaper(item)&&item.includeInBuild!==false);setPrimaryPaperId(replacement?.id||'');}}
 const transact=async(path:string,body:Record<string,unknown>)=>{
  if(operation.current)throw new Error('Wait for the current operation to finish.');
  setBusy(true);setError('');operation.current=true;try{await flush();const result=await studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}/${path}`,{method:'POST',body:JSON.stringify({...body,revision:server.current!.revision})});const late=pending.current;const merged=mergeStudioUpdate(result.workspace.document,late);server.current=result.workspace;setWorkspace(result.workspace);pending.current=late?merged:null;setCurrent(merged);setRefreshVersion(v=>v+1);setStatus(late?'Unsaved changes':'Saved');if(late)await flush();return merged;}catch(e){if(e instanceof StudioApiError&&e.body.error==='revision_conflict'){blocked.current=true;setConflict(true);setError(e.message);}throw e;}finally{setBusy(false);operation.current=false;}
 };
 async function exportWorkspace(){setError('');try{await flush();const response=await fetch(`/api/studio/workspaces/${id}/export`);if(!response.ok){const body=await response.json();throw new Error(body.error||'Export failed.');}const url=URL.createObjectURL(await response.blob());const a=window.document.createElement('a');a.href=url;a.download=`${document?.title.replace(/[^a-z0-9-]/gi,'-')||'study'}-handoff.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(e instanceof Error?e.message:'Export failed.');}}
 function packageStatus(doc:StudioDocument){
  if(doc.pipeline&&['preparing','queued','running'].includes(doc.pipeline.status))return doc.pipeline.kind==='sync'?'Preparing study package…':'Preparing the first study…';
  if(doc.pipeline?.status==='failed')return 'Study package could not sync';
  if(doc.conversations.some(c=>c.messages.some(m=>m.proposal?.status==='pending')))return 'Review changes to continue';
  if(doc.acceptedPackage&&doc.pipeline?.status==='complete')return 'Study package ready';
  if(doc.conversations.some(c=>c.messages.some(m=>m.proposal?.status==='applied')))return 'Study package needs updating';
  return '';
 }
 function downloadUnsaved(){const url=URL.createObjectURL(new Blob([JSON.stringify(current.current,null,2)],{type:'application/json'}));const a=window.document.createElement('a');a.href=url;a.download='unsaved-study-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 if(!workspace||!document)return <div className={s.home}><main><Link href="/build">← Your studies</Link><p>{error||'Loading study…'}</p></main></div>;
 const paper=document.sources.find(source=>source.id===primaryPaperId&&isPaper(source)&&source.includeInBuild!==false)||document.sources.find(source=>isPaper(source)&&source.includeInBuild!==false);
 const latestApplied=document.conversations.flatMap(c=>c.messages).filter(message=>message.proposal?.status==='applied').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]?.proposal;
 async function recover(lane:'pipeline'|'discussion',proposalId?:string){try{await transact('pipeline',proposalId?{action:'sync-package',proposalId}:{action:'retry',lane});setPipelineMessage('');}catch(e){setError(e instanceof Error?e.message:'Could not recover the agent task.');}}
 const connected:ConnectedStudio={
  workspaceId:id,initialDocument:document,pages,sourceId,loading,status,busy:busy||uploading,
  syncVersion:refreshVersion,agentRunning:Boolean(document.discussion&&['preparing','queued','running'].includes(document.discussion.status)),buildRunning:Boolean(document.pipeline&&['preparing','queued','running'].includes(document.pipeline.status)),packageStatus:packageStatus(document),
  pipelineMessage:pipelineMessage||document.pipeline?.message,
  recoveryControls:<AgentRecovery buildFailed={document.pipeline?.status==='failed'} discussionFailed={document.discussion?.status==='failed'} needsSync={packageStatus(document)==='Study package needs updating'} canSync={Boolean(latestApplied)} busy={busy||uploading} message={pipelineMessage||document.discussion?.status==='failed'&&document.discussion.message||document.pipeline?.status==='failed'&&document.pipeline.message||''} onRetryDiscussion={()=>void recover('discussion')} onRetryBuild={()=>void recover('pipeline',latestApplied?.id)}/>,
  sourceControls:<div className={s.sourceControls}>
   <ResourceControls sources={document.sources} selectedId={sourceId} disabled={busy||uploading} uploading={uploading} onSelect={selectSource} onUpload={upload} onDownload={source=>void download(source)} onToggleBuild={toggleBuild}/>
   {paper&&<PrimaryPaperHint name={paper.name}/>}

   {!document.pipeline&&paper&&<button disabled={busy||uploading} onClick={async()=>{try{await transact('chat',{conversationId:document.activeConversationId||document.conversations[0]?.id||crypto.randomUUID(),requestId:crypto.randomUUID(),intent:'build',text:'Build this study from the uploaded paper and attached resources. Extract the protocol, materials, variables and analysis; flag all decisions requiring researcher input.',sourceId:paper.id,sourceSelection:{sourceId:paper.id,page:1,rects:[],text:'',kind:'region'}});setRefreshVersion(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'Could not start study build.');}}}>Build study ↗</button>}
   {loading&&pages.length>0&&<small title={loading}>OCR needed</small>}
  </div>,
  sourceContent:selectedSource&&!isPaper(selectedSource)?<ResourceViewer key={selectedSource.id} workspaceId={id} source={selectedSource} onDownload={()=>void download(selectedSource)}/>:undefined,
  onSelection:metadata=>telemetry.track("selection",metadata),onLayout:metadata=>telemetry.track("layout",metadata),
  onChange,onChat:async request=>{telemetry.track('chat',{action:'send'});return transact('chat',{...request,sourceId:paper?.id});},
  onProposal:async(proposalId,decision)=>{telemetry.track('review',{action:decision});return transact('proposals',{proposalId,decision});},
  onSave:flush,onExport:()=>void exportWorkspace(),onManage:flush,onNavigate:async href=>{await flush();window.location.assign(href);},
  onLeave:async()=>{await flush();window.location.assign("/build");},onSource:setSourceId,
 };
 return <div className={s.editor}><Workspace studio={connected}/>{(error||telemetry.deliveryError)&&<div className={s.noticeBar} role="alert">{error||telemetry.deliveryError}<button onClick={downloadUnsaved}>Download local draft</button>{conflict?<><button onClick={()=>window.location.reload()}>Reload server version</button></>:error&&<button onClick={()=>{setError('');if(pending.current)void flush().catch(()=>{});}}>{pending.current?'Retry save':'Dismiss'}</button>}</div>}</div>;
}

function AgentRecovery({buildFailed,discussionFailed,needsSync,canSync,busy,message,onRetryDiscussion,onRetryBuild}:{buildFailed:boolean;discussionFailed:boolean;needsSync:boolean;canSync:boolean;busy:boolean;message:string;onRetryDiscussion:()=>void;onRetryBuild:()=>void}){
 const t=useT();
 if(!buildFailed&&!discussionFailed&&!needsSync&&!message)return null;
 return <div className={s.agentRecovery} role="status">{message&&<p>{t(message)}</p>}{discussionFailed&&<button type="button" disabled={busy} onClick={onRetryDiscussion}>{t('Retry response')}</button>}{(buildFailed||needsSync)&&<button type="button" disabled={busy||needsSync&&!canSync} onClick={onRetryBuild}>{t('Sync study package')}</button>}</div>;
}
