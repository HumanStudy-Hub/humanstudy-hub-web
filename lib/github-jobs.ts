import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";
import { blobUpload, safePathname, signedBlobUrl } from "@/lib/blob-paper";

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
  // Durable location in the private Blob store; paperUrl is a signed link that
  // expires, so a retry re-signs from this.
  paperPathname?: string;
  paperUrl?: string;
  // Optional uploaded open materials (a zip of the contributor's folder or zip
  // file). Same Blob-store treatment as the paper: pathname is durable, the URL
  // is a short-lived signed link re-issued on retry.
  openMaterialsPathname?: string;
  openMaterialsUrl?: string;
  openMaterialsName?: string;
  currentStage: number;
  status: JobStatus;
  message: string;
  error?: string;
  packageReady?: boolean;
  source?: "build" | "import";
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

function draftId(fileName: string, jobId: string) {
  const stem = fileName.replace(/\.pdf$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 36) || "study";
  return `draft_${stem}_${safe(jobId).slice(-8)}`;
}

function jobPath(id: string, suffix: string) {
  return `jobs/${safe(id)}/${suffix}`;
}

async function branchSha(branch: string) {
  const api = jobsOctokit();
  const target = splitRepo(jobsRepo);
  const ref = await api.git.getRef({ ...target, ref: `heads/${branch}` });
  return ref.data.object.sha;
}

async function defaultBranch(repo: string) {
  const api = repo === jobsRepo ? jobsOctokit() : octokit();
  const target = splitRepo(repo);
  const result = await api.repos.get({ ...target });
  return result.data.default_branch;
}

async function ensureBranch(branch: string) {
  const api = jobsOctokit();
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

  const ids = [0];

  // IDs already merged into the base branch.
  const result = await api.repos.getContent({ ...target, path: "studies", ref: branch });
  const entries = Array.isArray(result.data) ? result.data : [];
  for (const entry of entries) {
    const match = entry.name.match(/^study_(\d+)$/);
    if (match) ids.push(Number(match[1]));
  }

  // IDs already claimed by unmerged contribution branches, so sequential
  // publishes do not all land on the same study_### number before a PR merges.
  const branches = await api.paginate(api.repos.listBranches, { ...target, per_page: 100 });
  for (const item of branches) {
    const match = item.name.match(/^contribute\/study_(\d+)-/);
    if (match) ids.push(Number(match[1]));
  }

  return `study_${String(Math.max(...ids) + 1).padStart(3, "0")}`;
}

async function putFile(branch: string, filePath: string, content: Buffer | string, message: string) {
  const api = jobsOctokit();
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
  const api = jobsOctokit();
  const target = splitRepo(jobsRepo);
  const result = await api.repos.getContent({ ...target, path: filePath, ref: branch });
  if (Array.isArray(result.data) || !("content" in result.data)) throw new Error(`Not a file: ${filePath}`);
  return Buffer.from(result.data.content, "base64");
}

