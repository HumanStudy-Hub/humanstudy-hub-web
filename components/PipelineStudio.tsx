"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type JobStatus = "queued" | "running" | "review" | "complete" | "failed";
type PipelineProgress = {
  phase: "building_package" | "validating_package" | "ready_for_review" | "timed_out" | "failed";
  completedRequired: number;
  totalRequired: number;
  totalFiles: number;
  missing: string[];
  updatedAt: string;
};
type Job = {
  id: string;
  experimentId: string;
  paperName: string;
  osfUrl?: string;
  currentStage: number;
  status: JobStatus;
  message: string;
  error?: string;
  packageReady?: boolean;
  progress?: PipelineProgress;
  updatedAt: string;
};
type ReviewFile = { path: string; content: string };
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function JsonEditor({ value, onChange, path = "" }: { value: JsonValue; onChange: (value: JsonValue) => void; path?: string }) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const technicalKeys = new Set(["source_trace", "readiness", "coverage_ledger", "derivation_contract", "audit", "selection", "verification"]);
    const entries = Object.entries(value);
    const visible = entries.filter(([key]) => !technicalKeys.has(key));
    const technical = entries.filter(([key]) => technicalKeys.has(key));
    const renderEntry = ([key, child]: [string, JsonValue]) => <div key={key} className="border-l border-gray-200 pl-3"><p className="mb-1 text-xs font-semibold text-gray-700">{key.replaceAll("_", " ")}</p><JsonEditor value={child} path={`${path}.${key}`} onChange={(next) => onChange({ ...(value as Record<string, JsonValue>), [key]: next })} /></div>;
    return <div className="space-y-3">{visible.map(renderEntry)}{technical.length > 0 && <details className="border-t border-gray-200 pt-2"><summary className="cursor-pointer text-xs font-semibold text-gray-500">Technical extraction details</summary><div className="mt-3 space-y-3">{technical.map(renderEntry)}</div></details>}</div>;
  }
  if (Array.isArray(value)) {
    return <div className="space-y-2">{value.map((child, index) => <div key={`${path}.${index}`} className="border-l border-gray-200 pl-3"><p className="mb-1 text-[11px] text-gray-500">Item {index + 1}</p><JsonEditor value={child} path={`${path}.${index}`} onChange={(next) => onChange(value.map((item, itemIndex) => itemIndex === index ? next : item))} /></div>)}</div>;
  }
  const rawValue = value === null ? "" : String(value);
  const placeholder = /^\s*(\[填写\]|tbd|unknown|not available|n\/a)?\s*$/i.test(rawValue);
  return <div><input value={rawValue} onChange={(event) => { const raw = event.target.value; const next = typeof value === "number" ? (raw === "" ? 0 : Number(raw)) : typeof value === "boolean" ? raw === "true" : raw; onChange(next); }} className={`w-full border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-cyan-700 ${placeholder ? "border-amber-400" : "border-gray-300"}`} />{placeholder && <p className="mt-1 text-[11px] text-amber-700">Needs researcher input</p>}</div>;
}

function fileGuide(path: string) {
  if (path.endsWith("/study.json")) return "Study overview, participant flow, conditions, and outcomes";
  if (path.endsWith("/materials/materials.json")) return "Questionnaires, stimuli, instructions, and response formats";
  if (path.endsWith("/task/task.json")) return "Runnable agent interaction and condition assignment";
  if (path.endsWith("/audit/missing_information.json")) return "Decisions or source material that still need researcher input";
  if (path.endsWith("/source/evidence.json")) return "Evidence supporting the extracted study content";
  if (path.endsWith("/source/open_materials.json")) return "OSF, supplementary files, and other sources searched";
  if (path.endsWith("/audit/agent_report.md")) return "Agent summary and recommended review order";
  if (path.endsWith("README.md")) return "Human-readable package documentation";
  return "Supporting study file";
}

const agentTasks = [
  ["Read the paper", "Identify studies, samples, procedures, and reported findings"],
  ["Find open materials", "Search OSF, supplements, repositories, and author pages"],
  ["Build the study", "Organize materials and create the runnable agent task"],
  ["Check the package", "Validate files and flag everything requiring researcher input"],
] as const;

