import crypto from "node:crypto";
import { normaliseGroup, type PersonaGroup } from "@/lib/persona-groups";
import { Octokit } from "@octokit/rest";

export type PlaygroundStatus = "queued" | "running" | "analysing" | "complete" | "failed";

export type PlaygroundProgress = {
  phase: "preparing" | "running_participants" | "scoring" | "charting" | "failed";
  completedTrials?: number;
  totalTrials?: number;
  message?: string;
  updatedAt: string;
};

export type PlaygroundSummary = {
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

// A run can replay the whole study or be scoped to one experiment material (and
// optionally one item inside it). The runner narrows the trials accordingly.
export type PlaygroundSelection = {
  mode: "whole" | "material";
  materialId?: string;
  itemId?: string;
  label?: string;
};

export type PlaygroundReview = {
  studyNote: string;
  itemNotes: Record<string, string>;
  updatedAt?: string;
};

export type PlaygroundRun = {
  id: string;
  studyId: string;
  studyTitle?: string;
  jobId?: string;
  packageSlug?: string;
  cached?: boolean;
  model: string;
  preset: string;
  systemPrompt?: string;
  demographics?: Record<string, string | number>;
  personaGroup?: PersonaGroup;
  participantsPerScenario: number;
  temperature: number;
  seed: number;
  selection?: PlaygroundSelection;
  researcherName?: string;
  usedOwnKey?: boolean;
  status: PlaygroundStatus;
  message: string;
  error?: string;
  resultsReady?: boolean;
  participants?: number;
  completedTrials?: number;
  answeredTrials?: number;
  totalTokens?: number;
  summary?: PlaygroundSummary;
  progress?: PlaygroundProgress;
  workflowRunId?: number;
  partial?: boolean;
  coverage?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
};

export type PlaygroundResults = {
  analysis: unknown;
  charts: unknown;
  transcript: unknown;
};

const jobsRepo = process.env.GITHUB_JOBS_REPO || "HumanStudy-Hub/humanstudy-hub-jobs";
const benchRepo = process.env.GITHUB_PIPELINE_REPO || "HumanStudy-Hub/HumanStudy-Bench";
const workflowFile = "run-playground.yml";

// Kept in step with playground/settings.py; the runner enforces them again.
export const SHARED_KEY_MAX_PER_SCENARIO = 10;
export const OWN_KEY_MAX_PER_SCENARIO = 80;
// v4_background is supported by the runner but not offered here: it reads
// per-participant background files that no study ships yet, so it would silently
// behave as plain demographics.
export const PROMPT_PRESETS = ["v1_empty", "v2_human", "v3_human_plus_demo", "custom"] as const;

function octokit() {
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured.");
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

// The deployment token (GITHUB_TOKEN) may not be allowed to read the private
// jobs repository. GITHUB_JOBS_TOKEN lets that access ride a separate token;
// when unset, jobs calls fall back to GITHUB_TOKEN exactly as before.
function jobsOctokit() {
  const token = process.env.GITHUB_JOBS_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_JOBS_TOKEN (or GITHUB_TOKEN) is not configured.");
  return new Octokit({ auth: token });
}

function splitRepo(repo: string) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid GitHub repository: ${repo}`);
  return { owner, repo: name };
}

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function runPath(id: string, suffix: string) {
  return `runs/${safe(id)}/${suffix}`;
}

function branchName(id: string) {
  return `runs/${safe(id)}`;
}

async function defaultBranch(repo: string) {
  const api = repo === jobsRepo ? jobsOctokit() : octokit();
  const result = await api.repos.get({ ...splitRepo(repo) });
  return result.data.default_branch;
}

async function branchSha(branch: string) {
  const api = jobsOctokit();
  const ref = await api.git.getRef({ ...splitRepo(jobsRepo), ref: `heads/${branch}` });
  return ref.data.object.sha;
}

async function ensureBranch(branch: string) {
  const api = jobsOctokit();
  try {
    await branchSha(branch);
    return;
  } catch {
    let sha: string;
    try {
      sha = await branchSha(await defaultBranch(jobsRepo));
    } catch {
      throw new Error(`GitHub cannot access ${jobsRepo}. Add this repository to the fine-grained token and grant Contents read/write.`);
    }
    await api.git.createRef({ ...splitRepo(jobsRepo), ref: `refs/heads/${branch}`, sha });
  }
}

async function putFile(branch: string, filePath: string, content: string, message: string) {
  const api = jobsOctokit();
  const target = splitRepo(jobsRepo);
  let sha: string | undefined;
  try {
    const existing = await api.repos.getContent({ ...target, path: filePath, ref: branch });
    if (!Array.isArray(existing.data) && "sha" in existing.data) sha = existing.data.sha;
  } catch {
    // A new run has no prior blob.
  }
  await api.repos.createOrUpdateFileContents({
    ...target,
    path: filePath,
    branch,
    message,
    content: Buffer.from(content).toString("base64"),
    ...(sha ? { sha } : {}),
  });
}

async function getFile(branch: string, filePath: string) {
  const api = jobsOctokit();
  const result = await api.repos.getContent({ ...splitRepo(jobsRepo), path: filePath, ref: branch });
  if (Array.isArray(result.data) || !("content" in result.data)) throw new Error(`Not a file: ${filePath}`);
  return Buffer.from(result.data.content, "base64").toString("utf8");
}

async function getJson(branch: string, filePath: string) {
  try {
    return JSON.parse(await getFile(branch, filePath));
  } catch {
    return null;
  }
}

// A researcher's own OpenRouter key never reaches the jobs repository in the
// clear: it is sealed here and only the Actions runner, which holds the same
// PLAYGROUND_KEY_SECRET, can open it.
function sealApiKey(apiKey: string) {
  const secret = process.env.PLAYGROUND_KEY_SECRET;
  if (!secret) throw new Error("This deployment cannot accept your own API key yet. Run without a key, or ask an administrator to configure PLAYGROUND_KEY_SECRET.");
  const key = crypto.createHash("sha256").update(secret, "utf8").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

// createWorkflowDispatch returns 204 whether or not a run was queued, so confirm
// one actually appeared rather than leaving the run stuck on "queued". Returns
// the workflow run id so the run can be stopped later.
async function dispatchStarted(after: Date): Promise<number | null> {
  const api = octokit();
  const target = splitRepo(benchRepo);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const runs = await api.actions.listWorkflowRuns({ ...target, workflow_id: workflowFile, event: "workflow_dispatch", per_page: 20 });
      const run = runs.data.workflow_runs.find((entry) => new Date(entry.created_at) >= after);
      if (run) return run.id;
    } catch {
      // A transient list failure is not proof the run is missing.
    }
  }
  return null;
}

async function dispatch(id: string): Promise<number | null> {
  const api = octokit();
  const after = new Date(Date.now() - 5000);
  await api.actions.createWorkflowDispatch({
    ...splitRepo(benchRepo),
    workflow_id: workflowFile,
    ref: process.env.GITHUB_PIPELINE_REF || "main",
    inputs: { run_id: id, jobs_repo: jobsRepo },
  });
  return dispatchStarted(after);
}

export type CreateRunInput = {
  studyId: string;
  jobId?: string;
  packageSlug?: string;
  model: string;
  preset: string;
  systemPrompt?: string;
  demographics?: Record<string, string | number>;
  personaGroup?: unknown;
  participantsPerScenario: number;
  temperature?: number;
  seed?: number;
  researcherName?: string;
  apiKey?: string;
  selection?: PlaygroundSelection;
};

// Only the profile fields the participant prompts actually read, so an arbitrary
// object cannot be pushed into the run configuration.
const DEMOGRAPHIC_FIELDS = ["age", "gender", "education", "background", "population", "persona"] as const;

function selectionKey(value: unknown) {
  const key = String(value || "").trim().slice(0, 160);
  return /^[a-zA-Z0-9_.:-]+$/.test(key) ? key : "";
}

function cleanDemographics(value: CreateRunInput["demographics"]) {
  if (!value || typeof value !== "object") return undefined;
  const cleaned: Record<string, string | number> = {};
  for (const field of DEMOGRAPHIC_FIELDS) {
    const entry = value[field];
    if (entry === undefined || entry === null || entry === "") continue;
    if (field === "age") {
      const age = Number(entry);
      if (Number.isFinite(age) && age >= 1 && age <= 120) cleaned.age = Math.floor(age);
      continue;
    }
    cleaned[field] = String(entry).slice(0, 400);
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function validate(input: CreateRunInput) {
  const studyId = String(input.studyId || "").trim();
  if (!/^[a-zA-Z0-9_-]{3,60}$/.test(studyId)) throw new Error("Choose a study to run.");
  const model = String(input.model || "").trim();
  if (!/^[a-zA-Z0-9._\-]+\/[a-zA-Z0-9._\-:]+$/.test(model)) {
    throw new Error("Enter an OpenRouter model id, for example anthropic/claude-sonnet-5.");
  }
  const preset = String(input.preset || "v3_human_plus_demo");
  if (!PROMPT_PRESETS.includes(preset as (typeof PROMPT_PRESETS)[number])) throw new Error("Choose a participant prompt.");
  const systemPrompt = String(input.systemPrompt || "").trim();
  if (preset === "custom" && !systemPrompt) throw new Error("Write the prompt your agent should receive, or choose a preset.");
  if (systemPrompt.length > 6000) throw new Error("The participant prompt is too long; keep it under 6000 characters.");
  const apiKey = String(input.apiKey || "").trim();
  const limit = apiKey ? OWN_KEY_MAX_PER_SCENARIO : SHARED_KEY_MAX_PER_SCENARIO;
  const requested = Number(input.participantsPerScenario) || 8;
  if (!Number.isFinite(requested) || requested < 1) throw new Error("Choose how many participants run each condition.");
  // A persona group replaces the study's own participant sampling, so it is
  // validated here rather than discovered to be unusable on the runner.
  const personaGroup = input.personaGroup ? normaliseGroup(input.personaGroup) : undefined;
  const requestedSelection = input.selection;
  const selection: PlaygroundSelection = requestedSelection?.mode === "material"
    ? {
        mode: "material",
        materialId: selectionKey(requestedSelection.materialId),
        itemId: requestedSelection.itemId ? selectionKey(requestedSelection.itemId) : undefined,
        label: String(requestedSelection.label || "").trim().slice(0, 200) || undefined,
      }
    : { mode: "whole" };
  if (selection.mode === "material" && !selection.materialId) throw new Error("Choose a material to run.");
  return {
    studyId,
    jobId: input.jobId?.trim() || undefined,
    packageSlug: input.packageSlug?.trim() || undefined,
    model,
    preset,
    systemPrompt,
    apiKey,
    demographics: personaGroup ? undefined : cleanDemographics(input.demographics),
    personaGroup,
    participantsPerScenario: Math.min(Math.floor(requested), limit),
    temperature: Math.min(2, Math.max(0, Number(input.temperature ?? 1))),
    seed: Math.floor(Number(input.seed ?? 42)) || 42,
    selection,
  };
}

// Every completed run for one study, newest first. Used both to show the
// study's run history and to reuse a previous result instead of re-running.
export async function listRunsByStudy(studyId: string): Promise<PlaygroundRun[]> {
  const api = jobsOctokit();
  const target = splitRepo(jobsRepo);
  const branches = await api.paginate(api.repos.listBranches, { ...target, per_page: 100 });
  const runBranches = branches.filter((branch) => branch.name.startsWith("runs/"));
  const out: PlaygroundRun[] = [];
  for (let i = 0; i < runBranches.length; i += 8) {
    const chunk = runBranches.slice(i, i + 8);
    const results = await Promise.all(chunk.map(async (branch): Promise<PlaygroundRun | null> => {
      const id = branch.name.slice("runs/".length);
      try {
        const run = await getJson(branch.name, runPath(id, "run.json"));
        if (!run || run.studyId !== studyId) return null;
        const coverage = await getJson(branch.name, runPath(id, "output/coverage.json"));
        return { ...(run as PlaygroundRun), ...(coverage && typeof coverage === "object" ? { coverage: coverage as Record<string, number> } : {}) };
      } catch {
        return null;
      }
    }));
    for (const result of results) if (result) out.push(result);
  }
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function findCachedRun(checked: ReturnType<typeof validate>): Promise<PlaygroundRun | null> {
  for (const run of await listRunsByStudy(checked.studyId)) {
    if (run.status !== "complete" || !run.resultsReady) continue;
    if ((run.jobId ?? undefined) !== (checked.jobId ?? undefined)) continue;
    if (run.model !== checked.model) continue;
    if (run.preset !== checked.preset) continue;
    if ((run.systemPrompt ?? "") !== (checked.systemPrompt ?? "")) continue;
    if (run.participantsPerScenario !== checked.participantsPerScenario) continue;
    if ((run.temperature ?? 1) !== checked.temperature) continue;
    if ((run.seed ?? 42) !== checked.seed) continue;
    if (JSON.stringify(run.demographics ?? null) !== JSON.stringify(checked.demographics ?? null)) continue;
    if (JSON.stringify(run.personaGroup ?? null) !== JSON.stringify(checked.personaGroup ?? null)) continue;
    if (JSON.stringify(run.selection ?? null) !== JSON.stringify(checked.selection ?? null)) continue;
    return run;
  }
  return null;
}

export async function createRun(input: CreateRunInput) {
  const checked = validate(input);
  const cached = await findCachedRun(checked);
  if (cached) return { ...cached, cached: true };
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const branch = branchName(id);
  await ensureBranch(branch);
  const now = new Date().toISOString();
  const run: PlaygroundRun = {
    id,
    studyId: checked.studyId,
    jobId: checked.jobId,
    packageSlug: checked.packageSlug,
    model: checked.model,
    preset: checked.preset,
    systemPrompt: checked.systemPrompt || undefined,
    demographics: checked.demographics,
    personaGroup: checked.personaGroup,
    participantsPerScenario: checked.participantsPerScenario,
    temperature: checked.temperature,
    seed: checked.seed,
    selection: checked.selection,
    researcherName: input.researcherName?.trim() || undefined,
    usedOwnKey: Boolean(checked.apiKey),
    status: "queued",
    message: "Waiting for a runner to pick up this run",
    createdAt: now,
    updatedAt: now,
  };
  const stored = checked.apiKey ? { ...run, sealedApiKey: sealApiKey(checked.apiKey) } : run;
  await putFile(branch, runPath(id, "run.json"), JSON.stringify(stored, null, 2) + "\n", `playground: create ${id}`);

  const workflowRunId = await dispatch(id);
  if (workflowRunId) {
    const withWorkflow = { ...run, workflowRunId };
    await putFile(branch, runPath(id, "run.json"), JSON.stringify(withWorkflow, null, 2) + "\n", `playground: workflow ${workflowRunId}`);
    return withWorkflow;
  }
  const failed: PlaygroundRun = {
    ...run,
    status: "failed",
    message: "The run could not be started",
    error: "GitHub Actions did not start a run. Please try again.",
    updatedAt: new Date().toISOString(),
  };
  await putFile(branch, runPath(id, "run.json"), JSON.stringify(failed, null, 2) + "\n", `playground: dispatch failed ${id}`);
  return failed;
}

export async function readRun(id: string): Promise<PlaygroundRun> {
  const branch = branchName(id);
  const raw = await getJson(branch, runPath(id, "run.json"));
  if (!raw) throw new Error("This run could not be found.");
  // The sealed key lives only in storage and must never reach a browser.
  const run = { ...(raw as PlaygroundRun & { sealedApiKey?: unknown }) };
  delete run.sealedApiKey;
  const progress = await getJson(branch, runPath(id, "progress.json"));
  return progress ? { ...run, progress } : run;
}

export async function readLog(id: string) {
  try {
    return (await getFile(branchName(id), runPath(id, "logs/run.log"))).slice(-8000);
  } catch {
    return "";
  }
}

export async function readResults(id: string): Promise<PlaygroundResults> {
  const branch = branchName(id);
  const [analysis, charts, transcript] = await Promise.all([
    getJson(branch, runPath(id, "output/analysis.json")),
    getJson(branch, runPath(id, "output/charts.json")),
    getJson(branch, runPath(id, "output/transcript_sample.json")),
  ]);
  return { analysis, charts, transcript };
}

export async function readReview(id: string): Promise<PlaygroundReview> {
  const review = await getJson(branchName(id), runPath(id, "review.json"));
  return {
    studyNote: typeof review?.studyNote === "string" ? review.studyNote : "",
    itemNotes: review?.itemNotes && typeof review.itemNotes === "object" ? review.itemNotes : {},
    updatedAt: typeof review?.updatedAt === "string" ? review.updatedAt : undefined,
  };
}

export async function saveReview(id: string, input: unknown): Promise<PlaygroundReview> {
  await readRun(id);
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawNotes = value.itemNotes && typeof value.itemNotes === "object" ? value.itemNotes as Record<string, unknown> : {};
  const itemNotes: Record<string, string> = {};
  for (const [key, note] of Object.entries(rawNotes).slice(0, 250)) {
    const safeKey = safe(key);
    if (safeKey && typeof note === "string" && note.trim()) itemNotes[safeKey] = note.trim().slice(0, 4000);
  }
  const review: PlaygroundReview = {
    studyNote: typeof value.studyNote === "string" ? value.studyNote.trim().slice(0, 8000) : "",
    itemNotes,
    updatedAt: new Date().toISOString(),
  };
  await putFile(branchName(id), runPath(id, "review.json"), JSON.stringify(review, null, 2) + "\n", `playground: review ${id}`);
  return review;
}

export async function retryRun(id: string) {
  const run = await readRun(id);
  if (run.status === "complete") throw new Error("This run has already finished.");
  const branch = branchName(id);
  const stored = (await getJson(branch, runPath(id, "run.json"))) as Record<string, unknown> | null;
  if (!stored) throw new Error("This run could not be found.");
  const next = { ...stored, status: "queued", message: "Waiting for a runner to pick up this run", error: undefined, updatedAt: new Date().toISOString() };
  await putFile(branch, runPath(id, "run.json"), JSON.stringify(next, null, 2) + "\n", `playground: retry ${id}`);
  const workflowRunId = await dispatch(id);
  if (workflowRunId) {
    await putFile(branch, runPath(id, "run.json"), JSON.stringify({ ...next, workflowRunId }, null, 2) + "\n", `playground: workflow ${workflowRunId}`);
    return readRun(id);
  }
  throw new Error("GitHub Actions did not start a run. Please try again.");
}

export async function stopRun(id: string) {
  const run = await readRun(id);
  if (!run.workflowRunId) throw new Error("This run has no active workflow to stop.");
  const api = octokit();
  await api.actions.cancelWorkflowRun({ ...splitRepo(benchRepo), run_id: run.workflowRunId });
  return readRun(id);
}
