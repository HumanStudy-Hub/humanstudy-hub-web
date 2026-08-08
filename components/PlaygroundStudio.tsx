"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import PlaygroundCharts, { type PlaygroundChartSet } from "@/components/PlaygroundCharts";

const STORAGE_KEY = "humanstudy-hub-playground-run";
// A dispatched run reports back within a minute or so. Longer than this and no
// runner ever picked it up.
const STALL_MS = 5 * 60 * 1000;

export type StudyOption = { study_id: string; title: string; year: number | null };

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
  createdAt?: string;
};
type TestRow = {
  test_id: string;
  label: string;
  hypothesis: string | null;
  reported_statistics: string | null;
  human_effect: number | null;
  agent_effect: number | null;
  agent_p: number | null;
  human_significant: boolean | null;
  agent_significant: boolean | null;
  direction_match: boolean | null;
  replicated: boolean | null;
};
type Analysis = { summary: Summary; tests: TestRow[] };
type Transcript = Array<{ participantId: number; profile: Record<string, string | number>; prompt: string | null; response: string | null }>;

const MODELS = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini", note: "Fast and inexpensive" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", note: "Strong instruction following" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast, low cost" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", note: "Open weights" },
];

const PRESETS = [
  { id: "v1_empty", label: "No framing", note: "The model receives the task with no participant instruction at all." },
  { id: "v2_human", label: "Human participant", note: "“You are participating in a psychology experiment as a human participant.”" },
  { id: "v3_human_plus_demo", label: "Human + demographics", note: "Adds the age, gender, and background of the person the agent is playing." },
  { id: "v4_background", label: "Generated background", note: "Uses a fuller life-history background written for this study." },
  { id: "custom", label: "Write your own", note: "Design the participant prompt yourself." },
];

