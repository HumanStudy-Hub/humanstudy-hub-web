"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import Workspace,{type ConnectedStudio,type Page} from '@/app/build-preview/workspace';
import type { StudioDocument,StudioSource,StudioWorkspace } from '@/lib/studio/types';
import { useStudioTelemetry } from '@/lib/studio/use-telemetry';
import { loadPdfPages } from '@/lib/studio/pdf-client';
import { studioApi,StudioApiError } from './client';
import { mergeStudioUpdate } from '@/lib/studio/merge-update';
import s from './studio.module.css';

export default function StudioEditor({id}:{id:string}){
 const [workspace,setWorkspace]=useState<StudioWorkspace|null>(null),[document,setDocument]=useState<StudioDocument|null>(null),[sourceId,setSourceId]=useState(''),[pages,setPages]=useState<Page[]>([]),[loading,setLoading]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState('Saved'),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[conflict,setConflict]=useState(false);
 const [parsing,setParsing]=useState(false);
 const [pipelineMessage,setPipelineMessage]=useState(''),[refreshVersion,setRefreshVersion]=useState(0);
 const syncPipelineRef=useRef<()=>Promise<void>>(async()=>{});
 const server=useRef<StudioWorkspace|null>(null),pending=useRef<StudioDocument|null>(null),current=useRef<StudioDocument|null>(null),operation=useRef(false),blocked=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null),saving=useRef<Promise<void>|null>(null);
 const telemetry=useStudioTelemetry({workspaceId:id,enabled:Boolean(workspace)});
 const setCurrent=useCallback((doc:StudioDocument)=>{current.current=doc;setDocument(doc);},[]);
 const flush=useCallback(async()=>{
  while(saving.current)await saving.current;
  if(blocked.current)throw new Error('Reload the latest revision before saving more changes.');
  const run=async()=>{while(pending.current&&server.current){const snapshot=pending.current;pending.current=null;setStatus('Saving…');try{const result=await studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}`,{method:'PATCH',body:JSON.stringify({document:snapshot,expectedRevision:server.current.revision})});server.current=result.workspace;setWorkspace(result.workspace);setStatus(pending.current?'Unsaved changes':'Saved');}catch(e){pending.current=pending.current||snapshot;if(e instanceof StudioApiError&&e.status===409){blocked.current=true;setConflict(true);}setStatus('Not saved');setError(e instanceof Error?e.message:'Save failed.');throw e;}}};
  const promise=run();saving.current=promise;try{await promise;}finally{if(saving.current===promise)saving.current=null;}
 },[id]);
 const onChange=useCallback((doc:StudioDocument)=>{setCurrent(doc);pending.current=doc;setStatus('Unsaved changes');if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>{if(!operation.current)void flush().catch(()=>{});},900);},[flush,setCurrent]);
 useEffect(()=>{let cancelled=false;studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}`).then(({workspace:w})=>{if(cancelled)return;server.current=w;setWorkspace(w);setCurrent(w.document);setSourceId(w.document.sources[0]?.id||'');}).catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:'Could not load workspace.');});return()=>{cancelled=true;if(timer.current)clearTimeout(timer.current);};},[id,setCurrent]);
 useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(pending.current||saving.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
 const sourcePath=document?.sources.find(v=>v.id===sourceId)?.path;
 useEffect(()=>{
  if(!sourceId||!sourcePath)return;
  const controller=new AbortController();let cleanup:(()=>void)|undefined;
  Promise.resolve().then(()=>{if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');setParsing(true);setLoading('Loading paper…');window.getSelection()?.removeAllRanges();setPages([]);return studioApi<{url:string}>(`/api/studio/workspaces/${id}/sources/${sourceId}`,{signal:controller.signal});}).then(async({url})=>{const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Could not download the source.');return loadPdfPages(await response.arrayBuffer(),{signal:controller.signal,onProgress:(n,total)=>setLoading(`Rendering ${n} / ${total}…`)});}).then(result=>{
   cleanup=result.dispose;if(controller.signal.aborted){cleanup();return;}setPages(result.pages);setLoading(result.ocrRequiredPages.length?'Scanned pages can be box-selected. OCR is needed for text selection on those pages.':'');
   if(result.truncated)setError(`Only the first ${result.pages.length} of ${result.pageCount} pages are available in this workspace viewer.`);
   const latest=current.current;if(latest){const source=latest.sources.find(x=>x.id===sourceId);if(source&&!source.pages?.length)onChange({...latest,sources:latest.sources.map(x=>x.id===sourceId?{...x,pages:result.textPages}:x)});}
  }).catch(e=>{if(!controller.signal.aborted){setError(e instanceof Error?e.message:'Could not open PDF.');setLoading('Paper could not be opened.');}}).finally(()=>{if(!controller.signal.aborted)setParsing(false);});
  return()=>{controller.abort();cleanup?.();};
 },[id,sourceId,sourcePath,onChange]);
 const pipelineId=document?.pipeline?.jobId;
 const pipelineState=document?.pipeline?.status;
 const pipelineProposal=document?.pipeline?.proposalId;
 useEffect(()=>{
  if(!pipelineId||pipelineProposal||pipelineState==='failed')return;
  let cancelled=false,inFlight=false;
  const check=async()=>{
   if(cancelled||inFlight||operation.current)return;inFlight=true;
   try{const result=await studioApi<{job:{status:string;message:string;progress?:{completedRequired:number;totalRequired:number}}}>(`/api/studio/workspaces/${id}/pipeline`);
    if(cancelled)return;
    setPipelineMessage(`${result.job.message}${result.job.progress?` · ${result.job.progress.completedRequired}/${result.job.progress.totalRequired} required files`:''}`);
    if(['review','complete','failed'].includes(result.job.status)&&!operation.current)await syncPipelineRef.current();
   }catch(e){if(!cancelled)setPipelineMessage(e instanceof Error?e.message:'Could not check build progress.');}finally{inFlight=false;}
  };
  void check();const poll=setInterval(()=>void check(),12000);
  return()=>{cancelled=true;clearInterval(poll);};
 },[id,pipelineId,pipelineProposal,pipelineState]);
 syncPipelineRef.current=async()=>{
  if(operation.current)return;operation.current=true;setBusy(true);
  try{await flush();const result=await studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}/pipeline`,{method:'POST',body:JSON.stringify({revision:server.current!.revision})});
   const late=pending.current;const merged=mergeStudioUpdate(result.workspace.document,late);server.current=result.workspace;pending.current=late?merged:null;setWorkspace(result.workspace);setCurrent(merged);setRefreshVersion(v=>v+1);setStatus(late?'Unsaved changes':'Saved');setPipelineMessage('');if(late)await flush();
  }catch(e){setError(e instanceof Error?e.message:'Could not load the agent result.');}finally{operation.current=false;setBusy(false);}
 };
 async function upload(file:File){
  if(operation.current)return;
  if(file.size>25*1024*1024||!file.name.toLowerCase().endsWith('.pdf')||(file.type&&file.type!=='application/pdf')){setError('Choose a PDF under 25 MB.');return;}setUploading(true);setError('');operation.current=true;
  try{await flush();const result=await studioApi<{source:StudioSource;uploadUrl:string;method:string;headers:Record<string,string>}>(`/api/studio/workspaces/${id}/sources`,{method:'POST',body:JSON.stringify({name:file.name,mimeType:'application/pdf',size:file.size})});const uploaded=await fetch(result.uploadUrl,{method:result.method,headers:result.headers,body:file});if(!uploaded.ok)throw new Error('PDF upload failed. Please retry.');const latest=server.current!.document;const doc={...latest,sources:[...latest.sources,result.source],model:{...latest.model,source:latest.model.source.filename?latest.model.source:{title:file.name,authors:'',filename:file.name}}};setCurrent(doc);pending.current=doc;await flush();setSourceId(result.source.id);}
  catch(e){setError(e instanceof Error?e.message:'Upload failed.');}finally{setUploading(false);operation.current=false;}
 }
 const transact=async(path:string,body:Record<string,unknown>)=>{
  if(operation.current)throw new Error('Wait for the current operation to finish.');
  setBusy(true);setError('');operation.current=true;try{await flush();const result=await studioApi<{workspace:StudioWorkspace}>(`/api/studio/workspaces/${id}/${path}`,{method:'POST',body:JSON.stringify({...body,revision:server.current!.revision})});const late=pending.current;const merged=mergeStudioUpdate(result.workspace.document,late);server.current=result.workspace;setWorkspace(result.workspace);pending.current=late?merged:null;setCurrent(merged);setStatus(late?'Unsaved changes':'Saved');if(late)await flush();return merged;}catch(e){if(e instanceof StudioApiError&&e.body.error==='revision_conflict'){blocked.current=true;setConflict(true);setError(e.message);}throw e;}finally{setBusy(false);operation.current=false;}
 };
 async function exportWorkspace(){setError('');try{await flush();const response=await fetch(`/api/studio/workspaces/${id}/export`);if(!response.ok){const body=await response.json();throw new Error(body.error||'Export failed.');}const url=URL.createObjectURL(await response.blob());const a=window.document.createElement('a');a.href=url;a.download=`${document?.title.replace(/[^a-z0-9-]/gi,'-')||'study'}-handoff.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(e instanceof Error?e.message:'Export failed.');}}
 function downloadUnsaved(){const url=URL.createObjectURL(new Blob([JSON.stringify(current.current,null,2)],{type:'application/json'}));const a=window.document.createElement('a');a.href=url;a.download='unsaved-study-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 if(!workspace||!document)return <div className={s.home}><main><Link href="/build">← Your studies</Link><p>{error||'Loading study…'}</p></main></div>;
 const connected:ConnectedStudio={workspaceId:id,initialDocument:document,pages,sourceId,loading,status,busy:busy||uploading||parsing,agentRunning:Boolean(document.pipeline&&['preparing','queued','running'].includes(document.pipeline.status)),pipelineMessage:pipelineMessage||document.pipeline?.message,sourceControls:<div className={s.sourceControls}><select aria-label="Source document" value={sourceId} onChange={e=>setSourceId(e.target.value)}>{document.sources.length===0&&<option value="">No source yet</option>}{document.sources.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select><label>{uploading?'Uploading…':'+ PDF'}<input disabled={uploading||busy||parsing} type="file" accept="application/pdf" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(file);}}/></label>{document.pipeline&&!document.pipeline.proposalId&&<button disabled={busy||uploading||parsing} onClick={async()=>{try{await transact('pipeline',{action:'retry'});setPipelineMessage('');setRefreshVersion(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'Could not recover build.');}}}>Recover build</button>}{!document.pipeline&&document.sources.length>0&&<button disabled={busy||uploading||parsing} onClick={async()=>{try{await transact('chat',{conversationId:document.activeConversationId||document.conversations[0]?.id||crypto.randomUUID(),requestId:crypto.randomUUID(),text:'Build this study from the uploaded paper. Extract the protocol, materials, variables and analysis; flag all decisions requiring researcher input.',sourceSelection:{sourceId,page:1,rects:[],text:'',kind:'region'}});setRefreshVersion(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'Could not start study build.');}}}>Build study ↗</button>}{loading&&pages.length>0&&<small title={loading}>OCR needed</small>}</div>,onChange,onChat:async request=>{telemetry.track('chat',{action:'send'});return transact('chat',{...request,sourceId});},onProposal:async(proposalId,decision)=>{telemetry.track('review',{action:decision});return transact('proposals',{proposalId,decision});},onExport:()=>void exportWorkspace(),onManage:flush,onLeave:async()=>{await flush();window.location.assign("/build");},onSource:setSourceId};
 return <div className={s.editor}><Workspace key={refreshVersion} studio={connected}/>{(error||telemetry.deliveryError)&&<div className={s.noticeBar} role="alert">{error||telemetry.deliveryError}<button onClick={downloadUnsaved}>Download local draft</button>{conflict?<><button onClick={()=>window.location.reload()}>Reload server version</button></>:error&&<button onClick={()=>{setError('');if(pending.current)void flush().catch(()=>{});}}>{pending.current?'Retry save':'Dismiss'}</button>}</div>}</div>;
}
