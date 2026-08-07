import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";

export type JobStatus = "queued" | "running" | "review" | "complete" | "failed";
export type PipelineProgress = {
  phase: "building_package" | "validating_package" | "ready_for_review" | "timed_out" | "failed";
  completedRequired: number;
  totalRequired: number;
  totalFiles: number;
  missing: string[];
  updatedAt: string;
};
export type PipelineJob = {
  id: string;
  experimentId: string;
  contributorName: string;
  contributorGithub?: string;
  osfUrl?: string;
  paperName: string;
  paperUrl?: string;
  currentStage: number;
  status: JobStatus;
  message: string;
  error?: string;
  packageReady?: boolean;
  progress?: PipelineProgress;
  createdAt: string;
  updatedAt: string;
  reviews: Record<string, { decision: "approved" | "changes_requested"; note?: string; at: string }>;
};

const jobsRepo = process.env.GITHUB_JOBS_REPO || "HumanStudy-Hub/humanstudy-hub-jobs";
const pipelineRepo = process.env.GITHUB_PIPELINE_REPO || "HumanStudy-Hub/HumanStudy-Bench";

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

function draftId(fileName: string, jobId: string) {
  const stem = fileName.replace(/\.pdf$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 36) || "study";
  return `draft_${stem}_${safe(jobId).slice(-8)}`;
}

function jobPath(id: string, suffix: string) {
  return `jobs/${safe(id)}/${suffix}`;
}

async function branchSha(branch: string) {
  const api = octokit();
  const target = splitRepo(jobsRepo);
  const ref = await api.git.getRef({ ...target, ref: `heads/${branch}` });
  return ref.data.object.sha;
}

async function defaultBranch(repo: string) {
  const api = octokit();
  const target = splitRepo(repo);
  const result = await api.repos.get({ ...target });
  return result.data.default_branch;
}

async function ensureBranch(branch: string) {
  const api = octokit();
  const target = splitRepo(jobsRepo);
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
    await api.git.createRef({ ...target, ref: `refs/heads/${branch}`, sha });
  }
}

export async function nextStudyId() {
  const api = octokit();
  const target = splitRepo(pipelineRepo);
  const branch = process.env.GITHUB_PIPELINE_REF || await defaultBranch(pipelineRepo);
  const result = await api.repos.getContent({ ...target, path: "studies", ref: branch });
  const entries = Array.isArray(result.data) ? result.data : [];
  const ids = entries.flatMap((entry) => {
    const match = entry.name.match(/^study_(\d+)$/);
    return match ? [Number(match[1])] : [];
  });
  return `study_${String(Math.max(0, ...ids) + 1).padStart(3, "0")}`;
}

async function putFile(branch: string, filePath: string, content: Buffer | string, message: string) {
  const api = octokit();
  const target = splitRepo(jobsRepo);
  let sha: string | undefined;
  try {
    const existing = await api.repos.getContent({ ...target, path: filePath, ref: branch });
    if (!Array.isArray(existing.data) && "sha" in existing.data) sha = existing.data.sha;
  } catch {
    // New job files do not have a prior blob.
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
  const target = splitRepo(jobsRepo);
  const result = await api.repos.getContent({ ...target, path: filePath, ref: branch });
  if (Array.isArray(result.data) || !("content" in result.data)) throw new Error(`Not a file: ${filePath}`);
  return Buffer.from(result.data.content, "base64");
}

export async function listPackageFiles(id: string) {
  const api = octokit();
  const target = splitRepo(jobsRepo);
  const branch = `jobs/${safe(id)}`;
  const root = jobPath(id, "package");
  const files: Array<{ path: string; content: Buffer }> = [];
  async function walk(prefix: string) {
    const result = await api.repos.getContent({ ...target, path: prefix, ref: branch });
    if (!Array.isArray(result.data)) return;
    await Promise.all(result.data.map(async (item) => {
      if (item.type === "dir") await walk(item.path);
      if (item.type === "file") {
        files.push({ path: item.path.slice(`${root}/`.length), content: await getFile(branch, item.path) });
      }
    }));
  }
  await walk(root);
  return files;
}

const workflowFile = "run-humanstudy-pipeline.yml";

// createWorkflowDispatch returns 204 without telling us whether a run was queued,
// so confirm one appeared. A silent miss leaves the job stuck on "queued" forever.
async function dispatchStarted(after: Date) {
  const api = octokit();
  const target = splitRepo(pipelineRepo);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const runs = await api.actions.listWorkflowRuns({
        ...target,
        workflow_id: workflowFile,
        event: "workflow_dispatch",
        per_page: 20,
      });
      if (runs.data.workflow_runs.some((run) => new Date(run.created_at) >= after)) return true;
    } catch {
      // Keep polling; a transient list failure is not proof the run is missing.
    }
  }
  return false;
}

async function dispatch(job: PipelineJob) {
  const api = octokit();
  const target = splitRepo(pipelineRepo);
  // GitHub matches runs by created_at at second precision, so allow for clock skew.
  const after = new Date(Date.now() - 5000);
  await api.actions.createWorkflowDispatch({
    ...target,
    workflow_id: workflowFile,
    ref: process.env.GITHUB_PIPELINE_REF || "main",
    inputs: { job_id: job.id, jobs_repo: jobsRepo },
  });
  return dispatchStarted(after);
}

async function saveJob(job: PipelineJob, message: string) {
  const branch = `jobs/${job.id}`;
  await putFile(branch, jobPath(job.id, "job.json"), JSON.stringify(job, null, 2) + "\n", message);
}

