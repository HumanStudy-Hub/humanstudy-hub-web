"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import PersonaDesigner from "@/components/PersonaDesigner";
import PlaygroundCharts, { type PlaygroundChartSet } from "@/components/PlaygroundCharts";
import SearchSelect, { type SelectOption } from "@/components/SearchSelect";
import type { PersonaGroup } from "@/lib/persona-groups";
import { downloadTextReport } from "@/lib/download-report";

// "paper" samples each agent from the study's own recruitment criteria, which
// is how the benchmark runs; the others are deliberate departures from it.
type CastMode = "paper" | "simple" | "personas";

const STORAGE_KEY = "humanstudy-hub-playground-run";
// A dispatched run reports back within a minute or so. Longer than this and no
// runner ever picked it up.
const STALL_MS = 5 * 60 * 1000;

export type StudyOption = { study_id: string; title: string; year: number | null; source?: "benchmark" | "buffer"; jobId?: string; packageSlug?: string };

type RunStatus = "queued" | "running" | "analysing" | "complete" | "failed";
type Progress = {
  phase: "preparing" | "running_participants" | "scoring" | "charting" | "failed";
  completedTrials?: number;
  totalTrials?: number;
  message?: string;
};
type Summary = {
  totalTests: number;
  scoredTests: number;
  replicatedTests: number;
  replicationRate: number | null;
  directionMatchRate: number | null;
  meanAbsoluteEffectGap: number | null;
  meanHumanEffect: number | null;
  meanAgentEffect: number | null;
  effectCorrelation: number | null;
  studyScore: number | null;
};
type Run = {
  id: string;
  studyId: string;
  studyTitle?: string;
  cached?: boolean;
  model: string;
  preset: string;
  participantsPerScenario: number;
  status: RunStatus;
  message: string;
  error?: string;
  resultsReady?: boolean;
  participants?: number;
  answeredTrials?: number;
  summary?: Summary;
  progress?: Progress;
  selection?: RunSelection;
  partial?: boolean;
  createdAt?: string;
};
type RunSelection = { mode: "whole" | "material"; materialId?: string; itemId?: string; label?: string };
type MaterialOption = { id: string; label: string; items: Array<{ id: string; label: string }>; description?: string; detail?: Record<string, unknown> };
type Review = { studyNote: string; itemNotes: Record<string, string>; updatedAt?: string };
type TestRow = {
  test_id: string;
  label: string;
  hypothesis: string | null;
  reported_statistics: string | null;
  human_effect: number | null;
  agent_effect: number | null;
  human_p: number | null;
  agent_p: number | null;
  human_significant: boolean | null;
  agent_significant: boolean | null;
  direction_match: boolean | null;
  replicated: boolean | null;
};
type Analysis = { summary: Summary; tests: TestRow[] };
type Transcript = Array<{ participantId: number; profile: Record<string, string | number>; prompt: string | null; response: string | null }>;

const MODELS: SelectOption[] = [
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", note: "fast, inexpensive" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", note: "open weights" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", note: "strong instruction following" },
  { id: "openai/gpt-5-mini", label: "GPT-5 mini", note: "fast, inexpensive" },
  { id: "openai/gpt-5.2", label: "GPT-5.2", note: "" },
  { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "fast, low cost" },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", note: "open weights" },
  { id: "qwen/qwen3.8-max", label: "Qwen 3.8 Max", note: "open weights" },
];

// OpenRouter ids are always provider/model, so anything of that shape is a model
// this run can use even when it is not one of the listed ones.
const OPENROUTER_ID = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/;

// The grey line on a card explains the choice; the prompt itself sits behind an
// expander so all four cards stay the same size.
const PRESETS = [
  {
    id: "v2_human",
    label: "Study participant",
    usesIdentity: false,
    note: "A neutral default: follow the study and answer as a participant.",
    prompt: "Take part in the following study as a participant. Follow the study instructions and answer in the requested format. Give the answer you judge most appropriate; do not explain it unless asked.",
  },
  {
    id: "v3_human_plus_demo",
    label: "Participant + demographics",
    usesIdentity: true,
    note: "Adds age, gender, and background when identity is part of your question.",
    prompt: `Take part in the following study as a participant.

YOUR IDENTITY:
- Age: {age} years old
- Gender: {gender}
- Background: {background}

Follow the experimenter's instructions and answer each task in the requested format.
Give the answer you judge most appropriate. Do not add explanations unless asked.`,
  },
  {
    id: "v1_empty",
    label: "No framing",
    usesIdentity: false,
    note: "No participant prompt. The model receives only the study's task.",
    prompt: "",
  },
  {
    id: "custom",
    label: "Write your own",
    usesIdentity: true,
    note: "Any prompt, with or without each agent's details.",
    prompt: "",
  },
];

const PRESET_STARTERS: Record<string, string> = {
  v2_human: "Take part in the following study as a participant. Follow the study instructions and answer in the requested format. Give the answer you judge most appropriate; do not explain it unless asked.",
  v3_human_plus_demo:
    "Take part in the following study as a participant.\n\nYOUR IDENTITY:\n- Age: 21 years old\n- Gender: female\n- Background: undergraduate student\n\nFollow the study instructions and answer each task in the requested format.\nGive the answer you judge most appropriate. Do not add explanations unless asked.",
};

