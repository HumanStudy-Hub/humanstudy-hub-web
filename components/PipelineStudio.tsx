"use client";

import { useEffect, useRef, useState } from "react";

type JobStatus = "queued" | "running" | "review" | "complete" | "failed";
type Job = {
  id: string;
  experimentId: string;
  paperName: string;
  osfUrl?: string;
  currentStage: number;
  status: JobStatus;
  message: string;
  error?: string;
  updatedAt: string;
};

const stages = [
  ["Study inventory", "Map studies, samples, and comparison groups"],
  ["Findings & effects", "Extract claims, statistics, and source evidence"],
  ["Study materials", "Recover surveys, stimuli, and instructions"],
  ["Build package", "Assemble the runnable benchmark folder"],
] as const;

export default function PipelineStudio() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [paper, setPaper] = useState<File | null>(null);
  const [osf, setOsf] = useState("");
  const [experimentId, setExperimentId] = useState("study_new");
  const [contributorName, setContributorName] = useState("");
  const [contributorId, setContributorId] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prUrl, setPrUrl] = useState("");

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/pipeline/jobs/${job.id}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { job: Job; log: string };
      setJob(data.job);
      setLog(data.log);
    }, 2000);
    return () => window.clearInterval(timer);
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
    form.append("experimentId", experimentId);
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
      setJob({ ...data.job, status: decision === "approved" ? "queued" : "review" });
      if (decision === "approved") setNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review could not be saved.");
    } finally {
      setBusy(false);
    }
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

  if (!job) {
    return (
      <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
            <p className="text-xs font-semibold uppercase text-cyan-700">Study builder</p>
            <h1 className="mt-3 max-w-3xl font-serif text-4xl font-bold text-gray-950">Turn a paper into an AI-agent study</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">Upload a paper. The builder runs the HumanStudy-Bench pipeline and pauses after each stage for researcher review.</p>
          </div>
        </header>

        <main className="mx-auto grid max-w-6xl gap-8 px-5 py-9 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="border border-gray-200 bg-white p-6 shadow-sm">
            <div className="border-b border-gray-100 pb-5">
              <p className="text-sm font-semibold text-gray-950">Source material</p>
              <p className="mt-1 text-sm text-gray-500">Only the published paper is required.</p>
            </div>

            <button type="button" onClick={() => fileInput.current?.click()} className={`mt-6 flex min-h-48 w-full flex-col items-center justify-center border border-dashed px-6 text-center ${paper ? "border-emerald-300 bg-emerald-50" : "border-gray-300 bg-gray-50 hover:border-cyan-500"}`}>
              <span className="text-sm font-semibold text-gray-900">{paper?.name || "Choose a paper PDF"}</span>
              <span className="mt-2 text-xs text-gray-500">{paper ? `${(paper.size / 1024 / 1024).toFixed(1)} MB` : "PDF, up to 50 MB"}</span>
            </button>
            <input ref={fileInput} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(event) => chooseFile(event.target.files?.[0])} />

            <label className="mt-6 block text-sm font-semibold text-gray-900" htmlFor="osf-url">Open materials <span className="font-normal text-gray-400">optional</span></label>
            <input id="osf-url" value={osf} onChange={(event) => setOsf(event.target.value)} placeholder="https://osf.io/..." className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />

            <label className="mt-6 block text-sm font-semibold text-gray-900" htmlFor="experiment-id">Experiment ID</label>
            <div className="mt-2 flex h-10 border border-gray-300">
              <span className="flex items-center border-r border-gray-200 bg-gray-50 px-3 font-mono text-xs text-gray-500">studies/</span>
              <input id="experiment-id" value={experimentId} onChange={(event) => setExperimentId(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))} className="min-w-0 flex-1 px-3 font-mono text-sm outline-none" />
            </div>

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
                <button type="button" disabled={!paper || !experimentId || !contributorName.trim() || busy} onClick={start} className="h-10 bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300">
                  {busy ? "Uploading..." : "Start conversion"}
                </button>
              </div>
            </div>
          </section>

          <aside>
            <p className="text-xs font-semibold uppercase text-gray-500">Researcher checkpoints</p>
            <ol className="mt-4 border-l border-gray-300">
              {stages.map(([label, detail], index) => (
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
            <p className="mt-1 font-mono text-xs text-gray-500">studies/{job.experimentId}/</p>
          </div>
          <span className={`px-2 py-1 text-xs font-semibold ${job.status === "failed" ? "bg-red-100 text-red-800" : job.status === "complete" ? "bg-emerald-100 text-emerald-800" : job.status === "review" ? "bg-amber-100 text-amber-800" : "bg-cyan-100 text-cyan-800"}`}>{job.status}</span>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav className="border border-gray-200 bg-white p-3">
          {stages.map(([label, detail], index) => {
            const number = index + 1;
            const done = number < job.currentStage || job.status === "complete";
            const active = number === job.currentStage && job.status !== "complete";
            return (
              <div key={label} className={`flex gap-3 p-3 ${active ? "bg-cyan-50" : ""}`}>
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-emerald-600 text-white" : active ? "bg-cyan-700 text-white" : "bg-gray-100 text-gray-400"}`}>{done ? "✓" : number}</span>
                <div><p className="text-xs font-semibold">{label}</p><p className="mt-1 text-[11px] leading-4 text-gray-500">{detail}</p></div>
              </div>
            );
          })}
        </nav>

        <section className="min-w-0 border border-gray-200 bg-white">
          <div className="border-b border-gray-200 p-6">
            <p className="text-xs font-semibold uppercase text-cyan-700">Stage {job.currentStage} of 4</p>
            <h1 className="mt-2 font-serif text-2xl font-bold">{job.message}</h1>
            <p className="mt-2 text-sm text-gray-500">Progress and review decisions are saved under job {job.id}.</p>
          </div>

          {(job.status === "running" || job.status === "queued") && (
            <div className="p-6">
              <div className="h-1.5 overflow-hidden bg-gray-100"><div className="h-full w-1/2 animate-pulse bg-cyan-700" /></div>
              <pre className="mt-5 max-h-80 overflow-auto bg-gray-950 p-4 text-xs leading-5 text-gray-200">{log || "Starting pipeline..."}</pre>
            </div>
          )}

          {job.status === "review" && (
            <div className="p-6">
              <div className="border-l-2 border-amber-500 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                Inspect the generated stage files and record your decision. Approval starts the next pipeline stage; requesting changes saves your note without advancing.
              </div>
              <label htmlFor="review-note" className="mt-6 block text-sm font-semibold">Review note</label>
              <textarea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 h-32 w-full border border-gray-300 p-3 text-sm outline-none focus:border-cyan-700" placeholder="Corrections, missing evidence, or approval rationale" />
              <div className="mt-4 flex justify-end gap-2">
                <button disabled={busy || !note.trim()} onClick={() => review("changes_requested")} className="h-10 border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:text-gray-300">Request changes</button>
                <button disabled={busy} onClick={() => review("approved")} className="h-10 bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-300">Approve and continue</button>
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
              <div className="border-l-2 border-emerald-600 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">The reviewed HumanStudy-Bench package is ready for download and can be used by the Run Experiment workspace.</div>
              <div className="mt-5 flex flex-wrap gap-2">
                <a href={`/api/pipeline/jobs/${job.id}/download`} className="inline-flex h-10 items-center bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600">Download experiment ZIP</a>
                <button disabled={busy || Boolean(prUrl)} onClick={publish} className="h-10 border border-gray-300 bg-white px-5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:text-gray-400">{busy ? "Saving..." : prUrl ? "Saved to GitHub" : "Save to GitHub"}</button>
              </div>
              {prUrl && <a href={prUrl} target="_blank" rel="noreferrer" className="mt-4 block text-sm font-semibold text-cyan-700 hover:underline">Open pull request</a>}
            </div>
          )}

          {error && <p className="mx-6 mb-6 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        </section>
      </main>
    </div>
  );
}
