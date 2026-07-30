import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";

export type JobStatus = "queued" | "running" | "review" | "complete" | "failed";
export type PipelineJob = {
  id: string;
  experimentId: string;
  contributorName: string;
  contributorGithub?: string;
  osfUrl?: string;
  paperName: string;
  currentStage: number;
  status: JobStatus;
  message: string;
  error?: string;
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

async function nextStudyId() {
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
    for (const item of result.data) {
      if (item.type === "dir") await walk(item.path);
      if (item.type === "file") files.push({ path: item.path.slice(`${root}/`.length), content: await getFile(branch, item.path) });
    }
  }
  await walk(root);
  return files;
}

async function dispatch(job: PipelineJob, stage: number) {
  const api = octokit();
  const target = splitRepo(pipelineRepo);
  await api.actions.createWorkflowDispatch({
    ...target,
    workflow_id: "run-humanstudy-pipeline.yml",
    ref: process.env.GITHUB_PIPELINE_REF || "main",
    inputs: { job_id: job.id, stage: String(stage), jobs_repo: jobsRepo },
  });
}

async function saveJob(job: PipelineJob, message: string) {
  const branch = `jobs/${job.id}`;
  await putFile(branch, jobPath(job.id, "job.json"), JSON.stringify(job, null, 2) + "\n", message);
}

export async function readJob(id: string): Promise<PipelineJob> {
  const data = JSON.parse((await getFile(`jobs/${safe(id)}`, jobPath(id, "job.json"))).toString("utf8")) as PipelineJob;
  return data;
}

export async function createJob(input: { paper: File; contributorName: string; contributorGithub?: string; osfUrl?: string }) {
  if (!input.contributorName.trim()) throw new Error("Contributor name is required.");
  if (input.paper.size > 50 * 1024 * 1024 || !input.paper.name.toLowerCase().endsWith(".pdf")) throw new Error("Please upload a PDF up to 50 MB.");
  const experimentId = await nextStudyId();
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const branch = `jobs/${id}`;
  await ensureBranch(branch);
  const now = new Date().toISOString();
  const job: PipelineJob = { id, experimentId, contributorName: input.contributorName.trim(), contributorGithub: input.contributorGithub?.trim() || undefined, osfUrl: input.osfUrl?.trim() || undefined, paperName: input.paper.name, currentStage: 1, status: "queued", message: "Waiting to start study inventory", createdAt: now, updatedAt: now, reviews: {} };
  await putFile(branch, jobPath(id, "job.json"), JSON.stringify(job, null, 2) + "\n", `pipeline: create ${id}`);
  await putFile(branch, jobPath(id, "input/paper.pdf"), Buffer.from(await input.paper.arrayBuffer()), `pipeline: upload paper ${id}`);
  await dispatch(job, 1);
  return job;
}

export async function approveStage(id: string, input: { decision: "approved" | "changes_requested"; note?: string }) {
  const job = await readJob(id);
  if (job.status !== "review") throw new Error("This job is not waiting for review.");
  job.reviews[String(job.currentStage)] = { ...input, at: new Date().toISOString() };
  if (input.decision === "changes_requested") { job.message = "Changes requested; review note saved"; await saveJob(job, `pipeline: review ${id}`); return job; }
  job.currentStage += 1;
  job.status = "queued";
  job.message = `Waiting to start stage ${job.currentStage}`;
  await saveJob(job, `pipeline: approve stage ${job.currentStage - 1}`);
  await dispatch(job, job.currentStage);
  return job;
}

export async function readLog(id: string) {
  const job = await readJob(id);
  try { return (await getFile(`jobs/${safe(id)}`, jobPath(id, `logs/stage${job.currentStage}.log`))).toString("utf8").slice(-12000); } catch { return ""; }
}

export async function readPackageZip(id: string) {
  return getFile(`jobs/${safe(id)}`, jobPath(id, "output/study.zip"));
}
