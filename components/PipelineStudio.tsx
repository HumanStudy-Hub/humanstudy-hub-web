"use client";

import { useMemo, useRef, useState } from "react";

type IconName =
  | "upload"
  | "file"
  | "link"
  | "check"
  | "clock"
  | "review"
  | "play"
  | "download"
  | "chevron"
  | "shield"
  | "spark"
  | "search"
  | "close";

function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 14v5h14v-5" /></>,
    file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
    link: <><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" /><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" /></>,
    check: <path d="M5 12l4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    review: <><path d="M4 5h16v12H8l-4 4z" /><path d="M8 9h8M8 13h5" /></>,
    play: <path d="M8 5v14l11-7z" />,
    download: <><path d="M12 4v11m0 0l-4-4m4 4 4-4" /><path d="M5 20h14" /></>,
    chevron: <path d="M9 6l6 6-6 6" />,
    shield: <><path d="M12 3l8 3v6c0 5-3 8-8 10-5-2-8-5-8-10V6z" /><path d="M8 12l3 3 5-6" /></>,
    spark: <><path d="M12 3l1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4z" /><path d="M18 15l.7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7z" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="M16 16l5 5" /></>,
    close: <path d="M6 6l12 12M18 6L6 18" />,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const stages = [
  { number: 1, label: "Study inventory", detail: "3 studies identified", status: "approved" },
  { number: 2, label: "Findings & effects", detail: "12 findings extracted", status: "review" },
  { number: 3, label: "Study materials", detail: "Waiting for approval", status: "locked" },
  { number: 4, label: "Build package", detail: "Runnable study files", status: "locked" },
  { number: 5, label: "Validate package", detail: "Check generated files", status: "locked" },
] as const;

const findings = [
  { id: "F-01", study: "Study 1", claim: "Perceived autonomy increased willingness to disclose personal information.", stat: "b = 0.31, p = .004", confidence: 96, source: "p. 6" },
  { id: "F-02", study: "Study 1", claim: "The effect was mediated by perceived control over the interaction.", stat: "95% CI [0.08, 0.24]", confidence: 91, source: "p. 7" },
  { id: "F-03", study: "Study 2", claim: "The autonomy manipulation replicated with a preregistered sample.", stat: "d = 0.42, p < .001", confidence: 94, source: "p. 10" },
  { id: "F-04", study: "Study 3", claim: "No interaction with participant age was supported.", stat: "F(1, 384) = 0.73", confidence: 73, source: "p. 14" },
];