export async function readJob(id: string): Promise<PipelineJob> {
  const branch = `jobs/${safe(id)}`;
  const data = JSON.parse((await getFile(branch, jobPath(id, "job.json"))).toString("utf8")) as PipelineJob;
  try {
    data.progress = JSON.parse((await getFile(branch, jobPath(id, "progress.json"))).toString("utf8")) as PipelineProgress;
  } catch {
    // The first progress snapshot is published after the agent starts.
  }
  return data;
}

// The paper is already in Vercel Blob; the Actions runner downloads it from
// paperUrl and commits it to the job branch.
export async function createJob(input: { paperUrl: string; paperName: string; contributorName: string; contributorGithub?: string; osfUrl?: string }) {
  if (!input.contributorName.trim()) throw new Error("Contributor name is required.");
  if (!input.paperName.toLowerCase().endsWith(".pdf")) throw new Error("Please upload a PDF.");
  let paperUrl: URL;
  try {
    paperUrl = new URL(input.paperUrl);
  } catch {
    throw new Error("The uploaded paper could not be located. Please try the upload again.");
  }
  if (paperUrl.protocol !== "https:" || !paperUrl.hostname.endsWith(".vercel-storage.com")) {
    throw new Error("The uploaded paper could not be located. Please try the upload again.");
  }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const branch = `jobs/${id}`;
  await ensureBranch(branch);
  const now = new Date().toISOString();
  const job: PipelineJob = { id, experimentId: draftId(input.paperName, id), contributorName: input.contributorName.trim(), contributorGithub: input.contributorGithub?.trim() || undefined, osfUrl: input.osfUrl?.trim() || undefined, paperName: input.paperName, paperUrl: paperUrl.toString(), currentStage: 1, status: "queued", message: "Waiting for the study-building agent", packageReady: false, createdAt: now, updatedAt: now, reviews: {} };
  await putFile(branch, jobPath(id, "job.json"), JSON.stringify(job, null, 2) + "\n", `pipeline: create ${id}`);
  if (await dispatch(job)) return job;
  job.status = "failed";
  job.message = "The study-building agent could not be started";
  job.error = "GitHub Actions did not start a run for this job. Please try again.";
  job.updatedAt = new Date().toISOString();
  await saveJob(job, `pipeline: dispatch failed ${id}`);
  return job;
}

async function hasPaper(id: string) {
  try {
    await getFile(`jobs/${safe(id)}`, jobPath(id, "input/paper.pdf"));
    return true;
  } catch {
    return false;
  }
}

// A run that no hosted runner ever picks up writes nothing back, so the job sits
// on "queued" forever. Re-dispatching is the only way to recover it.
export async function retryJob(id: string) {
  const job = await readJob(id);
  if (job.status === "review" || job.status === "complete") throw new Error("This job has already finished building.");
  // Jobs created before direct uploads carry the PDF on the branch instead.
  if (!job.paperUrl && !(await hasPaper(id))) throw new Error("The paper for this job is no longer available. Please start a new build.");
  job.status = "queued";
  job.message = "Waiting for the study-building agent";
  job.error = undefined;
  job.updatedAt = new Date().toISOString();
  await saveJob(job, `pipeline: retry ${id}`);
  if (await dispatch(job)) return job;
  job.status = "failed";
  job.message = "The study-building agent could not be started";
  job.error = "GitHub Actions did not start a run for this job. Please try again.";
  job.updatedAt = new Date().toISOString();
  await saveJob(job, `pipeline: dispatch failed ${id}`);
  return job;
}

export async function approveStage(id: string, input: { decision: "approved" | "changes_requested"; note?: string }) {
  const job = await readJob(id);
  if (job.status !== "review") throw new Error("This job is not waiting for review.");
  job.reviews[String(job.currentStage)] = { ...input, at: new Date().toISOString() };
  if (input.decision === "changes_requested") { job.message = "Changes requested; review note saved"; await saveJob(job, `pipeline: review ${id}`); return job; }
  job.status = "complete";
  job.packageReady = true;
  job.message = "Study package is approved and ready";
  await saveJob(job, `agent: approve package ${id}`);
  return job;
}

export async function readLog(id: string) {
  try { return (await getFile(`jobs/${safe(id)}`, jobPath(id, "logs/agent.log"))).toString("utf8").slice(-12000); } catch { return ""; }
}

export async function readReviewFiles(id: string) {
  const files: Array<{ path: string; content: string }> = [];
  for (const file of await listPackageFiles(id)) {
    if (file.path.endsWith(".json") || file.path.endsWith(".md")) {
      files.push({ path: `package/${file.path}`, content: file.content.toString("utf8") });
    }
  }
  return files;
}

export async function saveReviewFile(id: string, filePath: string, content: string) {
  const editable = /^package\/.+\.(json|md)$/.test(filePath) && !filePath.includes("..");
  if (!editable) throw new Error("Only review JSON and Markdown files can be edited.");
  if (filePath.endsWith(".json")) JSON.parse(content);
  const branch = `jobs/${safe(id)}`;
  const targetPath = filePath;
  await putFile(branch, jobPath(id, targetPath), content, `pipeline: edit ${filePath}`);
}

export async function readPackageZip(id: string) {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  for (const file of await listPackageFiles(id)) zip.addFile(file.path, file.content);
  return zip.toBuffer();
}

export async function assignStudyId(id: string) {
  const job = await readJob(id);
  if (!job.experimentId.startsWith("draft_")) return job;
  job.experimentId = await nextStudyId();
  await saveJob(job, `pipeline: assign ${job.experimentId}`);
  return job;
}
