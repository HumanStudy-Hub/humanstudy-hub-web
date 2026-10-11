'use client';
import { useEffect, useRef } from 'react';
import { parseView, VIEW_BRIDGE } from '@/lib/studio/views';
import s from './view-artifact.module.css';

export type GeneratedView = { id:string; template?:string; request?:string; label:string; note:string; title:string; html:string; done:boolean; error?:string };

/** Generates a view by streaming from /api/studio/views, then shows it in an isolated iframe.
 * Scripts run, but the frame has no same-origin access; it can only report clicks on program ids. */
export function useViewGeneration(views:GeneratedView[],update:(id:string,patch:Partial<GeneratedView>)=>void,payload:{program:unknown;studyId?:string}){
 const started=useRef(new Set<string>()),latest=useRef(payload);
 useEffect(()=>{latest.current=payload;});
 useEffect(()=>{
  for(const view of views){
   if(view.done||view.error||started.current.has(view.id))continue;
   started.current.add(view.id);
   void (async()=>{
    try{
     const response=await fetch('/api/studio/views',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...latest.current,template:view.template,request:view.request})});
     if(!response.ok||!response.body){const detail=await response.json().catch(()=>({}));throw new Error(detail.error==='views_not_configured'?'View generation is not configured (OPENROUTER_API_KEY).':`Could not generate the view (${detail.error||response.status}).`);}
     const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
     for(;;){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});const p=parseView(text);update(view.id,{note:p.note,title:p.title,html:p.html});}
     const p=parseView(text);
     if(!p.html)throw new Error(p.note||'The model returned no view.');
     update(view.id,{note:p.note,title:p.title,html:p.html,done:true});
    }catch(error){update(view.id,{error:error instanceof Error?error.message:'Could not generate the view.'});}
   })();
  }
 },[views,update]);
}

export default function ViewArtifact({view,knownIds,onPick,onRetry}:{view:GeneratedView;knownIds:ReadonlySet<string>;onPick:(id:string)=>void;onRetry:()=>void}){
 const frame=useRef<HTMLIFrameElement>(null);
 useEffect(()=>{
  const listen=(event:MessageEvent)=>{if(event.source!==frame.current?.contentWindow||event.data?.type!=='program-view-pick')return;const id=String(event.data.id);if(knownIds.has(id))onPick(id);};
  window.addEventListener('message',listen);return()=>window.removeEventListener('message',listen);
 },[knownIds,onPick]);
 return <div className={s.view}>
  <header><div><strong>{view.title||view.label}</strong><small>{view.error?'Failed':view.done?'AI-made view · check it against the protocol':'Generating…'}</small></div>{(view.done||view.error)&&<button onClick={onRetry}>Regenerate</button>}</header>
  {view.note&&<p className={s.note}>{view.note}</p>}
  {view.error?<p className={s.error}>{view.error}</p>
  :view.done?<iframe ref={frame} title={view.title||view.label} sandbox="allow-scripts" srcDoc={VIEW_BRIDGE+view.html}/>
  :<pre className={s.code} aria-live="polite">{view.html.slice(-3000)||'Waiting for the model…'}</pre>}
 </div>;
}