const PHASES: Record<Progress["phase"], string> = {
  preparing: "Loading the study",
  running_participants: "Participants are answering",
  scoring: "Scoring against the published findings",
  charting: "Building the comparison charts",
  failed: "The run stopped",
};

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function decimal(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined ? "—" : value.toFixed(digits);
}

function significanceStars(p: number | null | undefined, significant: boolean | null | undefined) {
  if (p !== null && p !== undefined) {
    if (p < 0.001) return "***";
    if (p < 0.01) return "**";
    if (p < 0.05) return "*";
    return "";
  }
  return significant ? "*" : "";
}

function Verdict({ row }: { row: TestRow }) {
  if (row.replicated) return <span className="bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-800">Reproduced</span>;
  if (row.direction_match === false) return <span className="bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900">Wrong direction</span>;
  if (row.replicated === false) return <span className="bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600">No effect</span>;
  return <span className="text-[11px] text-gray-400">Not scored</span>;
}

export default function PlaygroundStudio({ studies }: { studies: StudyOption[] }) {
  const [studyId, setStudyId] = useState(studies[0]?.study_id || "study_001");
  const [model, setModel] = useState(MODELS[0].id);
  const [preset, setPreset] = useState("v2_human");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [background, setBackground] = useState("");
  const [persona, setPersona] = useState("");
  const [participants, setParticipants] = useState(8);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [castMode, setCastMode] = useState<CastMode>("paper");
  const [personaGroup, setPersonaGroup] = useState<PersonaGroup | null>(null);
  const [shownPrompt, setShownPrompt] = useState("");
  const [scope, setScope] = useState<"whole" | "material">("whole");
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [materialId, setMaterialId] = useState("");
  const [itemId, setItemId] = useState("");
  const [materialsLoading, setMaterialsLoading] = useState(false);

  const [run, setRun] = useState<Run | null>(null);
  const [charts, setCharts] = useState<PlaygroundChartSet | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [transcript, setTranscript] = useState<Transcript>([]);
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stalled, setStalled] = useState(false);
  const [review, setReview] = useState<Review>({ studyNote: "", itemNotes: {} });
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewSaved, setReviewSaved] = useState(true);
  const [history, setHistory] = useState<Run[]>([]);
  const resultsLoaded = useRef("");

  const maxParticipants = apiKey.trim() ? 80 : 10;
  const identityReachesPrompt = PRESETS.find((entry) => entry.id === preset)?.usesIdentity ?? true;
  const study = useMemo(() => studies.find((entry) => entry.study_id === studyId), [studies, studyId]);
  const studyOptions = useMemo<SelectOption[]>(() => studies.map((entry) => ({ id: entry.study_id, label: entry.title })), [studies]);

  // Any identity field that is filled in is applied to every agent, so the run
  // stops sampling participants and becomes one person repeated.
  const identitySummary = useMemo(() => {
    const parts = [
      age.trim() && `${age.trim()} years old`,
      gender.trim(),
      background.trim(),
      persona.trim(),
    ].filter(Boolean);
    return parts.join(", ");
  }, [age, gender, background, persona]);
  const sameIdentity = castMode === "simple" && identitySummary.length > 0;
  const selectedMaterial = materials.find((entry) => entry.id === materialId);
  const scopeUnit = study?.source === "buffer" ? "condition" : "material";

  // Latest run status for a scoped entry (condition/material), used to show
  // which ones have already been completed before starting a new run.
  function scopeStatus(entryId: string) {
    const scoped = history.filter((run) => run.selection?.mode === "material" && run.selection.materialId === entryId);
    return scoped.length > 0 ? scoped[0].status : null;
  }

  // Benchmark studies preview their material catalog; buffer (agent-built)
  // packages preview their condition arms from task.json. Both reuse the same
  // "Run scope" control with a different data source.
  useEffect(() => {
    setMaterials([]);
    setMaterialId("");
    setItemId("");
    if (scope !== "material" || !studyId) return;
    setMaterialsLoading(true);
    const buffer = study?.source === "buffer";
    const url = buffer
      ? `/api/playground/buffer-arms?jobId=${encodeURIComponent(study?.jobId || "")}&slug=${encodeURIComponent(study?.packageSlug || "")}`
      : `/api/playground/studies/${encodeURIComponent(studyId)}/materials`;
    fetch(url, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("Unavailable")))
      .then((data) => {
        const next: MaterialOption[] = buffer
          ? (Array.isArray(data.arms) ? data.arms.map((arm: { id: string; label: string; description?: string; detail?: Record<string, unknown> }) => ({ id: arm.id, label: arm.label, items: [], description: arm.description, detail: arm.detail })) : [])
          : (Array.isArray(data.materials) ? data.materials as MaterialOption[] : []);
        setMaterials(next);
        setMaterialId(next[0]?.id || "");
      })
      .catch(() => setMaterials([]))
      .finally(() => setMaterialsLoading(false));
  }, [scope, studyId, study?.source, study?.jobId, study?.packageSlug]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("run");
    const saved = requested || window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    window.localStorage.setItem(STORAGE_KEY, saved);
    fetch(`/api/playground/runs/${saved}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.run) {
          setRun(data.run);
          setLog(data.log || "");
        } else {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const jobId = params.get("job");
    if (jobId) {
      const buffer = studies.find((entry) => entry.jobId === jobId);
      if (buffer) setStudyId(buffer.study_id);
      return;
    }
    const study = params.get("study");
    if (study && studies.some((entry) => entry.study_id === study)) setStudyId(study);
  }, [studies]);

  useEffect(() => {
    fetch(`/api/playground/runs?study=${encodeURIComponent(studyId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.runs) setHistory(data.runs); })
      .catch(() => undefined);
  }, [studyId, run?.status]);

  useEffect(() => {
    if (run) window.localStorage.setItem(STORAGE_KEY, run.id);
  }, [run]);

  useEffect(() => {
    if (!run || (run.status !== "queued" && run.status !== "running" && run.status !== "analysing")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/playground/runs/${run.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { run: Run; log: string };
        setRun(data.run);
        setLog(data.log || "");
      } catch {
        // A transient network interruption is retried on the next poll.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [run]);

  useEffect(() => {
    if (!run?.resultsReady || resultsLoaded.current === run.id) return;
    resultsLoaded.current = run.id;
    fetch(`/api/playground/runs/${run.id}/results`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.charts) setCharts(data.charts as PlaygroundChartSet);
        if (data.analysis) setAnalysis(data.analysis as Analysis);
        if (Array.isArray(data.transcript)) setTranscript(data.transcript as Transcript);
        fetch(`/api/playground/runs/${run.id}/review`, { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : null))
          .then((reviewData) => { if (reviewData?.review) { setReview(reviewData.review); setReviewSaved(true); } })
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }, [run]);

  // A run that never leaves "queued" means no runner picked it up.
  useEffect(() => {
    setStalled(false);
    if (!run || run.status !== "queued" || !run.createdAt) return;
    const since = Date.parse(run.createdAt);
    if (Number.isNaN(since)) return;
    const remaining = since + STALL_MS - Date.now();
    if (remaining <= 0) {
      setStalled(true);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), remaining);
    return () => window.clearTimeout(timer);
  }, [run]);

  function choosePreset(next: string) {
    setPreset(next);
    if (next === "custom" && !systemPrompt.trim()) {
      setSystemPrompt(PRESET_STARTERS.v2_human);
    }
  }

  async function start() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/playground/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studyId,
          ...(study?.source === "buffer" && study.jobId && study.packageSlug ? { jobId: study.jobId, packageSlug: study.packageSlug } : {}),
          model: model.trim(),
          preset,
          systemPrompt: preset === "custom" ? systemPrompt : "",
          demographics: identityReachesPrompt && castMode === "simple" ? { age, gender, background, persona } : {},
          personaGroup: identityReachesPrompt && castMode === "personas" ? personaGroup : null,
          participantsPerScenario: participants,
          temperature: 1,
          selection: scope === "material" ? {
            mode: "material",
            materialId,
            itemId: itemId || undefined,
            label: itemId ? selectedMaterial?.items.find((entry) => entry.id === itemId)?.label : selectedMaterial?.label,
          } : { mode: "whole" },
          apiKey: apiKey.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start this run.");
      setCharts(null);
      setAnalysis(null);
      setTranscript([]);
      setReview({ studyNote: "", itemNotes: {} });
      setReviewSaved(true);
      resultsLoaded.current = "";
      setRun(data.run);
      setApiKey("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start this run.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/playground/runs/${run.id}/retry`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not restart this run.");
      setRun(data.run);
      setStalled(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restart this run.");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/playground/runs/${run.id}/stop`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not stop this run.");
      setRun(data.run);
      setStalled(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not stop this run.");
    } finally {
      setBusy(false);
    }
  }

  async function openPastRun(id: string) {
    try {
      const response = await fetch(`/api/playground/runs/${id}`, { cache: "no-store" });
      const data = await response.json();
      if (response.ok && data.run) {
        setRun(data.run);
        setLog(data.log || "");
      }
    } catch {
      // A transient fetch failure leaves the current run untouched.
    }
  }

  function reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState({}, "", "/playground");
    setRun(null);
    setCharts(null);
    setAnalysis(null);
    setTranscript([]);
    setReview({ studyNote: "", itemNotes: {} });
    setReviewSaved(true);
    setLog("");
    resultsLoaded.current = "";
  }

  async function saveReview() {
    if (!run) return;
    setReviewSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/playground/runs/${run.id}/review`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(review) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Review could not be saved.");
      setReview(data.review);
      setReviewSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review could not be saved.");
    } finally {
      setReviewSaving(false);
    }
  }

  function downloadReport() {
    if (!run?.summary) return;
    const summary = [
      `Model: ${run.model}`,
      `Participant prompt: ${run.preset}`,
      `Run scope: ${run.selection?.mode === "material" ? run.selection.label || run.selection.itemId || run.selection.materialId : "Whole study"}`,
      `Participants: ${run.participants ?? "Not available"}`,
      `Answers collected: ${run.answeredTrials ?? 0}`,
      `Direction matched: ${percent(run.summary.directionMatchRate)}`,
      `Mean absolute effect gap: ${decimal(run.summary.meanAbsoluteEffectGap)}`,
      `Strict replication: ${run.summary.scoredTests > 0 ? `${run.summary.replicatedTests}/${run.summary.scoredTests}` : "Not available"}`,
    ].join("\n");
    const tests = analysis?.tests.map((row) => [row.label, `Paper: ${row.reported_statistics || "Not available"}`, `Human effect: ${decimal(row.human_effect)}${significanceStars(row.human_p, row.human_significant)}`, `Agent effect: ${decimal(row.agent_effect)}${significanceStars(row.agent_p, row.agent_significant)}`, `Direction match: ${row.direction_match ?? "Not scored"}`, `Strict replication: ${row.replicated ?? "Not scored"}`, `Annotation: ${review.itemNotes[row.test_id] || "None"}`].join("\n")).join("\n\n") || "Not loaded";
    const responses = transcript.map((sample) => `Participant ${sample.participantId}\nProfile: ${JSON.stringify(sample.profile)}\nPrompt: ${sample.prompt || "None"}\nResponse: ${sample.response || "No answer"}`).join("\n\n") || "Not loaded";
    downloadTextReport(`${run.studyId}-${run.id}-report.txt`, `${run.studyTitle || run.studyId} - agent study report`, [["Run summary", summary], ["Study-level annotation", review.studyNote || "None"], ["Interpretation note", "Direction and effect distance are descriptive comparisons. Strict replication requires both direction and significance to be scoreable; it is not the default verdict."], ["Test-by-test results", tests], ["Sample responses", responses]]);
  }

  const progress = run?.progress;
  const completed = progress?.completedTrials ?? 0;
  const total = progress?.totalTrials ?? 0;
  const running = run?.status === "queued" || run?.status === "running" || run?.status === "analysing";

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
          <p className="text-xs font-semibold uppercase text-cyan-700">Playground</p>
          <h1 className="mt-3 max-w-3xl font-serif text-4xl font-bold text-gray-950">Run your AI agent on a human study</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">
            Pick a study, a model, and the prompt your agent takes in. The run is scored against the paper&apos;s
            published findings, so you can see where the agent matched real participants and where it did not.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-9 sm:px-8">
        {error && <p className="mb-6 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="border border-gray-200 bg-white p-6 shadow-sm">
            <div className="border-b border-gray-100 pb-5">
              <p className="text-sm font-semibold text-gray-950">Experiment setup</p>
              <p className="mt-1 text-sm text-gray-500">Everything but the prompt matches how the benchmark runs this study.</p>
            </div>

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="block text-sm font-semibold text-gray-900" htmlFor="study">Study</label>
                <div className="mt-2">
                  <SearchSelect
                    id="study"
                    options={studyOptions}
                    value={studyId}
                    onChange={setStudyId}
                    placeholder="Type a study id or title"
                    display={(option, raw) => (option ? `${option.id} — ${option.label}` : raw)}
                    customEntry={(query, options) => {
                      if (!query || !/^[a-zA-Z0-9-]+_[a-zA-Z0-9_-]+$/.test(query)) return null;
                      if (options.some((option) => option.id.toLowerCase().startsWith(query.toLowerCase()))) return null;
                      return { id: query, hint: "Not in the catalog. A newly merged study can run before it is indexed." };
                    }}
                  />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  {study ? (
                    <>
                      <Link href={`/studies/${study.study_id}`} className="font-semibold text-cyan-700 hover:underline">Open the study record</Link>
                      {study.year ? ` · published ${study.year}` : ""}
                      {` · ${studies.length} studies in the catalog`}
                    </>
                  ) : (
                    <>Not in the catalog. The run will fail if <span className="font-mono">{studyId}</span> is not a study in the benchmark.</>
                  )}
                </p>
              </div>

              <div className="sm:col-span-2">
                <p className="text-sm font-semibold text-gray-900">Run scope</p>
                <div className="mt-2 inline-flex border border-gray-300">
                  {[["whole", "Whole study"], ["material", `Selected ${scopeUnit}`]].map(([id, label]) => (
                    <button key={id} type="button" onClick={() => setScope(id as "whole" | "material")} className={`h-9 px-4 text-xs font-semibold ${scope === id ? "bg-cyan-700 text-white" : "bg-white text-gray-600 hover:text-gray-950"}`}>{label}</button>
                  ))}
                </div>
                {scope === "whole" ? (
                  <p className="mt-2 text-xs text-gray-500">Runs every experiment {scopeUnit} in the study.</p>
                ) : study?.source === "buffer" ? (
                  <div className="mt-3 grid gap-2">
                    {materialsLoading && <p className="text-xs text-gray-500">Loading conditions…</p>}
                    {!materialsLoading && materials.length === 0 && <p className="text-xs text-gray-500">No conditions found for this study.</p>}
                    {materials.map((entry) => {
                      const status = scopeStatus(entry.id);
                      return (
                        <label key={entry.id} className={`flex cursor-pointer items-start gap-3 border p-3 ${materialId === entry.id ? "border-cyan-700 bg-cyan-50" : "border-gray-200 bg-white hover:border-gray-300"}`}>
                          <input type="radio" name="condition" checked={materialId === entry.id} onChange={() => { setMaterialId(entry.id); setItemId(""); }} className="mt-1 shrink-0 accent-cyan-700" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                              <span className="text-sm font-semibold text-gray-900">{entry.label}</span>
                              <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold uppercase ${status === "complete" ? "bg-emerald-100 text-emerald-800" : status === "failed" ? "bg-red-100 text-red-800" : status ? "bg-cyan-100 text-cyan-800" : "bg-gray-100 text-gray-500"}`}>
                                {status === "complete" ? "done" : status === "failed" ? "failed" : status ? status : "not run"}
                              </span>
                            </div>
                            {entry.description && <p className="mt-0.5 text-xs text-gray-500">{entry.description}</p>}
                            <p className="mt-0.5 font-mono text-[10px] text-gray-400">{entry.id}</p>
                            {entry.detail && Object.keys(entry.detail).length > 0 && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[11px] font-semibold text-cyan-700">Show condition details</summary>
                                <pre className="mt-2 max-h-48 overflow-auto bg-gray-50 p-2 font-mono text-[11px] leading-5 text-gray-600">{JSON.stringify(entry.detail, null, 2)}</pre>
                              </details>
                            )}
                          </div>
                        </label>
                      );
                    })}
                    <p className="text-xs leading-5 text-gray-500">A scoped run runs only this condition and is evaluated on its responses. Each condition keeps its own cache, so re-running one does not re-bill the others.</p>
                  </div>
                ) : (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="material" className="block text-xs font-semibold text-gray-700">Experiment material</label>
                      <select id="material" value={materialId} disabled={materialsLoading || materials.length === 0} onChange={(event) => { setMaterialId(event.target.value); setItemId(""); }} className="mt-1 h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-cyan-700 disabled:bg-gray-100">
                        {materialsLoading && <option>Loading materials...</option>}
                        {!materialsLoading && materials.length === 0 && <option>No materials found</option>}
                        {materials.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="material-item" className="block text-xs font-semibold text-gray-700">Item <span className="font-normal text-gray-400">optional</span></label>
                      <select id="material-item" value={itemId} disabled={!selectedMaterial?.items.length} onChange={(event) => setItemId(event.target.value)} className="mt-1 h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-cyan-700 disabled:bg-gray-100">
                        <option value="">All items in this material</option>
                        {selectedMaterial?.items.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                      </select>
                    </div>
                    <p className="text-xs leading-5 text-gray-500 sm:col-span-2">A scoped run is evaluated only on the responses produced for this material. Some paper-level tests may be unavailable.</p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="model">Base model</label>
                <div className="mt-2">
                  <SearchSelect
                    id="model"
                    options={MODELS}
                    value={model}
                    onChange={setModel}
                    placeholder="Type a model name or id"
                    display={(option, raw) => (option ? option.label : raw)}
                    customEntry={(query, options) => {
                      if (!OPENROUTER_ID.test(query) || options.some((option) => option.id === query)) return null;
                      return { id: query, hint: "Use this OpenRouter model id." };
                    }}
                  />
                </div>
                <p className="mt-2 font-mono text-xs text-gray-400">{model}</p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="participants">Participants per condition</label>
                <input id="participants" type="number" min={1} max={maxParticipants} value={participants} onChange={(event) => setParticipants(Math.max(1, Math.min(maxParticipants, Number(event.target.value) || 1)))} className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
                <p className="mt-2 text-xs text-gray-500">Up to {maxParticipants} on {apiKey.trim() ? "your key" : "the shared key"}. More participants detect smaller effects.</p>
              </div>

            </div>

            <div className="mt-8 border-t border-gray-100 pt-6">
              <p className="text-sm font-semibold text-gray-950">Participant prompt</p>
              <p className="mt-1 text-sm text-gray-500">What the agent is told before the study starts. This changes results more than anything else here.</p>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {PRESETS.map((entry) => (
                  <div key={entry.id} className={`flex flex-col border ${preset === entry.id ? "border-cyan-700 bg-cyan-50" : "border-gray-200 bg-white"}`}>
                    <button type="button" onClick={() => choosePreset(entry.id)} className="flex-1 p-3 text-left">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-gray-900">{entry.label}</span>
                        {!entry.usesIdentity && <span className="shrink-0 text-[10px] font-semibold uppercase text-gray-400">same for all</span>}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-gray-500">{entry.note}</span>
                    </button>
                    {entry.prompt && (
                      <div className="px-3 pb-3">
                        <button type="button" onClick={() => setShownPrompt((current) => (current === entry.id ? "" : entry.id))} className="text-[11px] font-semibold text-cyan-700 hover:underline">
                          {shownPrompt === entry.id ? "Hide prompt" : "See prompt"}
                        </button>
                        {shownPrompt === entry.id && (
                          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words bg-white/70 p-2 font-mono text-[11px] leading-5 text-gray-600">{entry.prompt}</pre>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {preset === "custom" && (
                <div className="mt-4">
                  <label className="block text-sm font-semibold text-gray-900" htmlFor="prompt">Your participant prompt</label>
                  <textarea id="prompt" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={8} className="mt-2 w-full border border-gray-300 p-3 font-mono text-xs leading-5 outline-none focus:border-cyan-700" placeholder="You are a {{age}}-year-old {{background}} taking part in a decision-making study…" />
                  <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-xs text-gray-500">
                      <code className="bg-gray-100 px-1 font-mono">{"{{age}}"}</code>, <code className="bg-gray-100 px-1 font-mono">{"{{gender}}"}</code>,{" "}
                      <code className="bg-gray-100 px-1 font-mono">{"{{background}}"}</code>, <code className="bg-gray-100 px-1 font-mono">{"{{persona}}"}</code> fill in
                      each agent&apos;s details. Without them, every agent gets this exact prompt.
                    </p>
                    <p className="text-xs text-gray-400">{systemPrompt.length}/6000</p>
                  </div>
                </div>
              )}
            </div>

            {!identityReachesPrompt ? (
              <div className="mt-8 border-t border-gray-100 pt-6">
                <p className="text-sm font-semibold text-gray-950">Who the agents are</p>
                <p className="mt-2 border-l-2 border-gray-300 bg-gray-50 p-3 text-xs leading-5 text-gray-600">
                  This prompt carries no identity, so there is nothing to set. Choose{" "}
                  <span className="font-semibold">Demographics</span> or <span className="font-semibold">Write your own</span> to give the agents one.
                </p>
              </div>
            ) : (
            <div className="mt-8 border-t border-gray-100 pt-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-950">Who the agents are</p>
                  <p className="mt-1 text-sm text-gray-500">{participants} per condition. The study sets how many conditions run.</p>
                </div>
                <div className="flex flex-wrap border border-gray-300">
                  {[["paper", "As the paper recruited"], ["simple", "One identity"], ["personas", "A mix of personas"]].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCastMode(id as CastMode)}
                      className={`px-3 py-2 text-xs font-semibold ${castMode === id ? "bg-cyan-700 text-white" : "bg-white text-gray-600 hover:text-gray-900"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {castMode === "paper" ? (
                <div className="mt-4 border-l-2 border-cyan-700 bg-cyan-50 p-3 text-xs leading-5 text-cyan-950">
                  <span className="font-semibold">Every agent is a different person</span>, sampled from the paper&apos;s
                  recruitment criteria. This is how the benchmark runs, and the right choice for testing whether a model
                  reproduces the published effect.
                </div>
              ) : castMode === "personas" ? (
                <PersonaDesigner
                  studyId={studyId}
                  studyTitle={study?.title || studyId}
                  participants={0}
                  group={personaGroup}
                  onChange={setPersonaGroup}
                />
              ) : (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <p className="text-sm font-semibold text-gray-900">The identity every agent takes</p>
                    <p className="mt-1 text-xs text-gray-500">Applied to all {participants} agents. Anything unset is sampled from the paper.</p>
                    <div className={`mt-3 border-l-2 p-3 text-xs leading-5 ${sameIdentity ? "border-amber-500 bg-amber-50 text-amber-950" : "border-gray-300 bg-gray-50 text-gray-600"}`}>
                      {sameIdentity ? (
                        <>
                          <span className="font-semibold">Every agent is the same person</span> — {identitySummary}. They differ
                          only in what the model answers.
                        </>
                      ) : (
                        <>Nothing set yet, so this run is still identical to <span className="font-semibold">As the paper recruited</span>.</>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700" htmlFor="age">Age</label>
                    <input id="age" value={age} onChange={(event) => setAge(event.target.value)} inputMode="numeric" placeholder="21" className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700" htmlFor="gender">Gender</label>
                    <input id="gender" value={gender} onChange={(event) => setGender(event.target.value)} placeholder="female" className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700" htmlFor="background">Background</label>
                    <input id="background" value={background} onChange={(event) => setBackground(event.target.value)} placeholder="undergraduate student" className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700" htmlFor="persona">Persona note</label>
                    <input id="persona" value={persona} onChange={(event) => setPersona(event.target.value)} placeholder="pretend to be a hospital nurse" className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
                  </div>
                </div>
              )}
            </div>
            )}

            <div className="mt-8 border-t border-gray-100 pt-6">
              <label className="block text-sm font-semibold text-gray-900" htmlFor="api-key">Your OpenRouter key <span className="font-normal text-gray-400">optional</span></label>
              <p className="mt-1 text-sm text-gray-500">The shared key caps runs at 10 participants per condition. Your own key raises it to 80. It is encrypted before storage and deleted when the run ends.</p>
              <div className="mt-2 flex gap-2">
                <input id="api-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder="sk-or-…" className="h-10 w-full border border-gray-300 px-3 font-mono text-sm outline-none focus:border-cyan-700" />
                <button type="button" onClick={() => setShowKey((value) => !value)} className="h-10 shrink-0 border border-gray-300 px-3 text-xs font-semibold text-gray-600 hover:border-gray-400">{showKey ? "Hide" : "Show"}</button>
              </div>
            </div>

            <div className="mt-7 flex items-center justify-between gap-4 border-t border-gray-100 pt-5">
              <p className="text-xs text-gray-500">{running ? "A run is already in progress." : "Takes a few minutes."}</p>
              <button type="button" disabled={busy || running || !model.trim() || (scope === "material" && !materialId)} onClick={start} className="h-10 bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300">
                {busy ? "Starting…" : "Run the study"}
              </button>
            </div>
          </section>

          <aside className="space-y-5">
            {history.length > 0 && (
              <div className="border border-gray-200 bg-white p-5">
                <p className="text-xs font-semibold uppercase text-gray-500">Past runs · {history.length}</p>
                <ul className="mt-3 space-y-1">
                  {history.map((entry) => (
                    <li key={entry.id}>
                      <button type="button" onClick={() => openPastRun(entry.id)} className={`w-full rounded border px-3 py-2 text-left ${entry.id === run?.id ? "border-cyan-700 bg-cyan-50" : "border-gray-200 bg-white hover:border-gray-300"}`}>
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-gray-800">{entry.model}</span>
                          <span className={`shrink-0 text-[10px] font-semibold uppercase ${entry.status === "complete" ? "text-emerald-700" : "text-amber-700"}`}>{entry.status}</span>
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-500">
                          {entry.cached ? "cached · " : ""}{entry.participantsPerScenario} participants · {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="border border-gray-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase text-gray-500">How a run works</p>
              <ol className="mt-4 border-l border-gray-300">
                {[
                  ["Agents take the study", "One model session per participant."],
                  ["Answers are scored", "The study's own evaluator reruns the paper's tests."],
                  ["Human vs. agent", "Effect sizes compared to the published findings."],
                  ["Charts and reading", "An agent charts the run and writes what it shows."],
                ].map(([label, detail], index) => (
                  <li key={label} className="relative pb-6 pl-6">
                    <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-[11px] font-bold">{index + 1}</span>
                    <p className="text-sm font-semibold text-gray-800">{label}</p>
                    <p className="mt-1 text-xs leading-5 text-gray-500">{detail}</p>
                  </li>
                ))}
              </ol>
            </div>
            <div className="border border-cyan-200 bg-cyan-50 p-5">
              <p className="text-sm font-semibold text-cyan-950">A run is not a benchmark score</p>
              <p className="mt-1 text-xs leading-5 text-cyan-900">
                One study at this size is an experiment, not evidence about a model. The{" "}
                <Link href="/results" className="font-semibold underline">leaderboard</Link> reports full runs across every study.
              </p>
            </div>
          </aside>
        </div>

        {run && (
          <section className="mt-10 border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
              <div>
                <p className="text-sm font-semibold text-gray-950">{run.studyTitle || run.studyId}</p>
                <p className="mt-1 font-mono text-xs text-gray-500">{run.model} · {run.preset} · {run.selection?.mode === "material" ? run.selection.label || run.selection.itemId || run.selection.materialId : "whole study"} · run {run.id}</p>
              </div>
              <div className="flex items-center gap-3">
                {run.status === "complete" && run.summary && <button type="button" onClick={downloadReport} className="h-8 border border-gray-300 px-3 text-xs font-semibold text-gray-700 hover:border-cyan-700 hover:text-cyan-800">Download report</button>}
                <button type="button" onClick={reset} className="text-xs font-semibold text-cyan-700 hover:text-cyan-900">Start another run</button>
                <span className={`px-2 py-1 text-xs font-semibold ${run.status === "failed" ? "bg-red-100 text-red-800" : run.status === "complete" ? "bg-emerald-100 text-emerald-800" : "bg-cyan-100 text-cyan-800"}`}>{run.status}</span>
              </div>
            </div>

            {running && (
              <div className="p-6">
                {stalled && (
                  <div className="mb-5 border-l-2 border-amber-500 bg-amber-50 p-4">
                    <p className="text-sm font-semibold text-amber-950">This run has not started yet</p>
                    <p className="mt-1 text-sm leading-6 text-amber-900">GitHub Actions has not given it a runner. Your settings are saved, so restarting costs nothing.</p>
                    <button type="button" disabled={busy} onClick={retry} className="mt-3 h-9 bg-amber-700 px-4 text-xs font-semibold text-white hover:bg-amber-600 disabled:bg-gray-300">{busy ? "Restarting…" : "Restart this run"}</button>
                  </div>
                )}
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-950">{progress ? PHASES[progress.phase] : run.message}</p>
                    <p className="mt-1 text-xs text-gray-500">{progress?.message || "Waiting for the first update"}</p>
                  </div>
                  {total > 0 && <p className="font-mono text-sm font-semibold text-cyan-800">{Math.round((completed / total) * 100)}%</p>}
                </div>
                <div className="mt-3 h-2 overflow-hidden bg-gray-100">
                  {total > 0
                    ? <div className="h-full bg-cyan-700 transition-[width] duration-500" style={{ width: `${Math.min(100, (completed / total) * 100)}%` }} />
                    : <div className="h-full w-1/2 animate-pulse bg-cyan-700" />}
                </div>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <p className="text-xs text-gray-500">Iterate faster: stop the run and the sessions finished so far are scored and charted.</p>
                  <button type="button" disabled={busy} onClick={stop} className="h-9 shrink-0 border border-red-300 bg-white px-4 text-xs font-semibold text-red-700 hover:border-red-500 disabled:bg-gray-100 disabled:text-gray-400">{busy ? "Stopping…" : "Stop run & see partial results"}</button>
                </div>
                {log && <pre className="mt-5 max-h-64 overflow-auto bg-gray-950 p-4 text-xs leading-5 text-gray-200">{log}</pre>}
              </div>
            )}

            {run.status === "failed" && (
              <div className="p-6">
                <p className="border-l-2 border-red-600 bg-red-50 p-4 text-sm leading-6 text-red-900">{run.error || run.message}</p>
                <button type="button" disabled={busy} onClick={retry} className="mt-4 h-9 border border-gray-300 px-4 text-xs font-semibold text-gray-700 hover:border-gray-400 disabled:text-gray-300">{busy ? "Restarting…" : "Run it again"}</button>
                {log && <pre className="mt-5 max-h-64 overflow-auto bg-gray-950 p-4 text-xs leading-5 text-gray-200">{log}</pre>}
              </div>
            )}

            {run.status === "complete" && (
              <div className="space-y-6 p-6">
                {run.partial && (
                  <div className="border-l-2 border-amber-500 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                    This run was stopped early, so the results below cover only the sessions that had finished by then. Run the remaining conditions separately, or run the whole study again to resume from the saved cache.
                  </div>
                )}
                {run.summary && (
                  <div className="grid gap-px bg-gray-200 sm:grid-cols-4">
                    {[
                      ["Direction matched", percent(run.summary.directionMatchRate), "Effect pointed the same way as in humans"],
                      ["Mean effect gap", decimal(run.summary.meanAbsoluteEffectGap), "Average distance from the human effect size"],
                      ["Participants", String(run.participants ?? "—"), `${run.answeredTrials ?? 0} answers collected`],
                      [
                        "Strict replication",
                        run.summary.scoredTests > 0 ? `${run.summary.replicatedTests}/${run.summary.scoredTests}` : "Not available",
                        run.summary.scoredTests > 0
                          ? "Optional benchmark check: same direction and significance"
                          : "No tests had both direction and significance available",
                      ],
                    ].map(([label, value, note]) => (
                      <div key={label} className="bg-white p-4">
                        <p className="text-[11px] font-semibold uppercase text-gray-500">{label}</p>
                        <p className="mt-1 font-serif text-2xl font-bold text-gray-950">{value}</p>
                        <p className="mt-1 text-[11px] leading-4 text-gray-500">{note}</p>
                      </div>
                    ))}
                  </div>
                )}

                {!charts && <p className="border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">Loading the charts for this run…</p>}
                {charts && charts.charts.length === 0 && (
                  <div className="border-l-2 border-amber-500 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                    This run produced no scoreable answers, so there is nothing to compare against the paper. The most
                    common cause is a model that did not follow the study&apos;s answer format — the sampled responses
                    below show what it actually returned. Try a different model, or a prompt that stresses the response
                    format.
                  </div>
                )}
                {charts && charts.charts.length > 0 && (
                  <PlaygroundCharts charts={charts.charts} interpretation={charts.interpretation} source={charts.source} />
                )}

                {analysis && analysis.tests.length > 0 && (
                  <section className="border border-gray-200">
                    <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900">Test-by-test review</p>
                          <p className="mt-1 text-xs text-gray-500">Effect sizes include significance: * p&lt;.05, ** p&lt;.01, *** p&lt;.001.</p>
                        </div>
                        <button type="button" disabled={reviewSaving || reviewSaved} onClick={saveReview} className="h-8 bg-cyan-700 px-3 text-xs font-semibold text-white disabled:bg-gray-300">{reviewSaving ? "Saving..." : reviewSaved ? "Saved" : "Save review"}</button>
                      </div>
                      <label htmlFor="study-review" className="mt-4 block text-xs font-semibold text-gray-700">Study-level annotation</label>
                      <textarea id="study-review" value={review.studyNote} onChange={(event) => { setReview((current) => ({ ...current, studyNote: event.target.value })); setReviewSaved(false); }} rows={2} placeholder="Overall interpretation, caveats, or follow-up decisions" className="mt-1 w-full border border-gray-300 bg-white p-2 text-xs leading-5 outline-none focus:border-cyan-700" />
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[980px] text-left text-sm">
                        <thead className="bg-white text-[11px] uppercase text-gray-500">
                          <tr>
                            <th className="px-4 py-2 font-semibold">Test</th>
                            <th className="px-4 py-2 font-semibold">Paper</th>
                            <th className="px-4 py-2 font-semibold">Human d</th>
                            <th className="px-4 py-2 font-semibold">Agent d</th>
                            <th className="px-4 py-2 font-semibold">Agent p</th>
                            <th className="px-4 py-2 font-semibold">Result</th>
                            <th className="px-4 py-2 font-semibold">Item annotation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.tests.map((row) => (
                            <tr key={row.test_id} className="border-t border-gray-100 align-top">
                              <td className="px-4 py-3">
                                <span className="block font-semibold text-gray-900">{row.label}</span>
                                {row.hypothesis && <span className="mt-1 block max-w-md text-xs leading-5 text-gray-500">{row.hypothesis}</span>}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-600">{row.reported_statistics || "—"}</td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-700">{decimal(row.human_effect)}<sup className="font-bold text-cyan-800">{significanceStars(row.human_p, row.human_significant)}</sup></td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-700">{decimal(row.agent_effect)}<sup className="font-bold text-cyan-800">{significanceStars(row.agent_p, row.agent_significant)}</sup></td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-700">{row.agent_p === null ? "—" : row.agent_p < 0.001 ? "<.001" : row.agent_p.toFixed(3)}</td>
                              <td className="px-4 py-3"><Verdict row={row} /></td>
                              <td className="w-64 px-4 py-3"><textarea aria-label={`Annotation for ${row.label}`} value={review.itemNotes[row.test_id] || ""} onChange={(event) => { const note = event.target.value; setReview((current) => ({ ...current, itemNotes: { ...current.itemNotes, [row.test_id]: note } })); setReviewSaved(false); }} rows={2} placeholder="Add a note" className="w-full border border-gray-300 p-2 text-xs leading-4 outline-none focus:border-cyan-700" /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {transcript.length > 0 && (
                  <details className="border border-gray-200 bg-white p-4">
                    <summary className="cursor-pointer text-sm font-semibold text-gray-900">What the agents actually saw and said ({transcript.length} samples)</summary>
                    <div className="mt-4 space-y-4">
                      {transcript.map((sample, index) => (
                        <div key={index} className="border-l-2 border-cyan-700 pl-4">
                          <p className="text-xs font-semibold text-gray-700">
                            Participant {sample.participantId}
                            {Object.entries(sample.profile || {}).length > 0 && (
                              <span className="font-normal text-gray-500"> · {Object.entries(sample.profile).map(([key, value]) => `${key}: ${value}`).join(", ")}</span>
                            )}
                          </p>
                          {sample.prompt && <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap bg-gray-50 p-3 text-[11px] leading-5 text-gray-600">{sample.prompt}</pre>}
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap bg-cyan-50 p-3 text-[11px] leading-5 text-cyan-950">{sample.response || "(no answer)"}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
