"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { upload } from "@vercel/blob/client";
import JSZip from "jszip";
import Link from "next/link";
import {
  CONTRIBUTION_METADATA, CONTRIBUTION_PROGRAM, MAX_CONTRIBUTION_ZIP_BYTES,
  contributionPathKey, contributionPathProblem, ignorableContributionPath,
} from "@/lib/community-archive";

type Metadata = { files?: {path: string; license?: string}[]; paperId?: string; baseRevision?: string; includesPdf?: boolean; paper: { title: string; firstAuthor: string; authors?: string[]; year: number; doi?: string } };
export default function ContributeUploadForm() {
  const [user,setUser]=useState<{id:string}|null>(null),[checked,setChecked]=useState(false);
  const [file,setFile]=useState<File|null>(null),[metadata,setMetadata]=useState<Metadata|null>(null);
  const [inventory,setInventory]=useState<{path: string; license?: string}[]>([]);
  const selection=useRef(0);
  const [name,setName]=useState(""),[affiliation,setAffiliation]=useState("");
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
  const [error,setError]=useState(""),[submitted,setSubmitted]=useState<{id: string; prUrl?: string} | null>(null);
  const [creditStatus,setCreditStatus]=useState<{ status: string; contributorId: string | null } | null>(null);
  useEffect(()=>{fetch('/api/studio/auth').then(r=>r.json()).then(body=>setUser(body.user||null)).catch(()=>setUser(null)).finally(()=>setChecked(true))},[]);
  async function choose(next: File | undefined) {
    const currentSelection = ++selection.current;
    setError("");
    setMetadata(null);
    setFile(null);
    setInventory([]);
    setSubmitted(null);
    setCreditStatus(null);
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".zip") || next.size > MAX_CONTRIBUTION_ZIP_BYTES) {
      setError("Choose a community ZIP no larger than 40 MB.");
      return;
    }
    try {
      const zip = await JSZip.loadAsync(next);
      const entry = zip.file(CONTRIBUTION_METADATA);
      if (!entry) throw Error("Ask the study agent to export a community contribution, then select that ZIP.");
      const meta = JSON.parse(await entry.async("string")) as Metadata;
      if (typeof meta?.paper?.title !== "string" || !meta.paper.title.trim() ||
          typeof meta.paper.firstAuthor !== "string" || !meta.paper.firstAuthor.trim() || !Number.isInteger(meta.paper.year)) {
        throw Error("The export needs the paper title, author and year. Ask the study agent to check its paper metadata and export again.");
      }

      const entries = Object.values(zip.files).filter(item => !item.dir);
      const paths = entries.map(item => item.unsafeOriginalName ?? item.name).filter(path => !ignorableContributionPath(path));
      if (!paths.includes(CONTRIBUTION_PROGRAM)) throw Error("The ZIP needs program.json. Export the study again.");
      if (paths.length > 2000 || new Set(paths.map(contributionPathKey)).size !== paths.length) {
        throw Error("The ZIP contains too many files or duplicate paths. Export the study again.");
      }
      for (const path of paths) {
        const problem = contributionPathProblem(path, meta.includesPdf === true);
        if (problem) throw Error(problem);
      }

      const licenses = new Map<string, string>();
      if (Array.isArray(meta.files)) {
        for (const item of meta.files) {
          if (typeof item?.path === "string" && typeof item.license === "string" && item.license.length <= 200) {
            licenses.set(item.path, item.license);
          }
        }
      }
      if (currentSelection !== selection.current) return;
      setInventory(paths.filter(path => path !== CONTRIBUTION_METADATA).sort().map(path => ({ path, license: licenses.get(path) })));
      setMetadata(meta);
      setFile(next);
    } catch (error) {
      if (currentSelection === selection.current) setError(error instanceof Error ? error.message : "The contribution could not be read.");
    }
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(!user||!file||!metadata)return;
    setBusy(true);setProgress(0);setError("");
    try{
      const blob=await upload(`community/${user.id}/contribution.zip`,file,{access:'private',handleUploadUrl:'/api/community/upload-url',multipart:file.size>8*1024*1024,onUploadProgress:({percentage})=>setProgress(percentage)});
      setProgress(null);
      const response=await fetch('/api/community/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({blobPathname:blob.pathname,paperMeta:metadata.paper,paperId:metadata.paperId,baseRevision:metadata.baseRevision,includesPdf:metadata.includesPdf===true,contributor:{name,affiliation},slug:'research-contribution'})});
      const result=await response.json();if(!response.ok)throw Error(result.message||'The contribution could not be submitted.');
      setSubmitted({ id: result.id, prUrl: result.prUrl });
    }catch(e){setError(e instanceof Error?e.message:'The contribution could not be submitted.')}
    finally{setBusy(false);setProgress(null)}
  }
  async function refreshCredit() {
    if (!submitted || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/community/mine", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: submitted.id }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message || "Contribution status is temporarily unavailable.");
      setCreditStatus(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Contribution status is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }
  if(!checked)return <p className="text-sm text-[var(--site-muted)]">Checking sign-in…</p>;
  if(!user)return <p className="text-sm text-[var(--foreground)]"><Link href="/build/projects" className="font-semibold text-[var(--site-accent)] underline">Sign in to HumanStudy Hub</Link> to contribute. A GitHub account is optional.</p>;
  if (submitted) return <div className="space-y-2 text-sm leading-6">
    <p role="status"><strong>User submitted.</strong>{" "}
      {creditStatus?.contributorId
        ? <Link href={`/contributors/${creditStatus.contributorId}`} className="text-[var(--site-accent)] underline">View your public contribution credit</Link>
        : creditStatus?.status === "merged" ? "Public credit is pending verification."
        : creditStatus?.status === "rejected" ? "The submission was closed."
        : creditStatus?.status === "changes_requested" ? "A reviewer requested changes."
        : creditStatus?.status === "checks_failed" ? "The submission checks need attention."
        : "Source checks and review are pending."}
    </p>
    <div className="flex flex-wrap gap-4 text-[var(--site-accent)]">
      {submitted.prUrl && <a href={submitted.prUrl} className="underline">View submission</a>}
      {!creditStatus?.contributorId && <button type="button" className="cursor-pointer underline" disabled={busy}
        onClick={() => void refreshCredit()}>{busy ? "Checking…" : "Check status"}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
  return <form onSubmit={submit} className="space-y-4">
    <input aria-label="Your name" required disabled={busy} value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" className="w-full rounded-md border border-[var(--site-line)] px-3 py-2 text-sm" />
    <input aria-label="Affiliation" disabled={busy} value={affiliation} onChange={e=>setAffiliation(e.target.value)} placeholder="Affiliation (optional)" className="w-full rounded-md border border-[var(--site-line)] px-3 py-2 text-sm" />
    <label className="block rounded-xl border border-dashed border-[var(--site-line)] bg-[var(--site-surface)] p-6 text-sm text-[var(--foreground)]">
      Community contribution ZIP
      <input aria-label="Community contribution ZIP" type="file" accept=".zip" disabled={busy} onChange={e=>void choose(e.target.files?.[0])} className="mt-3 block w-full text-sm" />
    </label>
    {metadata && <div className="space-y-3 text-sm leading-6">
      <p>
        <strong>{metadata.paper.title}</strong> ({metadata.paper.year})<br />
        Original paper authors: {Array.isArray(metadata.paper.authors)
          ? metadata.paper.authors.filter(author => typeof author === "string" && author.trim()).join(", ") || metadata.paper.firstAuthor
          : metadata.paper.firstAuthor}
      </p>
      <p className="text-[var(--site-muted)]">
        Only the selected research files will be published. Review them before submitting.
        {" "}Your name and optional affiliation will appear in the public contribution credit.
      </p>
      <details className="rounded-md border border-[var(--site-line)] px-3">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium text-[var(--site-accent)]">
          <span aria-hidden="true">›</span> Files to publish ({inventory.length})
        </summary>
        <ul className="max-h-64 list-disc space-y-1 overflow-auto break-all pb-3 pl-5">
          {inventory.map(({ path, license }) => <li key={path}>
            <code>{path}</code>{license && <span className="ml-2 text-[var(--site-muted)]">Declared license · {license}</span>}
          </li>)}
        </ul>
      </details>
      {inventory.some(item => /\.pdf$/i.test(item.path)) && (
        <p className="text-[var(--site-muted)]">By submitting, you confirm that you have permission to publish the included PDFs.</p>
      )}
    </div>}
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    <button disabled={!file||busy||!name.trim()} className="w-full rounded-md bg-[var(--site-accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy?progress!==null?`Uploading ${Math.round(progress)}%`:'Submitting…':'Contribute'}</button>
  </form>;
}
