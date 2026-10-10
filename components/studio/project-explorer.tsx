"use client";
import { useEffect,useRef,useState } from 'react';
import type { StudioDocument,StudioProjectSummary } from '@/lib/studio/types';
import { studioApi } from './client';
import s from './projects.module.css';
export default function ProjectExplorer({id,document,onNavigate,onSource,onProgram,onMaterial,onConversation,onSettings,onFork,onRename,busy}:{id:string;document:StudioDocument;onNavigate:(href:string)=>Promise<void>;onSource:(id:string)=>void;onProgram:()=>void;onMaterial:(id:string)=>void;onConversation:(id:string)=>void;onSettings:()=>void;onFork:()=>void;onRename:()=>void;busy:boolean}){
 const [projects,setProjects]=useState<StudioProjectSummary[]>([]),[query,setQuery]=useState(''),[error,setError]=useState('');const search=useRef<HTMLInputElement>(null);
 useEffect(()=>{let cancelled=false;studioApi<{workspaces:StudioProjectSummary[]}>('/api/studio/workspaces').then(r=>{if(!cancelled)setProjects(r.workspaces);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[]);
 useEffect(()=>{const focus=()=>search.current?.focus();window.addEventListener('humanstudy-find-project',focus);return()=>window.removeEventListener('humanstudy-find-project',focus);},[]);
 const directory=projects.some(p=>p.id===id)?projects:[{id,title:document.title,revision:1,created_at:'',updated_at:'',project:document.project},...projects];
 const navigate=(href:string)=>{if(busy)return;void onNavigate(href).catch(e=>setError(e.message));};
 return <aside className={s.explorer} aria-label="Project explorer">
  <header><strong>Projects</strong><button aria-label="New project" disabled={busy} onClick={()=>navigate('/build?new=1')}>＋</button></header>
  <input ref={search} aria-label="Find a project" placeholder="Find a project…" value={query} onChange={e=>setQuery(e.target.value)}/>
  <nav aria-label="Project directory">{directory.filter(p=>(p.id===id||!p.project?.archived)&&p.title.toLowerCase().includes(query.toLowerCase())).map(p=><div key={p.id}><button disabled={busy} aria-current={p.id===id?'page':undefined} onClick={()=>navigate(`/build/${p.id}`)}>{p.id===id?'▾':'▸'} {p.id===id?document.title:p.title}</button>{p.id===id&&<div className={s.fileTree}><button onClick={onProgram}>Human Program</button><details open><summary>Resources <span>{document.sources.length}</span></summary>{document.sources.map(source=><button key={source.id} onClick={()=>onSource(source.id)}>{source.name}</button>)}</details><details><summary>Materials <span>{document.artifacts?.length||0}</span></summary>{document.artifacts?.map(artifact=><button key={artifact.id} onClick={()=>onMaterial(artifact.id)}>{artifact.filename}</button>)}</details><details><summary>Conversations <span>{document.conversations.length}</span></summary>{document.conversations.map(c=><button key={c.id} onClick={()=>onConversation(c.id)}>{c.title||'New conversation'}</button>)}</details></div>}</div>)}</nav>
  {error&&<p role="alert" className={s.muted}>{error}</p>}
  <footer><button disabled={busy} onClick={onRename}>Rename project</button><button disabled={busy} onClick={onFork}>Fork project</button><button disabled={busy} onClick={()=>navigate('/build')}>All projects</button><button onClick={onSettings}>Settings</button></footer>
 </aside>;
}