const PRESET_STARTERS: Record<string, string> = {
  v2_human: "You are participating in a psychology experiment as a human participant.",
  v3_human_plus_demo:
    "You are participating in a psychology experiment as a human participant.\n\nYOUR IDENTITY:\n- Age: 21 years old\n- Gender: female\n- Background: undergraduate student\n\nFollow the experimenter's instructions and answer each task in the requested format.\nBe concise. Do not add extra explanations unless explicitly asked.",
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

function Verdict({ row }: { row: TestRow }) {
  if (row.replicated) return <span className="bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-800">Reproduced</span>;
  if (row.direction_match === false) return <span className="bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900">Wrong direction</span>;
  if (row.replicated === false) return <span className="bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600">No effect</span>;
  return <span className="text-[11px] text-gray-400">Not scored</span>;
}

export default function PlaygroundStudio({ studies }: { studies: StudyOption[] }) {
  const [studyId, setStudyId] = useState(studies[0]?.study_id || "study_001");
  const [model, setModel] = useState(MODELS[0].id);
  const [customModel, setCustomModel] = useState("");
  const [preset, setPreset] = useState("v3_human_plus_demo");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [background, setBackground] = useState("");
  const [persona, setPersona] = useState("");
  const [participants, setParticipants] = useState(8);
  const [temperature, setTemperature] = useState(1);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [run, setRun] = useState<Run | null>(null);
  const [charts, setCharts] = useState<PlaygroundChartSet | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [transcript, setTranscript] = useState<Transcript>([]);
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stalled, setStalled] = useState(false);
  const resultsLoaded = useRef("");

  const maxParticipants = apiKey.trim() ? 80 : 10;
  const chosenModel = model === "custom" ? customModel.trim() : model;
  const study = useMemo(() => studies.find((entry) => entry.study_id === studyId), [studies, studyId]);

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
  const sameIdentity = identitySummary.length > 0;

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
      setSystemPrompt(PRESET_STARTERS.v3_human_plus_demo);
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
          model: chosenModel,
          preset,
          systemPrompt: preset === "custom" ? systemPrompt : "",
          demographics: { age, gender, background, persona },
          participantsPerScenario: participants,
          temperature,
          apiKey: apiKey.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start this run.");
      setCharts(null);
      setAnalysis(null);
      setTranscript([]);
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

  function reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState({}, "", "/playground");
    setRun(null);
    setCharts(null);
    setAnalysis(null);
    setTranscript([]);
    setLog("");
    resultsLoaded.current = "";
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
            Pick a study, choose a model, and design the prompt your agent takes into the experiment. The run is scored
            against the paper&apos;s published findings, and the results show where the agent behaved like the original
            participants and where it did not.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-9 sm:px-8">
        {error && <p className="mb-6 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="border border-gray-200 bg-white p-6 shadow-sm">
            <div className="border-b border-gray-100 pb-5">
              <p className="text-sm font-semibold text-gray-950">Experiment setup</p>
              <p className="mt-1 text-sm text-gray-500">Everything except the prompt matches how the benchmark runs this study.</p>
            </div>

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="block text-sm font-semibold text-gray-900" htmlFor="study">Study</label>
                <select id="study" value={studyId} onChange={(event) => setStudyId(event.target.value)} className="mt-2 h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-cyan-700">
                  {studies.map((entry) => (
                    <option key={entry.study_id} value={entry.study_id}>
                      {entry.study_id} — {entry.title.length > 80 ? `${entry.title.slice(0, 80)}…` : entry.title}
                    </option>
                  ))}
                </select>
                {study && (
                  <p className="mt-2 text-xs text-gray-500">
                    <Link href={`/studies/${study.study_id}`} className="font-semibold text-cyan-700 hover:underline">Open the study record</Link>
                    {study.year ? ` · published ${study.year}` : ""}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="model">Base model</label>
                <select id="model" value={model} onChange={(event) => setModel(event.target.value)} className="mt-2 h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-cyan-700">
                  {MODELS.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.label}</option>
                  ))}
                  <option value="custom">Another OpenRouter model…</option>
                </select>
                <p className="mt-2 text-xs text-gray-500">{model === "custom" ? "Any model id OpenRouter serves." : MODELS.find((entry) => entry.id === model)?.note}</p>
                {model === "custom" && (
                  <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="provider/model-name" className="mt-2 h-10 w-full border border-gray-300 px-3 font-mono text-sm outline-none focus:border-cyan-700" />
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="participants">Participants per condition</label>
                <input id="participants" type="number" min={1} max={maxParticipants} value={participants} onChange={(event) => setParticipants(Math.max(1, Math.min(maxParticipants, Number(event.target.value) || 1)))} className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
                <p className="mt-2 text-xs text-gray-500">Up to {maxParticipants} on {apiKey.trim() ? "your own key" : "the shared key"}. More participants make small effects detectable.</p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="temperature">Temperature</label>
                <input id="temperature" type="range" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} className="mt-4 w-full accent-cyan-700" />
                <p className="mt-1 text-xs text-gray-500">{temperature.toFixed(1)} — response variability across participants.</p>
              </div>
            </div>

            <div className="mt-8 border-t border-gray-100 pt-6">
              <p className="text-sm font-semibold text-gray-950">Participant prompt</p>
              <p className="mt-1 text-sm text-gray-500">What the agent is told it is before the study begins. This is the design choice that changes results the most.</p>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {PRESETS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => choosePreset(entry.id)}
                    className={`border p-3 text-left ${preset === entry.id ? "border-cyan-700 bg-cyan-50" : "border-gray-200 bg-white hover:border-cyan-300"}`}
                  >
                    <span className="block text-sm font-semibold text-gray-900">{entry.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-gray-500">{entry.note}</span>
                  </button>
                ))}
              </div>

              {preset === "custom" ? (
                <div className="mt-4">
                  <label className="block text-sm font-semibold text-gray-900" htmlFor="prompt">Your participant prompt</label>
                  <textarea id="prompt" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={8} className="mt-2 w-full border border-gray-300 p-3 font-mono text-xs leading-5 outline-none focus:border-cyan-700" placeholder="You are a 34-year-old nurse taking part in a decision-making study…" />
                  <p className="mt-1 text-xs text-gray-400">{systemPrompt.length}/6000 characters</p>
                </div>
              ) : (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <p className="text-sm font-semibold text-gray-900">Who the agent should be <span className="font-normal text-gray-400">optional</span></p>
                    <p className="mt-1 text-xs text-gray-500">
                      One identity, applied to every agent in the run. Leave the fields blank and each agent instead
                      gets its own age and gender, drawn the way the paper recruited.
                    </p>
                    <div className={`mt-3 border-l-2 p-3 text-xs leading-5 ${sameIdentity ? "border-amber-500 bg-amber-50 text-amber-950" : "border-cyan-700 bg-cyan-50 text-cyan-950"}`}>
                      {sameIdentity ? (
                        <>
                          <span className="font-semibold">Every agent will be the same person</span> — {identitySummary}. Your
                          {" "}{participants} agents per condition differ only in what the model happens to answer.
                          {temperature <= 0.2 && (
                            <span className="mt-1 block font-semibold">
                              At temperature {temperature.toFixed(1)} they will also answer near-identically, which leaves
                              too little variation between participants for the study&apos;s statistical tests. Raise the
                              temperature, or leave these fields blank.
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="font-semibold">Each agent is a different person</span> — age and gender are
                          sampled per agent from the study&apos;s recruitment criteria. This is how the benchmark itself
                          runs, so it is the right choice for asking whether a model reproduces the published effect.
                        </>
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

            <div className="mt-8 border-t border-gray-100 pt-6">
              <label className="block text-sm font-semibold text-gray-900" htmlFor="api-key">Your OpenRouter key <span className="font-normal text-gray-400">optional</span></label>
              <p className="mt-1 text-sm text-gray-500">Runs use the shared HumanStudy-Hub key with a small participant cap. Supply your own key to run at full size; it is encrypted before it is stored and deleted when the run ends.</p>
              <div className="mt-2 flex gap-2">
                <input id="api-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder="sk-or-…" className="h-10 w-full border border-gray-300 px-3 font-mono text-sm outline-none focus:border-cyan-700" />
                <button type="button" onClick={() => setShowKey((value) => !value)} className="h-10 shrink-0 border border-gray-300 px-3 text-xs font-semibold text-gray-600 hover:border-gray-400">{showKey ? "Hide" : "Show"}</button>
              </div>
            </div>

            <div className="mt-7 flex items-center justify-between gap-4 border-t border-gray-100 pt-5">
              <p className="text-xs text-gray-500">{running ? "A run is already in progress." : "Runs take a few minutes."}</p>
              <button type="button" disabled={busy || running || (model === "custom" && !customModel.trim())} onClick={start} className="h-10 bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300">
                {busy ? "Starting…" : "Run the study"}
              </button>
            </div>
          </section>

          <aside className="space-y-5">
            <div className="border border-gray-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase text-gray-500">How a run works</p>
              <ol className="mt-4 border-l border-gray-300">
                {[
                  ["Agents take the study", "Each participant is a separate model session with your prompt."],
                  ["Answers are scored", "The study's own evaluator reproduces the paper's statistical tests."],
                  ["Human vs. agent", "Effect sizes are compared against the published findings."],
                  ["Charts and reading", "An analysis agent charts the run and writes what it shows."],
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
                One study at a small participant count is an experiment, not evidence about a model in general. The
                <Link href="/results" className="font-semibold underline"> leaderboard</Link> reports full-size runs across every study.
              </p>
            </div>
          </aside>
        </div>

        {run && (
          <section className="mt-10 border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
              <div>
                <p className="text-sm font-semibold text-gray-950">{run.studyTitle || run.studyId}</p>
                <p className="mt-1 font-mono text-xs text-gray-500">{run.model} · {run.preset} · run {run.id}</p>
              </div>
              <div className="flex items-center gap-3">
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
                {run.summary && (
                  <div className="grid gap-px bg-gray-200 sm:grid-cols-4">
                    {[
                      ["Findings reproduced", `${run.summary.replicatedTests}/${run.summary.scoredTests}`, "Same direction and significance as the paper"],
                      ["Direction matched", percent(run.summary.directionMatchRate), "Effect pointed the same way as in humans"],
                      ["Mean effect gap", decimal(run.summary.meanAbsoluteEffectGap), "Average distance from the human effect size"],
                      ["Participants", String(run.participants ?? "—"), `${run.answeredTrials ?? 0} answers collected`],
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
                      <p className="text-sm font-semibold text-gray-900">Test by test</p>
                      <p className="mt-1 text-xs text-gray-500">Every statistical test the paper reported, and what the agent produced for it.</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[720px] text-left text-sm">
                        <thead className="bg-white text-[11px] uppercase text-gray-500">
                          <tr>
                            <th className="px-4 py-2 font-semibold">Test</th>
                            <th className="px-4 py-2 font-semibold">Paper</th>
                            <th className="px-4 py-2 font-semibold">Human d</th>
                            <th className="px-4 py-2 font-semibold">Agent d</th>
                            <th className="px-4 py-2 font-semibold">Agent p</th>
                            <th className="px-4 py-2 font-semibold">Result</th>
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
                              <td className="px-4 py-3 font-mono text-xs text-gray-700">{decimal(row.human_effect)}</td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-700">{decimal(row.agent_effect)}</td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-700">{row.agent_p === null ? "—" : row.agent_p < 0.001 ? "<.001" : row.agent_p.toFixed(3)}</td>
                              <td className="px-4 py-3"><Verdict row={row} /></td>
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