export default function PipelineStudio() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [paper, setPaper] = useState<File | null>(null);
  const [osf, setOsf] = useState("");
  const [experimentId, setExperimentId] = useState("study_new");
  const [contributorName, setContributorName] = useState("");
  const [contributorId, setContributorId] = useState("");
  const [started, setStarted] = useState(false);
  const [activeStage, setActiveStage] = useState(2);
  const [selected, setSelected] = useState("F-01");
  const [approved, setApproved] = useState<string[]>(["F-01", "F-02"]);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);

  const selectedFinding = useMemo(() => findings.find((item) => item.id === selected) ?? findings[0], [selected]);

  function chooseFile(file?: File) {
    if (file?.type === "application/pdf" || file?.name.toLowerCase().endsWith(".pdf")) setPaper(file);
  }

  if (!started) {
    return (
      <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase text-cyan-700">
              <Icon name="spark" /> Study builder
            </div>
            <h1 className="mt-3 max-w-3xl font-serif text-3xl font-bold text-gray-950 sm:text-4xl">Turn a paper into an AI-agent study</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">Upload a paper. We extract the study, assemble runnable files, and pause for researcher review.</p>
          </div>
        </header>

        <main className="mx-auto grid max-w-6xl gap-8 px-5 py-9 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
            <div className="flex items-start justify-between border-b border-gray-100 pb-5">
              <div><p className="text-sm font-semibold text-gray-950">Source material</p><p className="mt-1 text-sm text-gray-500">Only the paper PDF is required.</p></div>
              <span className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">Draft</span>
            </div>

            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
              className={`mt-6 flex min-h-52 w-full flex-col items-center justify-center border border-dashed px-6 text-center transition-colors ${dragging ? "border-cyan-500 bg-cyan-50" : paper ? "border-emerald-300 bg-emerald-50/40" : "border-gray-300 bg-gray-50 hover:border-cyan-400 hover:bg-cyan-50/40"}`}
            >
              <span className={`flex h-11 w-11 items-center justify-center rounded-full ${paper ? "bg-emerald-100 text-emerald-700" : "bg-white text-cyan-700 shadow-sm ring-1 ring-gray-200"}`}><Icon name={paper ? "check" : "upload"} className="h-5 w-5" /></span>
              <span className="mt-4 text-sm font-semibold text-gray-900">{paper ? paper.name : "Drop your paper here"}</span>
              <span className="mt-1 text-xs text-gray-500">{paper ? `${(paper.size / 1024 / 1024).toFixed(1)} MB · Ready to process` : "or choose a PDF · up to 50 MB"}</span>
            </button>
            <input ref={fileInput} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(event) => chooseFile(event.target.files?.[0])} />

            <label className="mt-6 block text-sm font-semibold text-gray-900" htmlFor="osf-url">Open materials <span className="font-normal text-gray-400">· optional</span></label>
            <div className="relative mt-2">
              <Icon name="link" className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <input id="osf-url" value={osf} onChange={(event) => setOsf(event.target.value)} placeholder="https://osf.io/…" className="h-10 w-full border border-gray-300 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
            </div>
            <p className="mt-2 text-xs text-gray-500">Add an OSF link when surveys, stimuli, or data are available separately.</p>

            <label className="mt-6 block text-sm font-semibold text-gray-900" htmlFor="experiment-id">Experiment ID</label>
            <div className="mt-2 flex h-10 border border-gray-300 bg-white focus-within:border-cyan-600 focus-within:ring-2 focus-within:ring-cyan-100">
              <span className="flex items-center border-r border-gray-200 bg-gray-50 px-3 font-mono text-xs text-gray-500">studies/</span>
              <input id="experiment-id" value={experimentId} onChange={(event) => setExperimentId(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))} className="min-w-0 flex-1 px-3 font-mono text-sm outline-none" />
            </div>
            <p className="mt-2 text-xs text-gray-500">The generated folder and downloadable ZIP use this ID.</p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="contributor-name">Contributor name</label>
                <input id="contributor-name" value={contributorName} onChange={(event) => setContributorName(event.target.value)} placeholder="Your name" className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="contributor-id">GitHub ID <span className="font-normal text-gray-400">· optional</span></label>
                <div className="mt-2 flex h-10 border border-gray-300 focus-within:border-cyan-700">
                  <span className="flex items-center border-r border-gray-200 bg-gray-50 px-3 text-xs text-gray-500">@</span>
                  <input id="contributor-id" value={contributorId} onChange={(event) => setContributorId(event.target.value.replace(/^@/, ""))} placeholder="username" className="min-w-0 flex-1 px-3 text-sm outline-none" />
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs text-gray-500">Your name is shown in the dataset catalog. A GitHub ID can be added for contributor attribution.</p>

            <div className="mt-7 flex items-center justify-between border-t border-gray-100 pt-5">
              <button type="button" onClick={() => setStarted(true)} className="text-xs font-semibold text-cyan-700 hover:underline">Explore example project</button>
              <button type="button" disabled={!paper || !experimentId || !contributorName.trim()} onClick={() => setStarted(true)} className="ml-auto inline-flex h-10 items-center gap-2 bg-cyan-700 px-4 text-sm font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300">
                Start conversion <Icon name="chevron" />
              </button>
            </div>
          </section>

          <aside>
            <p className="text-xs font-semibold uppercase text-gray-500">What happens next</p>
            <ol className="mt-4 border-l border-gray-300">
              {["Map studies and samples", "Extract claims and statistics", "Recover surveys and stimuli", "Build the benchmark package", "Validate the study package"].map((label, index) => (
                <li key={label} className="relative pb-6 pl-6 last:pb-0">
                  <span className="absolute -left-3 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-[11px] font-bold text-gray-600">{index + 1}</span>
                  <p className="text-sm font-medium text-gray-800">{label}</p>
                  {index < 4 && <p className="mt-1 text-xs text-gray-500">{index === 0 || index === 1 || index === 3 ? "Researcher approval" : "Automated with audit"}</p>}
                </li>
              ))}
            </ol>
          </aside>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa] text-gray-900">
      <div className="border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4">
          <div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{paper?.name.replace(/\.pdf$/i, "") || "Untitled study"}</span><span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Needs review</span></div><p className="mt-0.5 truncate text-xs text-gray-500">{paper?.name} {osf && `· ${osf}`}</p></div>
          <button onClick={() => setStarted(false)} className="inline-flex h-9 items-center gap-2 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50"><Icon name="close" /> Close</button>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1500px] lg:grid-cols-[250px_minmax(0,1fr)_290px]">
        <aside className="border-r border-gray-200 bg-white p-4 lg:min-h-[calc(100vh-7.75rem)]">
          <p className="px-2 text-[11px] font-semibold uppercase text-gray-400">Conversion stages</p>
          <nav className="mt-3 space-y-1">
            {stages.map((stage) => {
              const current = stage.number === activeStage;
              const status = stage.number === 1 ? "approved" : stage.number === 2 ? "review" : "locked";
              return (
                <button key={stage.number} disabled={status === "locked"} onClick={() => setActiveStage(stage.number)} className={`flex w-full items-start gap-3 px-2 py-3 text-left ${current ? "bg-cyan-50 text-cyan-950" : "hover:bg-gray-50 disabled:hover:bg-transparent"}`}>
                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${status === "approved" ? "bg-emerald-600 text-white" : current ? "bg-cyan-700 text-white" : "bg-gray-100 text-gray-400"}`}>{status === "approved" ? <Icon name="check" className="h-3.5 w-3.5" /> : stage.number}</span>
                  <span className="min-w-0"><span className={`block text-xs font-semibold ${status === "locked" ? "text-gray-400" : ""}`}>{stage.label}</span><span className="mt-1 block text-[11px] text-gray-500">{stage.detail}</span></span>
                </button>
              );
            })}
          </nav>
          <div className="mt-6 border-t border-gray-100 pt-5">
            <p className="px-2 text-[11px] font-semibold uppercase text-gray-400">Sources</p>
            <div className="mt-3 space-y-2 px-2 text-xs text-gray-600"><p className="flex items-center gap-2"><Icon name="file" className="h-4 w-4 text-red-500" /> Paper PDF</p><p className="flex items-center gap-2"><Icon name="link" className="h-4 w-4 text-cyan-600" /> OSF materials</p></div>
          </div>
        </aside>

        <main className="min-w-0 p-4 sm:p-6">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div><p className="text-xs font-semibold text-cyan-700">Stage 2 of 5</p><h1 className="mt-1 font-serif text-2xl font-bold">Review findings and effects</h1><p className="mt-1 text-sm text-gray-500">Confirm each claim against the source before materials are assembled.</p></div>
            <div className="relative"><Icon name="search" className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" /><input aria-label="Search findings" placeholder="Search findings" className="h-9 w-48 border border-gray-300 bg-white pl-9 pr-3 text-xs outline-none focus:border-cyan-600" /></div>
          </div>

          <div className="overflow-x-auto border border-gray-200 bg-white">
            <div className="min-w-[660px]">
              <div className="grid grid-cols-[70px_80px_minmax(220px,1fr)_145px_85px] border-b border-gray-200 bg-gray-50 px-4 py-2 text-[11px] font-semibold uppercase text-gray-500">
                <span>ID</span><span>Study</span><span>Extracted claim</span><span>Statistic</span><span>Evidence</span>
              </div>
              {findings.map((finding) => (
                <button key={finding.id} onClick={() => setSelected(finding.id)} className={`grid w-full grid-cols-[70px_80px_minmax(220px,1fr)_145px_85px] items-center border-b border-gray-100 px-4 py-3 text-left text-xs last:border-b-0 ${selected === finding.id ? "bg-cyan-50/70" : "hover:bg-gray-50"}`}>
                  <span className="font-mono font-semibold text-gray-600">{finding.id}</span><span className="text-gray-500">{finding.study}</span><span className="pr-5 leading-5 text-gray-800">{finding.claim}</span><span className="font-mono text-[11px] text-gray-600">{finding.stat}</span><span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${finding.confidence > 85 ? "bg-emerald-500" : "bg-amber-500"}`} />{finding.confidence}%</span>
                </button>
              ))}
            </div>
          </div>

          <section className="mt-5 border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3"><div><span className="font-mono text-xs font-bold">{selectedFinding.id}</span><span className="ml-3 text-xs text-gray-500">Source comparison</span></div><span className="rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-600">{selectedFinding.source}</span></div>
            <div className="grid md:grid-cols-2">
              <div className="border-b border-gray-200 p-5 md:border-b-0 md:border-r"><p className="text-[11px] font-semibold uppercase text-gray-400">Paper evidence</p><p className="mt-3 font-serif text-sm leading-7 text-gray-700">“Participants in the high-autonomy condition reported greater willingness to disclose than those in the constrained condition…”</p><button className="mt-3 text-xs font-semibold text-cyan-700 hover:underline">Open PDF at {selectedFinding.source}</button></div>
              <div className="p-5"><label htmlFor="review-note" className="text-[11px] font-semibold uppercase text-gray-400">Reviewer note</label><textarea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a correction or rationale…" className="mt-3 h-24 w-full resize-none border border-gray-300 p-3 text-xs leading-5 outline-none focus:border-cyan-600" /></div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-3">
              <p className="text-xs text-gray-500">{approved.includes(selectedFinding.id) ? "Approved by you" : "This finding still needs a decision"}</p>
              <div className="flex gap-2"><button className="h-8 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50">Flag correction</button><button onClick={() => setApproved((items) => items.includes(selectedFinding.id) ? items : [...items, selectedFinding.id])} className="inline-flex h-8 items-center gap-2 bg-emerald-700 px-3 text-xs font-semibold text-white hover:bg-emerald-600"><Icon name="check" /> Approve finding</button></div>
            </div>
          </section>
        </main>

        <aside className="border-l border-gray-200 bg-white p-5">
          <div className="flex items-center gap-2"><Icon name="shield" className="h-5 w-5 text-cyan-700" /><h2 className="text-sm font-semibold">Readiness audit</h2></div>
          <p className="mt-2 text-xs leading-5 text-gray-500">The package stays blocked until required checks and researcher decisions pass.</p>
          <div className="mt-5 space-y-4">
            {[["Study inventory", "3 of 3 approved", true], ["Findings", `${approved.length} of ${findings.length} approved`, approved.length === findings.length], ["Grounding", "11 verified · 1 warning", false], ["Materials", "Not started", false]].map(([label, detail, pass]) => (
              <div key={String(label)} className="flex items-start gap-3"><span className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full ${pass ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-400"}`}>{pass ? <Icon name="check" className="h-3 w-3" /> : <Icon name="clock" className="h-3 w-3" />}</span><div><p className="text-xs font-semibold">{label}</p><p className="mt-0.5 text-[11px] text-gray-500">{detail}</p></div></div>
            ))}
          </div>
          <div className="mt-6 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><strong className="block">1 item needs attention</strong>Finding F-04 has lower-confidence evidence.</div>
          <button disabled={approved.length !== findings.length} className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 bg-cyan-700 text-xs font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300"><Icon name="play" /> Approve & continue</button>
          <div className="mt-6 border-t border-gray-100 pt-5">
            <p className="text-[11px] font-semibold uppercase text-gray-400">Final delivery</p>
            <div className="mt-3 border border-gray-200 bg-gray-50 p-3">
              <p className="font-mono text-xs font-semibold text-gray-800">studies/{experimentId || "study_new"}/</p>
              <p className="mt-1 text-[11px] leading-4 text-gray-500">Saved to the GitHub repository after approval.</p>
            </div>
            <button disabled className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 border border-gray-300 bg-white text-xs font-semibold text-gray-400"><Icon name="download" /> Download experiment ZIP</button>
            <p className="mt-2 text-[11px] leading-4 text-gray-400">Use this ZIP in the upcoming Run Experiment workspace.</p>
          </div>
          <p className="mt-4 text-center text-[11px] text-gray-400">Autosaved just now</p>
        </aside>
      </div>
    </div>
  );
}
