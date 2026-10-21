"use client";
import { useEffect, useState, type FormEvent } from "react";
import { upload } from "@vercel/blob/client";
import JSZip from "jszip";
import Link from "next/link";

type Metadata = { paperId?: string; baseRevision?: string; includesPdf?: boolean; paper: { title: string; firstAuthor: string; authors?: string[]; year: number; doi?: string } };
export default function ContributeUploadForm() {
  const [user,setUser]=useState<{id:string}|null>(null),[checked,setChecked]=useState(false);
  const [file,setFile]=useState<File|null>(null),[metadata,setMetadata]=useState<Metadata|null>(null);
  const [name,setName]=useState(""),[affiliation,setAffiliation]=useState("");
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
  const [error,setError]=useState(""),[submitted,setSubmitted]=useState(false);
  useEffect(()=>{fetch('/api/studio/auth').then(r=>r.json()).then(body=>setUser(body.user||null)).catch(()=>setUser(null)).finally(()=>setChecked(true))},[]);
  async function choose(next:File|undefined){
    setError("");setMetadata(null);setFile(null);setSubmitted(false);
    if(!next)return;
    if(!next.name.toLowerCase().endsWith('.zip')||next.size>40*1024*1024){setError('Choose a community ZIP no larger than 40 MB.');return}
    try{
      const zip=await JSZip.loadAsync(next);
      const entry=zip.file('CONTRIBUTION.json');
      if(!entry)throw Error('Ask the study agent to export a community contribution, then select that ZIP.');
      const meta=JSON.parse(await entry.async('string')) as Metadata;
      if(!meta.paper?.title||!meta.paper.firstAuthor||!Number.isInteger(meta.paper.year))throw Error('The export needs the paper title, author and year. Ask the study agent to check its paper metadata and export again.');
      setMetadata(meta);setFile(next);
    }catch(e){setError(e instanceof Error?e.message:'The contribution could not be read.')}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(!user||!file||!metadata)return;
    setBusy(true);setProgress(0);setError("");
    try{
      const blob=await upload(`community/${user.id}/contribution.zip`,file,{access:'private',handleUploadUrl:'/api/community/upload-url',multipart:file.size>8*1024*1024,onUploadProgress:({percentage})=>setProgress(percentage)});
      setProgress(null);
      const response=await fetch('/api/community/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({blobPathname:blob.pathname,paperMeta:metadata.paper,paperId:metadata.paperId,baseRevision:metadata.baseRevision,includesPdf:metadata.includesPdf===true,contributor:{name,affiliation},slug:'research-contribution'})});
      const result=await response.json();if(!response.ok)throw Error(result.message||'The contribution could not be submitted.');
      setSubmitted(true);
    }catch(e){setError(e instanceof Error?e.message:'The contribution could not be submitted.')}
    finally{setBusy(false);setProgress(null)}
  }
  if(!checked)return <p className="text-sm text-gray-600">Checking sign-in…</p>;
  if(!user)return <p className="text-sm text-gray-700"><Link href="/build/projects" className="font-semibold text-cyan-700 underline">Sign in to HumanStudy Hub</Link> to contribute. A GitHub account is optional.</p>;
  if(submitted)return <p role="status" className="text-sm leading-6 text-cyan-900">Contribution submitted. The source checks and review run in the background; the current recommended version stays available.</p>;
  return <form onSubmit={submit} className="space-y-4">
    <input aria-label="Your name" required value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
    <input aria-label="Affiliation" value={affiliation} onChange={e=>setAffiliation(e.target.value)} placeholder="Affiliation (optional)" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
    <label className="block rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-700">
      Community contribution ZIP
      <input aria-label="Community contribution ZIP" type="file" accept=".zip" disabled={busy} onChange={e=>void choose(e.target.files?.[0])} className="mt-3 block w-full text-sm" />
    </label>
    {metadata&&<p className="text-sm text-gray-700">{metadata.paper.title} ({metadata.paper.year})</p>}
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    <button disabled={!file||busy||!name.trim()} className="w-full rounded-md bg-cyan-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy?progress!==null?`Uploading ${Math.round(progress)}%`:'Submitting…':'Contribute'}</button>
  </form>;
}
