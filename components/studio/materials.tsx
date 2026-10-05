"use client";
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StudioArtifact } from '@/lib/studio/types';
import { useT } from '@/app/build-preview/ui';
import s from './materials.module.css';

export default function Materials({artifacts,onDiscuss}:{artifacts:StudioArtifact[];onDiscuss:(artifact:StudioArtifact)=>void}){
 const t=useT(),[active,setActive]=useState('');
 const artifact=artifacts.find(item=>item.id===active)||artifacts[0];
 function download(item:StudioArtifact){
  const url=URL.createObjectURL(new Blob([item.content],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=item.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <div className={s.materials} data-event="materials.panel">
  {!artifact?<div className={s.empty}><h2>{t('Study materials')}</h2><p>{t('Ask the agent to draft instructions, a questionnaire or an analysis plan.')}</p></div>:<>
   <nav aria-label={t('Study materials')}>{artifacts.map(item=><button key={item.id} aria-pressed={artifact.id===item.id} onClick={()=>setActive(item.id)}><span>{item.title}</span><small>{item.filename}</small></button>)}</nav>
   <header><div><h2>{artifact.title}</h2><small>{t('Research draft')} · {artifact.format}</small></div><button onClick={()=>onDiscuss(artifact)}>{t('Discuss with AI ↗')}</button><button aria-label={t('Download material')} onClick={()=>download(artifact)}>↓</button></header>
   <article>{artifact.format==='markdown'?<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:({alt})=><span>{alt}</span>}}>{artifact.content}</ReactMarkdown>:<pre>{artifact.content}</pre>}</article>
  </>}
 </div>;
}