export async function listPackageFiles(id: string) {
  const api = jobsOctokit();
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

// A dispatch that GitHub rejects throws here and reaches the contributor as an
// error. A dispatch it accepts is not confirmed by polling for the run: the runs
// list lags the run by longer than any sane wait, so polling reports healthy
// dispatches as failures, and recording that verdict on the job branch is what
// broke them — the runner pushes its own "running" commit to that same branch and
// its push is rejected once we have moved the ref underneath it.
//
// A run that never starts, whether GitHub dropped the dispatch or never gave the
// run a runner, is caught by the stall detection in the studio, which offers a
// restart after five minutes and writes nothing until the contributor asks.
async function dispatch(job: PipelineJob) {
  const api = octokit();
  const target = splitRepo(pipelineRepo);
  await api.actions.createWorkflowDispatch({
    ...target,
    workflow_id: workflowFile,
    ref: process.env.GITHUB_PIPELINE_REF || "main",
    inputs: { job_id: job.id, jobs_repo: jobsRepo },
  });
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

// The paper is already in the private Blob store; the Actions runner downloads
// it from the signed paperUrl and commits it to the job branch.
export async function createJob(input: { paperPathname: string; paperName: string; contributorName: string; contributorGithub?: string; osfUrl?: string; openMaterialsPathname?: string; openMaterialsName?: string }) {
  if (!input.contributorName.trim()) throw new Error("Contributor name is required.");
  if (!input.paperName.toLowerCase().endsWith(".pdf")) throw new Error("Please upload a PDF.");
  const pathname = safePathname(input.paperPathname);
  if (!pathname || !(await blobUpload(pathname))) {
    throw new Error("The uploaded paper could not be located. Please try the upload again.");
  }
  const materialsPathname = safePathname(input.openMaterialsPathname);
  if (input.openMaterialsPathname && !materialsPathname) {
    throw new Error("The uploaded open materials could not be read.");
  }
  if (materialsPathname && !(await blobUpload(materialsPathname))) {
    throw new Error("The uploaded open materials could not be located. Please try the upload again.");
  }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const branch = `jobs/${id}`;
  await ensureBranch(branch);
  const now = new Date().toISOString();
  const job: PipelineJob = { id, experimentId: draftId(input.paperName, id), contributorName: input.contributorName.trim(), contributorGithub: input.contributorGithub?.trim() || undefined, osfUrl: input.osfUrl?.trim() || undefined, paperName: input.paperName, paperPathname: pathname, paperUrl: await signedBlobUrl(pathname), openMaterialsPathname: materialsPathname || undefined, openMaterialsUrl: materialsPathname ? await signedBlobUrl(materialsPathname) : undefined, openMaterialsName: input.openMaterialsName?.trim() || undefined, currentStage: 1, status: "queued", message: "Waiting for the study-building agent", packageReady: false, createdAt: now, updatedAt: now, reviews: {} };
  await putFile(branch, jobPath(id, "job.json"), JSON.stringify(job, null, 2) + "\n", `pipeline: create ${id}`);
  // Nothing writes to this branch after the dispatch. From here the runner owns
  // it, and a second writer only costs it its push.
  await dispatch(job);
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
// on "queued" forever. Re-dispatching is the only way to recover it. The studio
// only offers this once a job has sat unclaimed for five minutes, by which point
// a live run would have published its own state, so resetting the branch here is
// not racing one.
export async function retryJob(id: string) {
  const job = await readJob(id);
  if (job.status === "review" || job.status === "complete") throw new Error("This job has already finished building.");
  // Jobs created before direct uploads carry the PDF on the branch instead.
  if (!job.paperPathname && !job.paperUrl && !(await hasPaper(id))) {
    throw new Error("The paper for this job is no longer available. Please start a new build.");
  }
  // The stored link is only valid for a day, so a later retry needs a fresh one.
  if (job.paperPathname) job.paperUrl = await signedBlobUrl(job.paperPathname);
  if (job.openMaterialsPathname) job.openMaterialsUrl = await signedBlobUrl(job.openMaterialsPathname);
  job.status = "queued";
  job.message = "Waiting for the study-building agent";
  job.error = undefined;
  job.updatedAt = new Date().toISOString();
  await saveJob(job, `pipeline: retry ${id}`);
  await dispatch(job);
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

// A researcher who closed the tab has only their own name to search by, so job
// branches are scanned and matched on it. Newest first, and capped, because this
// reads one file per branch.
export async function findJobsByContributor(name: string, limit = 10) {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const api = jobsOctokit();
  const target = splitRepo(jobsRepo);
  const branches = await api.paginate(api.repos.listBranches, { ...target, per_page: 100 });
  const jobBranches = branches.filter((branch) => branch.name.startsWith("jobs/")).slice(-200).reverse();
  const found: PipelineJob[] = [];
  for (const branch of jobBranches) {
    if (found.length >= limit) break;
    const id = branch.name.slice("jobs/".length);
    try {
      const job = JSON.parse((await getFile(branch.name, jobPath(id, "job.json"))).toString("utf8")) as PipelineJob;
      if ((job.contributorName || "").toLowerCase().includes(needle) || (job.contributorGithub || "").toLowerCase() === needle) {
        found.push(job);
      }
    } catch {
      // A half-created or deleted job branch is skipped rather than failing the search.
    }
  }
  return found.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export type BufferStudy = {
  studyId: string;
  title: string;
  jobId: string;
  packageSlug: string;
  paperName: string;
  createdAt?: string;
};

async function packageSlug(id: string): Promise<string | null> {
  const api = jobsOctokit();
  const target = splitRepo(jobsRepo);
  const result = await api.repos.getContent({ ...target, path: jobPath(id, "package"), ref: `jobs/${safe(id)}` });
  if (!Array.isArray(result.data)) return null;
  const dirs = result.data.filter((item) => item.type === "dir");
  return dirs.length === 1 ? dirs[0].name : null;
}

// Buffer studies are agent-built packages that have not been merged into the
// benchmark yet. They are runnable from the jobs repository, so the playground
// lists them alongside the merged catalog.
export async function listBufferStudies(): Promise<BufferStudy[]> {
  const api = jobsOctokit();
  const target = splitRepo(jobsRepo);
  const branches = await api.paginate(api.repos.listBranches, { ...target, per_page: 100 });
  const jobBranches = branches.filter((branch) => branch.name.startsWith("jobs/")).reverse().slice(0, 60);
  const out: BufferStudy[] = [];
  // Fetch a handful of branches in parallel rather than one at a time, so the
  // playground page load does not spend minutes on sequential GitHub calls.
  for (let i = 0; i < jobBranches.length; i += 6) {
    const chunk = jobBranches.slice(i, i + 6);
    const results = await Promise.all(chunk.map(async (branch): Promise<BufferStudy | null> => {
      const id = branch.name.slice("jobs/".length);
      try {
        const job = JSON.parse((await getFile(branch.name, jobPath(id, "job.json"))).toString("utf8")) as PipelineJob;
        if (!job.packageReady && job.status !== "review" && job.status !== "complete") return null;
        const slug = await packageSlug(id);
        if (!slug) return null;
        let title = slug.replace(/[-_]+/g, " ");
        try {
          const index = JSON.parse((await getFile(branch.name, jobPath(id, `package/${slug}/index.json`))).toString("utf8"));
          if (index.title) title = index.title;
        } catch {
          try {
            const study = JSON.parse((await getFile(branch.name, jobPath(id, `package/${slug}/study.json`))).toString("utf8"));
            title = study.title || study.paper?.title || title;
          } catch {
            // keep the slug-derived title
          }
        }
        return { studyId: slug, title, jobId: id, packageSlug: slug, paperName: job.paperName, createdAt: job.createdAt };
      } catch {
        return null;
      }
    }));
    for (const result of results) if (result) out.push(result);
  }
  return out;
}

// Read an already-built benchmark study's reviewable files (read-only, from the
// public benchmark repo). Used by the demo "import" flow, which does not write
// anything to the private jobs repository.
export async function listBenchmarkStudyFiles(studyId: string): Promise<Array<{ path: string; content: string }>> {
  if (!/^study_\d{3}$/.test(studyId)) throw new Error("Choose a study to import.");
  const api = octokit();
  const bench = splitRepo(pipelineRepo);
  const ref = process.env.GITHUB_PIPELINE_REF || await defaultBranch(pipelineRepo);
  const tree = await api.git.getTree({ ...bench, tree_sha: ref, recursive: "1" });
  const files = tree.data.tree.filter((item) =>
    item.type === "blob" && item.path?.startsWith(`studies/${studyId}/`) && (item.path.endsWith(".json") || item.path.endsWith(".md"))
  );
  if (files.length === 0) throw new Error(`${studyId} is not in the benchmark.`);
  const out: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const blob = await api.git.getBlob({ ...bench, file_sha: file.sha! });
    const rel = file.path!.slice(`studies/${studyId}/`.length);
    out.push({ path: `package/${rel}`, content: Buffer.from(blob.data.content, "base64").toString("utf8") });
  }
  return out;
}

export type BenchmarkMaterial = { id: string; label: string; items: Array<{ id: string; label: string }> };

function materialItemId(item: Record<string, unknown>) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
  for (const value of [item.id, item.item_id, item.name, item.label, metadata.id, metadata.label]) {
    const key = String(value ?? "").trim();
    if (/^[a-zA-Z0-9_.:-]+$/.test(key)) return key;
  }
  return "";
}

function materialItemLabel(item: Record<string, unknown>, fallback: string) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
  const key = materialItemId(item);
  const explicit = String(item.label ?? item.name ?? metadata.label ?? "").trim();
  if (explicit && explicit !== key) return explicit.slice(0, 180);
  if (key) return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return String(item.question ?? item.prompt ?? fallback).trim().slice(0, 180);
}

// List a benchmark study's experiment materials and the items inside each, so
// the playground can preview and scope a run to one material before it starts.
export async function listBenchmarkMaterials(studyId: string): Promise<BenchmarkMaterial[]> {
  if (!/^study_[a-zA-Z0-9_-]+$/.test(studyId)) throw new Error("Invalid study id.");
  const api = octokit();
  const bench = splitRepo(pipelineRepo);
  const ref = process.env.GITHUB_PIPELINE_REF || await defaultBranch(pipelineRepo);
  const tree = await api.git.getTree({ ...bench, tree_sha: ref, recursive: "1" });
  const paths = tree.data.tree
    .map((entry) => entry.path ?? "")
    .filter((path) => path.startsWith(`studies/${studyId}/`) && /\/materials\/[^/]+\.json$/.test(path))
    .slice(0, 40);
  const loaded = await Promise.all(paths.map(async (path): Promise<BenchmarkMaterial | null> => {
    const file = await api.repos.getContent({ ...bench, path, ref });
    if (Array.isArray(file.data) || !("content" in file.data)) return null;
    const parsed = JSON.parse(Buffer.from(file.data.content, "base64").toString("utf8"));
    const id = path.split("/").pop()?.replace(/\.json$/, "") ?? "";
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const items = rawItems.slice(0, 250).flatMap((item: unknown, index: number) => {
      if (!item || typeof item !== "object") return [];
      const key = materialItemId(item as Record<string, unknown>);
      return key ? [{ id: key, label: materialItemLabel(item as Record<string, unknown>, `Item ${index + 1}`) }] : [];
    });
    return { id, label: String(parsed?.title ?? parsed?.name ?? id).replace(/_/g, " "), items };
  }));
  return loaded.filter((entry): entry is BenchmarkMaterial => entry !== null);
}

export type BufferArm = { id: string; label: string };

// List a buffer (agent-built) package's experiment arms from its task.json
// conditions, so the playground can preview and scope a run to one arm.
export async function listBufferArms(jobId: string, slug: string): Promise<BufferArm[]> {
  const id = safe(jobId);
  const packageSlug = safe(slug);
  if (!id || !packageSlug) throw new Error("Choose a study to preview.");
  const raw = await getFile(`jobs/${id}`, jobPath(id, `package/${packageSlug}/task/task.json`));
  const task = JSON.parse(raw.toString("utf8"));
  const rawConditions = task?.conditions;
  // Newer packages list arms; a few older ones expose them as a dict keyed by arm.
  const conditions: Record<string, unknown>[] = Array.isArray(rawConditions)
    ? rawConditions
    : (rawConditions && typeof rawConditions === "object"
        ? Object.entries(rawConditions).map(([arm, value]) => ({ arm, ...(value && typeof value === "object" ? value as Record<string, unknown> : {}) }))
        : []);
  return conditions.flatMap((condition: unknown): BufferArm[] => {
    if (!condition || typeof condition !== "object") return [];
    const entry = condition as Record<string, unknown>;
    const arm = String(entry.arm || "").trim();
    if (!arm) return [];
    const explicitLabel = String(entry.label || "").trim();
    const detail = String(entry.structure || entry.size || entry.proposing || "").trim();
    const label = explicitLabel || (detail ? `${arm} — ${detail.replace(/[_-]+/g, " ")}` : arm);
    return [{ id: arm, label }];
  });
}

export async function assignStudyId(id: string) {
  const job = await readJob(id);
  if (!job.experimentId.startsWith("draft_")) return job;
  job.experimentId = await nextStudyId();
  await saveJob(job, `pipeline: assign ${job.experimentId}`);
  return job;
}
