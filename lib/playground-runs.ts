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

export type PlaygroundRun = {
  id: string;
  studyId: string;
  studyTitle?: string;
  model: string;
  preset: string;
  systemPrompt?: string;
  demographics?: Record<string, string | number>;
  personaGroup?: PersonaGroup;
  participantsPerScenario: number;
  temperature: number;
  seed: number;
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
  const api = octokit();
  const result = await api.repos.get({ ...splitRepo(repo) });
  return result.data.default_branch;
}

async function branchSha(branch: string) {
  const api = octokit();
  const ref = await api.git.getRef({ ...splitRepo(jobsRepo), ref: `heads/${branch}` });
  return ref.data.object.sha;
}

async function ensureBranch(branch: string) {
  const api = octokit();
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
  const api = octokit();
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
  const api = octokit();
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
// one actually appeared rather than leaving the run stuck on "queued".
async function dispatchStarted(after: Date) {
  const api = octokit();
  const target = splitRepo(benchRepo);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const runs = await api.actions.listWorkflowRuns({ ...target, workflow_id: workflowFile, event: "workflow_dispatch", per_page: 20 });
      if (runs.data.workflow_runs.some((run) => new Date(run.created_at) >= after)) return true;
    } catch {
      // A transient list failure is not proof the run is missing.
    }
  }
  return false;
}

async function dispatch(id: string) {
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
};

// Only the profile fields the participant prompts actually read, so an arbitrary
// object cannot be pushed into the run configuration.
const DEMOGRAPHIC_FIELDS = ["age", "gender", "education", "background", "population", "persona"] as const;

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
  return {
    studyId,
    model,
    preset,
    systemPrompt,
    apiKey,
    demographics: personaGroup ? undefined : cleanDemographics(input.demographics),
    personaGroup,
    participantsPerScenario: Math.min(Math.floor(requested), limit),
    temperature: Math.min(2, Math.max(0, Number(input.temperature ?? 1))),
    seed: Math.floor(Number(input.seed ?? 42)) || 42,
  };
}

export async function createRun(input: CreateRunInput) {
  const checked = validate(input);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const branch = branchName(id);
  await ensureBranch(branch);
  const now = new Date().toISOString();
  const run: PlaygroundRun = {
    id,
    studyId: checked.studyId,
    model: checked.model,
    preset: checked.preset,
    systemPrompt: checked.systemPrompt || undefined,
    demographics: checked.demographics,
    personaGroup: checked.personaGroup,
    participantsPerScenario: checked.participantsPerScenario,
    temperature: checked.temperature,
    seed: checked.seed,
    researcherName: input.researcherName?.trim() || undefined,
    usedOwnKey: Boolean(checked.apiKey),
    status: "queued",
    message: "Waiting for a runner to pick up this run",
    createdAt: now,
    updatedAt: now,
  };
  const stored = checked.apiKey ? { ...run, sealedApiKey: sealApiKey(checked.apiKey) } : run;
  await putFile(branch, runPath(id, "run.json"), JSON.stringify(stored, null, 2) + "\n", `playground: create ${id}`);

  if (await dispatch(id)) return run;
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

export async function retryRun(id: string) {
  const run = await readRun(id);
  if (run.status === "complete") throw new Error("This run has already finished.");
  const branch = branchName(id);
  const stored = (await getJson(branch, runPath(id, "run.json"))) as Record<string, unknown> | null;
  if (!stored) throw new Error("This run could not be found.");
  const next = { ...stored, status: "queued", message: "Waiting for a runner to pick up this run", error: undefined, updatedAt: new Date().toISOString() };
  await putFile(branch, runPath(id, "run.json"), JSON.stringify(next, null, 2) + "\n", `playground: retry ${id}`);
  if (await dispatch(id)) return readRun(id);
  throw new Error("GitHub Actions did not start a run. Please try again.");
}