const progressLabels: Record<PipelineProgress["phase"], string> = {
  building_package: "Building study files",
  validating_package: "Checking the runnable package",
  ready_for_review: "Preparing researcher review",
  timed_out: "Agent time limit reached",
  failed: "Package build stopped",
};

export default function PipelineStudio() {
  const STORAGE_KEY = "humanstudy-hub-active-job";
  const fileInput = useRef<HTMLInputElement>(null);
  const [paper, setPaper] = useState<File | null>(null);
  const [osf, setOsf] = useState("");
  const [contributorName, setContributorName] = useState("");
  const [contributorId, setContributorId] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [reviewFiles, setReviewFiles] = useState<ReviewFile[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [editedContent, setEditedContent] = useState("");
  const [editedJson, setEditedJson] = useState<JsonValue | null>(null);
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    const requestedJobId = new URLSearchParams(window.location.search).get("job");
    const savedJobId = requestedJobId || window.localStorage.getItem(STORAGE_KEY);
    if (!savedJobId) return;
    window.localStorage.setItem(STORAGE_KEY, savedJobId);
    fetch(`/api/pipeline/jobs/${savedJobId}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data?.job) { setJob(data.job); setLog(data.log || ""); } else window.localStorage.removeItem(STORAGE_KEY); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (job) window.localStorage.setItem(STORAGE_KEY, job.id);
  }, [job]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/pipeline/jobs/${job.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { job: Job; log: string };
        setJob(data.job);
        setLog(data.log);
        if (data.job.status === "review") {
          const filesResponse = await fetch(`/api/pipeline/jobs/${data.job.id}/files`, { cache: "no-store" });
          if (filesResponse.ok) setReviewFiles((await filesResponse.json()).files);
        }
      } catch {
        // A transient local-server or network interruption is retried on the next poll.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job]);

  useEffect(() => {
    if (!job || job.status !== "review") return;
    fetch(`/api/pipeline/jobs/${job.id}/files`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data?.files) setReviewFiles(data.files); })
      .catch(() => undefined);
  }, [job]);

  function chooseFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF.");
      return;
    }
    setError("");
    setPaper(file);
  }

  async function start() {
    if (!paper) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("paper", paper);
    form.append("osfUrl", osf);
    form.append("contributorName", contributorName);
    form.append("contributorGithub", contributorId);
    try {
      const response = await fetch("/api/pipeline/jobs", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start conversion.");
      setJob(data.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start conversion.");
    } finally {
      setBusy(false);
    }
  }

  async function review(decision: "approved" | "changes_requested") {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline/jobs/${job.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Review could not be saved.");
      setJob(data.job);
      if (decision === "approved") setReviewFiles([]);
      if (decision === "approved") setNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function saveFile() {
    if (!job || !selectedFile) return;
    setBusy(true); setError("");
    try {
      const content = selectedFile.endsWith(".json") ? JSON.stringify(editedJson, null, 2) + "\n" : editedContent;
      const response = await fetch(`/api/pipeline/jobs/${job.id}/files`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: selectedFile, content }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save file.");
      setEditedContent(content);
      setReviewFiles((files) => files.map((file) => file.path === selectedFile ? { ...file, content } : file));
      setSaved(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save file."); }
    finally { setBusy(false); }
  }

  async function publish() {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline/jobs/${job.id}/publish`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save to GitHub.");
      setPrUrl(data.prUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save to GitHub.");
    } finally {
      setBusy(false);
    }
  }

  function exitJob() {
    window.localStorage.removeItem(STORAGE_KEY);
    setJob(null);
    setLog("");
    setReviewFiles([]);
    setSelectedFile("");
    window.history.replaceState({}, "", "/pipeline");
  }

  if (!job) {
    return (
      <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
            <p className="text-xs font-semibold uppercase text-cyan-700">Study builder</p>
            <h1 className="mt-3 max-w-3xl font-serif text-4xl font-bold text-gray-950">Turn a paper into an AI-agent study</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">Upload a paper. The builder completes the extraction, then opens one final review panel for researcher edits.</p>
          </div>
        </header>

        <main className="mx-auto grid max-w-6xl gap-8 px-5 py-9 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="border border-gray-200 bg-white p-6 shadow-sm">
            <div className="border-b border-gray-100 pb-5">
              <p className="text-sm font-semibold text-gray-950">Source material</p>
              <p className="mt-1 text-sm text-gray-500">Only the published paper is required.</p>
            </div>

            <div className="mt-5 border border-cyan-200 bg-cyan-50 p-4">
              <p className="text-sm font-semibold text-cyan-950">Already have a study ZIP?</p>
              <p className="mt-1 text-xs leading-5 text-cyan-900">Upload a previously downloaded package to contribute it without extracting the paper again.</p>
              <a href="/contribute" className="mt-3 inline-flex h-9 items-center bg-cyan-700 px-4 text-xs font-semibold text-white hover:bg-cyan-600">Upload existing ZIP</a>
            </div>

            <button type="button" onClick={() => fileInput.current?.click()} className={`mt-6 flex min-h-48 w-full flex-col items-center justify-center border border-dashed px-6 text-center ${paper ? "border-emerald-300 bg-emerald-50" : "border-gray-300 bg-gray-50 hover:border-cyan-500"}`}>
              <span className="text-sm font-semibold text-gray-900">{paper?.name || "Choose a paper PDF"}</span>
              <span className="mt-2 text-xs text-gray-500">{paper ? `${(paper.size / 1024 / 1024).toFixed(1)} MB` : "PDF, up to 50 MB"}</span>
            </button>
            <input ref={fileInput} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(event) => chooseFile(event.target.files?.[0])} />

            <label className="mt-6 block text-sm font-semibold text-gray-900" htmlFor="osf-url">Open materials <span className="font-normal text-gray-400">optional</span></label>
            <input id="osf-url" value={osf} onChange={(event) => setOsf(event.target.value)} placeholder="https://osf.io/..." className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="contributor-name">Contributor name</label>
                <input id="contributor-name" value={contributorName} onChange={(event) => setContributorName(event.target.value)} className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="contributor-id">GitHub ID <span className="font-normal text-gray-400">optional</span></label>
                <input id="contributor-id" value={contributorId} onChange={(event) => setContributorId(event.target.value.replace(/^@/, ""))} className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
              </div>
            </div>

            {error && <p className="mt-5 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            <div className="mt-7 flex justify-end border-t border-gray-100 pt-5">
              <div className="flex flex-col items-end gap-3 sm:flex-row sm:items-center">
                <a href="https://github.com/HumanStudy-Hub/HumanStudy-Bench/blob/main/docs/submit_study.md" target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-cyan-700 hover:underline">Contribute manually on GitHub</a>
                <button type="button" disabled={!paper || !contributorName.trim() || busy} onClick={start} className="h-10 bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300">
                  {busy ? "Uploading..." : "Start conversion"}
                </button>
              </div>
            </div>
          </section>

          <aside>
            <p className="text-xs font-semibold uppercase text-gray-500">Agent workflow</p>
            <ol className="mt-4 border-l border-gray-300">
              {agentTasks.map(([label, detail], index) => (
                <li key={label} className="relative pb-7 pl-6">
                  <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-[11px] font-bold">{index + 1}</span>
                  <p className="text-sm font-semibold text-gray-800">{label}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{detail}</p>
                </li>
              ))}
            </ol>
          </aside>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white px-5 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-950">{job.paperName}</p>
            <p className="mt-1 font-mono text-xs text-gray-500">{job.experimentId.startsWith("draft_") ? "Draft study" : `studies/${job.experimentId}/`}</p>
          </div>
          <div className="flex items-center gap-3"><Link href="/" className="text-xs font-semibold text-gray-500 hover:text-gray-950">Back to Hub</Link><button type="button" onClick={exitJob} className="text-xs font-semibold text-cyan-700 hover:text-cyan-900">Start another study</button><span className={`px-2 py-1 text-xs font-semibold ${job.status === "failed" ? "bg-red-100 text-red-800" : job.status === "complete" ? "bg-emerald-100 text-emerald-800" : job.status === "review" ? "bg-amber-100 text-amber-800" : "bg-cyan-100 text-cyan-800"}`}>{job.status}</span></div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav className="border border-gray-200 bg-white p-3">
          <p className="px-3 pb-2 pt-1 text-[10px] font-bold uppercase text-gray-500">Agent workflow</p>
          {agentTasks.map(([label, detail]) => (
            <div key={label} className="flex gap-3 p-3">
              <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${job.status === "failed" ? "bg-gray-300" : job.status === "review" || job.status === "complete" ? "bg-emerald-600" : "animate-pulse bg-cyan-700"}`} />
              <div><p className="text-xs font-semibold">{label}</p><p className="mt-1 text-[11px] leading-4 text-gray-500">{detail}</p></div>
            </div>
          ))}
        </nav>

        <section className="min-w-0 border border-gray-200 bg-white">
          <div className="border-b border-gray-200 p-6">
            <p className="text-xs font-semibold uppercase text-cyan-700">Agent study builder</p>
            <h1 className="mt-2 font-serif text-2xl font-bold">{job.message}</h1>
            <p className="mt-2 text-sm text-gray-500">Progress and review decisions are saved under job {job.id}.</p>
          </div>

          {(job.status === "running" || job.status === "queued") && (
            <div className="p-6">
              {job.progress ? <>
                <div className="flex items-end justify-between gap-4">
                  <div><p className="text-sm font-semibold text-gray-950">{progressLabels[job.progress.phase]}</p><p className="mt-1 text-xs text-gray-500">{job.progress.completedRequired} of {job.progress.totalRequired} required files · {job.progress.totalFiles} total files</p></div>
                  <p className="font-mono text-sm font-semibold text-cyan-800">{Math.round((job.progress.completedRequired / Math.max(1, job.progress.totalRequired)) * 100)}%</p>
                </div>
                <div className="mt-3 h-2 overflow-hidden bg-gray-100"><div className="h-full bg-cyan-700 transition-[width] duration-500" style={{ width: `${Math.min(100, (job.progress.completedRequired / Math.max(1, job.progress.totalRequired)) * 100)}%` }} /></div>
                {job.progress.missing.length > 0 && <details className="mt-4 border-t border-gray-200 pt-3"><summary className="cursor-pointer text-xs font-semibold text-gray-600">Remaining required files ({job.progress.missing.length})</summary><ul className="mt-2 grid gap-1 sm:grid-cols-2">{job.progress.missing.map((file) => <li key={file} className="break-all font-mono text-[11px] text-gray-500">{file}</li>)}</ul></details>}
              </> : <div className="h-1.5 overflow-hidden bg-gray-100"><div className="h-full w-1/2 animate-pulse bg-cyan-700" /></div>}
              <p className="mt-4 text-sm leading-6 text-gray-600">The agent is reading the paper, {job.osfUrl ? "processing the supplied open materials, " : ""}building the study files, and running package checks. You can leave this page and return to the same job.</p>
              {log && <pre className="mt-5 max-h-80 overflow-auto bg-gray-950 p-4 text-xs leading-5 text-gray-200">{log}</pre>}
            </div>
          )}

          {job.status === "review" && (
            <div className="p-6">
              <div className="border-l-2 border-amber-500 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                Review the extracted study and materials. Correct inaccurate values, resolve highlighted missing information when possible, then approve the package for download.
              </div>
              <div className="mt-6 space-y-4">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Final study package review</p>
                  <p className="mt-1 text-sm text-gray-500">Choose a file to inspect. Edit only values that are missing or incorrect, then save before approving.</p>
                  <div className="mt-3 border-l-2 border-cyan-700 bg-cyan-50 p-3 text-xs leading-5 text-cyan-950">Start with the study overview, materials, task definition, and missing-information checklist. Supporting evidence and technical records are available under Additional files.</div>
                </div>
                {reviewFiles.length === 0 ? <p className="border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">Loading generated files...</p> : <div className="grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
                  <div className="border border-gray-200 bg-gray-50 p-2">
                    {(() => {
                      const priorityPaths = ["/study.json", "/materials/materials.json", "/task/task.json", "/audit/missing_information.json", "/audit/agent_report.md"];
                      const priority = reviewFiles.filter((file) => priorityPaths.some((suffix) => file.path.endsWith(suffix)));
                      const additional = reviewFiles.filter((file) => !priority.includes(file));
                      const fileButton = (file: ReviewFile) => <button key={file.path} onClick={() => { setSelectedFile(file.path); setEditedContent(file.content); setEditedJson(file.path.endsWith(".json") ? JSON.parse(file.content) : null); setSaved(true); }} className={`block w-full border-l-2 px-3 py-2 text-left ${selectedFile === file.path ? "border-cyan-700 bg-white text-cyan-800" : "border-transparent text-gray-600 hover:bg-white"}`}><span className="block break-all font-mono text-xs font-semibold">{file.path}</span><span className="mt-1 block text-[11px] leading-4 text-gray-500">{fileGuide(file.path)}</span></button>;
                      return <><p className="px-3 pb-2 pt-1 text-[10px] font-bold uppercase tracking-wide text-cyan-800">Review first</p>{priority.map(fileButton)}<details className="mt-2 border-t border-gray-200 pt-2"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-600">Additional files ({additional.length})</summary>{additional.map(fileButton)}</details></>;
                    })()}
                  </div>
                  <div className="min-w-0 border border-gray-200">
                    {selectedFile ? <><div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2"><div><span className="font-mono text-xs font-semibold text-gray-700">{selectedFile}</span>{!saved && <span className="ml-3 text-xs text-amber-700">Unsaved changes</span>}</div><button disabled={busy || saved} onClick={saveFile} className="h-8 bg-cyan-700 px-3 text-xs font-semibold text-white disabled:bg-gray-300">{busy ? "Saving..." : saved ? "Saved" : "Save changes"}</button></div>{selectedFile.endsWith(".json") && editedJson !== null ? <div className="max-h-[34rem] space-y-4 overflow-auto p-4"><JsonEditor value={editedJson} onChange={(next) => { setEditedJson(next); setSaved(false); }} /></div> : <textarea value={editedContent} onChange={(event) => { setEditedContent(event.target.value); setSaved(false); }} spellCheck={false} className="min-h-[28rem] w-full resize-y p-4 font-mono text-xs leading-5 text-gray-700 outline-none focus:ring-2 focus:ring-cyan-700" />}</> : <p className="p-6 text-sm text-gray-500">Select a file to inspect and edit.</p>}
                  </div>
                </div>}
              </div>
              <label htmlFor="review-note" className="mt-6 block text-sm font-semibold">Review note</label>
              <textarea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 h-32 w-full border border-gray-300 p-3 text-sm outline-none focus:border-cyan-700" placeholder="Corrections, missing evidence, or approval rationale" />
              <div className="mt-4 flex justify-end gap-2">
                <button disabled={busy || !note.trim()} onClick={() => review("changes_requested")} className="h-10 border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:text-gray-300">Request changes</button>
                <button disabled={busy || !saved} onClick={() => review("approved")} className="h-10 bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-300">Approve package</button>
              </div>
            </div>
          )}

          {job.status === "failed" && (
            <div className="p-6">
              <p className="border-l-2 border-red-600 bg-red-50 p-4 text-sm text-red-900">{job.error || "The pipeline failed."}</p>
              <pre className="mt-5 max-h-80 overflow-auto bg-gray-950 p-4 text-xs leading-5 text-gray-200">{log}</pre>
            </div>
          )}

          {job.status === "complete" && (
            <div className="p-6">
              {job.packageReady ? <><div className="border-l-2 border-emerald-600 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">The reviewed HumanStudy-Bench package is ready for download and can be used by the Run Experiment workspace.</div><div className="mt-5 flex flex-wrap gap-2"><a href={`/api/pipeline/jobs/${job.id}/download`} className="inline-flex h-10 items-center bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600">Download experiment ZIP</a><button disabled={busy || Boolean(prUrl)} onClick={publish} className="h-10 border border-gray-300 bg-white px-5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:text-gray-400">{busy ? "Saving..." : prUrl ? "Contributed to benchmark" : "Contribute this study to benchmark"}</button></div>{prUrl && <a href={prUrl} target="_blank" rel="noreferrer" className="mt-4 block text-sm font-semibold text-cyan-700 hover:underline">Open pull request</a>}</> : <div className="border-l-2 border-cyan-700 bg-cyan-50 p-4 text-sm leading-6 text-cyan-950">The extraction is saved, but the study is not yet a runnable package.</div>}
            </div>
          )}

          {error && <p className="mx-6 mb-6 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        </section>
      </main>
    </div>
  );
}
