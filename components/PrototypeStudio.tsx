"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { downloadTextReport } from "@/lib/download-report";

type Design = { summary: string; researchQuestion: string; design: string; measures: string; analysisPlan: string; risks: string; nextStep: string };
type Preview = { overview: string; issues: string[]; responses: Array<{ participant: string; interpretation: string; response: string; friction: string }> };
type Draft = { id: string; name: string; idea: string; design?: Design; preview?: Preview; updatedAt: string };

const HISTORY_KEY = "humanstudy-hub-prototypes";

function designText(design?: Design) {
  if (!design) return "";
  return ["Summary", design.summary, "Research question", design.researchQuestion, "Protocol", design.design, "Measures", design.measures, "Analysis plan", design.analysisPlan, "Risks and open questions", design.risks, "Recommended next step", design.nextStep].join("\n\n");
}

export default function PrototypeStudio() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [pdf, setPdf] = useState<File | null>(null);
  const [design, setDesign] = useState<Design>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState<"design" | "preview" | "">("");
  const [error, setError] = useState("");

  useEffect(() => {
    try { setDrafts(JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]")); } catch { setDrafts([]); }
  }, []);

  function save(nextDesign = design, nextPreview = preview) {
    const draft: Draft = { id: id || crypto.randomUUID(), name: name.trim(), idea, design: nextDesign, preview: nextPreview, updatedAt: new Date().toISOString() };
    const next = [draft, ...drafts.filter((entry) => entry.id !== draft.id)].slice(0, 30);
    setId(draft.id); setDrafts(next); window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  }

  function open(draft: Draft) {
    setId(draft.id); setName(draft.name); setIdea(draft.idea); setDesign(draft.design); setPreview(draft.preview); setPdf(null); setError("");
  }

  function fresh() { setId(""); setName(""); setIdea(""); setPdf(null); setDesign(undefined); setPreview(undefined); setError(""); }

  async function run(action: "design" | "preview") {
    setBusy(action); setError("");
    try {
      const form = new FormData(); form.set("action", action); form.set("name", name); form.set("idea", idea); form.set("design", designText(design)); if (pdf) form.set("pdf", pdf);
      const response = await fetch("/api/playground/prototype", { method: "POST", body: form });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "The agent could not complete this step.");
      if (action === "design") { setDesign(data.result); setPreview(undefined); save(data.result, undefined); }
      else { setPreview(data.result); save(design, data.result); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The agent could not complete this step."); }
    finally { setBusy(""); }
  }

  function report() {
    const responses = preview?.responses.map((entry) => `${entry.participant}\nInterpretation: ${entry.interpretation}\nResponse: ${entry.response}\nFriction: ${entry.friction}`).join("\n\n") || "Not run";
    downloadTextReport(`${name || "study-prototype"}-report.txt`, `${name} - study prototype`, [["Evidence note", "Synthetic responses are design-debugging material only. They are not human data and do not validate behavioral effects."], ["Original idea", idea], ["Design feedback", designText(design)], ["Preview overview", preview?.overview || "Not run"], ["Preview issues", preview?.issues.join("\n") || "None recorded"], ["Synthetic response samples", responses]]);
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white"><div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-5 px-5 py-9 sm:px-8"><div><p className="text-xs font-semibold uppercase text-cyan-700">New study prototype</p><h1 className="mt-2 font-serif text-3xl font-bold text-gray-950">Design before you benchmark</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">Shape a protocol and preview whether agents understand it. Human validation comes later.</p></div><Link href="/playground" className="text-xs font-semibold text-gray-600 hover:text-cyan-800">Change workflow</Link></div></header>
      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 sm:px-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border border-gray-200 bg-white p-3"><div className="flex items-center justify-between px-2 py-2"><p className="text-xs font-bold uppercase text-gray-500">Your prototypes</p><button onClick={fresh} title="New prototype" className="h-7 w-7 border border-gray-300 text-lg leading-none text-gray-600 hover:border-cyan-700">+</button></div>{drafts.length === 0 ? <p className="px-2 py-4 text-xs leading-5 text-gray-500">Named prototypes will appear here on this browser.</p> : <div className="mt-1 divide-y divide-gray-100">{drafts.map((draft) => <button key={draft.id} onClick={() => open(draft)} className={`block w-full px-2 py-3 text-left ${id === draft.id ? "bg-cyan-50" : "hover:bg-gray-50"}`}><span className="block truncate text-xs font-semibold text-gray-900">{draft.name}</span><span className="mt-1 block text-[10px] text-gray-400">{new Date(draft.updatedAt).toLocaleDateString()}</span></button>)}</div>}</aside>
        <div className="space-y-5">
          <section className="border border-gray-200 bg-white p-6"><div className="grid gap-5 sm:grid-cols-2"><div><label htmlFor="prototype-name" className="text-sm font-semibold text-gray-900">Study name</label><input id="prototype-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Trust in AI triage advice" className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" /><p className="mt-1 text-xs text-gray-500">Required for saving and history.</p></div><div><p className="text-sm font-semibold text-gray-900">Design notes <span className="font-normal text-gray-400">optional PDF</span></p><button onClick={() => fileInput.current?.click()} className="mt-2 h-10 w-full border border-gray-300 px-3 text-left text-sm text-gray-600 hover:border-cyan-700">{pdf?.name || "Attach proposal or notes"}</button><input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(event) => setPdf(event.target.files?.[0] || null)} /></div></div><label htmlFor="prototype-idea" className="mt-6 block text-sm font-semibold text-gray-900">Research idea and rough design</label><textarea id="prototype-idea" value={idea} onChange={(event) => setIdea(event.target.value)} rows={9} placeholder="What do you want to learn? Who would participate? What would they see or do? What outcome matters? Include uncertainties you want feedback on." className="mt-2 w-full border border-gray-300 p-3 text-sm leading-6 outline-none focus:border-cyan-700" />{error && <p className="mt-4 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}<div className="mt-5 flex justify-end"><button disabled={busy !== "" || !name.trim() || (!idea.trim() && !pdf)} onClick={() => run("design")} className="h-10 bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:bg-gray-300">{busy === "design" ? "Reviewing design..." : design ? "Revise design" : "Get design feedback"}</button></div></section>
          {design && <section className="border border-gray-200 bg-white"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-4"><div><p className="text-sm font-semibold text-gray-950">Proposed study protocol</p><p className="mt-1 text-xs text-gray-500">Review this draft before running a synthetic preview.</p></div><button onClick={report} className="h-9 border border-gray-300 px-3 text-xs font-semibold text-gray-700 hover:border-cyan-700">Download report</button></div><div className="grid gap-px bg-gray-200 sm:grid-cols-2">{[["Research question", design.researchQuestion], ["Study design", design.design], ["Measures", design.measures], ["Analysis plan", design.analysisPlan], ["Risks and open questions", design.risks], ["Next step", design.nextStep]].map(([label, value]) => <div key={label} className="bg-white p-5"><p className="text-xs font-semibold uppercase text-gray-500">{label}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-700">{value}</p></div>)}</div><div className="border-t border-gray-200 p-5"><div className="border-l-2 border-amber-500 bg-amber-50 p-3 text-xs leading-5 text-amber-950">Synthetic participants can reveal confusing instructions and broken response formats. They cannot establish how people will respond or whether an effect is real.</div><div className="mt-4 flex justify-end"><button disabled={busy !== ""} onClick={() => run("preview")} className="h-10 bg-gray-900 px-5 text-sm font-semibold text-white hover:bg-gray-700 disabled:bg-gray-300">{busy === "preview" ? "Running preview..." : "Run synthetic preview"}</button></div></div></section>}
          {preview && <section className="border border-gray-200 bg-white p-5"><p className="text-sm font-semibold text-gray-950">Synthetic response preview</p><p className="mt-2 text-sm leading-6 text-gray-600">{preview.overview}</p>{preview.issues.length > 0 && <div className="mt-4 border-l-2 border-amber-500 bg-amber-50 p-4"><p className="text-xs font-semibold uppercase text-amber-900">Issues to review</p><ul className="mt-2 space-y-1 text-sm leading-6 text-amber-950">{preview.issues.map((issue) => <li key={issue}>- {issue}</li>)}</ul></div>}<details className="mt-5 border border-gray-200 p-4"><summary className="cursor-pointer text-sm font-semibold text-gray-900">Inspect synthetic responses ({preview.responses.length})</summary><div className="mt-4 space-y-4">{preview.responses.map((entry, index) => <div key={index} className="border-l-2 border-cyan-700 pl-4 text-xs leading-5"><p className="font-semibold text-gray-900">{entry.participant}</p><p className="mt-1 text-gray-600"><span className="font-semibold">Interpretation:</span> {entry.interpretation}</p><p className="mt-1 text-gray-600"><span className="font-semibold">Response:</span> {entry.response}</p><p className="mt-1 text-amber-800"><span className="font-semibold">Friction:</span> {entry.friction}</p></div>)}</div></details></section>}
        </div>
      </main>
    </div>
  );
}
