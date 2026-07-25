import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type JobStatus = "queued" | "running" | "review" | "complete" | "failed";

export type PipelineJob = {
  id: string;
  experimentId: string;
  contributorName: string;
  contributorGithub?: string;
  osfUrl?: string;
  paperName: string;
  paperPath: string;
  outputDir: string;
  packageDir?: string;
  currentStage: number;
  status: JobStatus;
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  reviews: Record<string, { decision: "approved" | "changes_requested"; note?: string; at: string }>;
};

const benchRoot = path.resolve(
  process.env.HUMANSTUDY_BENCH_ROOT || path.join(process.cwd(), "..", "HSBench-Community"),
);
const jobsRoot = path.resolve(
  process.env.HUMANSTUDY_JOBS_ROOT || path.join(process.cwd(), ".humanstudy-jobs"),
);

const active = new Set<string>();

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function jobDir(id: string) {
  return path.join(jobsRoot, safeId(id));
}

function jobFile(id: string) {
  return path.join(jobDir(id), "job.json");
}

async function persist(job: PipelineJob) {
  job.updatedAt = new Date().toISOString();
  await mkdir(jobDir(job.id), { recursive: true });
  await writeFile(jobFile(job.id), JSON.stringify(job, null, 2), "utf8");
}

export async function readJob(id: string): Promise<PipelineJob> {
  return JSON.parse(await readFile(jobFile(id), "utf8")) as PipelineJob;
}

export async function createJob(input: {
  paper: File;
  experimentId: string;
  contributorName: string;
  contributorGithub?: string;
  osfUrl?: string;
}) {
  const experimentId = safeId(input.experimentId);
  if (!experimentId) throw new Error("A valid experiment ID is required.");
  if (!input.contributorName.trim()) throw new Error("Contributor name is required.");
  if (input.paper.size > 50 * 1024 * 1024) throw new Error("PDF must be 50 MB or smaller.");
  if (!input.paper.name.toLowerCase().endsWith(".pdf")) throw new Error("Only PDF files are accepted.");

  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const dir = jobDir(id);
  const paperPath = path.join(dir, "input", "paper.pdf");
  const outputDir = path.join(dir, "output");
  await mkdir(path.dirname(paperPath), { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(paperPath, Buffer.from(await input.paper.arrayBuffer()));

  const now = new Date().toISOString();
  const job: PipelineJob = {
    id,
    experimentId,
    contributorName: input.contributorName.trim(),
    contributorGithub: input.contributorGithub?.trim() || undefined,
    osfUrl: input.osfUrl?.trim() || undefined,
    paperName: input.paper.name,
    paperPath,
    outputDir,
    currentStage: 1,
    status: "queued",
    message: "Waiting to start study inventory",
    createdAt: now,
    updatedAt: now,
    reviews: {},
  };
  await persist(job);
  void runStage(id, 1);
  return job;
}

function settingsPath() {
  const configured = process.env.HUMANSTUDY_SETTINGS
    ? path.resolve(process.env.HUMANSTUDY_SETTINGS)
    : path.join(benchRoot, "config", "settings.yaml");
  return existsSync(configured)
    ? configured
    : path.join(benchRoot, "config", "settings.example.yaml");
}

function stageArgs(job: PipelineJob, stage: number) {
  const common = [
    path.join(benchRoot, "generation_pipeline", "run.py"),
    "--settings",
    settingsPath(),
    "--stage",
    String(stage),
    "--output-dir",
    job.outputDir,
  ];
  if (stage === 1) {
    return [...common, "--pdf", job.paperPath];
  }
  if (stage === 2) return [...common, "--pdf", job.paperPath];
  if (stage === 3) {
    const stage2 = path.join(job.outputDir, "paper", "stage2.json");
    const osfDir = path.join(jobDir(job.id), "sources");
    return [
      ...common,
      "--json",
      stage2,
      "--pdf",
      job.paperPath,
      ...(job.osfUrl ? ["--osf-dir", osfDir] : []),
      "--no-backup",
    ];
  }
  const stage3 = path.join(job.outputDir, "paper", "stage3.json");
  return [
    ...common,
    "--json",
    stage3,
    "--pdf",
    job.paperPath,
    "--study-id",
    job.experimentId,
    "--hub-layout",
    "--hub-studies-dir",
    path.join(jobDir(job.id), "package"),
  ];
}

async function locatePaperDir(outputDir: string) {
  const entries = await readdir(outputDir, { withFileTypes: true });
  const candidate = entries.find((item) => item.isDirectory());
  if (!candidate) throw new Error("Pipeline did not create a paper output directory.");
  return path.join(outputDir, candidate.name);
}

async function normalizeStagePaths(job: PipelineJob) {
  const actual = await locatePaperDir(job.outputDir);
  const alias = path.join(job.outputDir, "paper");
  if (actual === alias) return;
  await mkdir(alias, { recursive: true });
  for (const name of await readdir(actual)) {
    const source = path.join(actual, name);
    const destination = path.join(alias, name);
    if ((await stat(source)).isFile()) {
      await writeFile(destination, await readFile(source));
    }
  }
}

async function fetchExplicitOsf(job: PipelineJob, logPath: string) {
  if (!job.osfUrl) return;
  const log = createWriteStream(logPath, { flags: "a" });
  const python = process.env.HUMANSTUDY_PYTHON || "python3";
  const child = spawn(
    python,
    [
      path.join(benchRoot, "generation_pipeline", "fetch_explicit_osf.py"),
      "--url",
      job.osfUrl,
      "--dest",
      path.join(jobDir(job.id), "sources", "osf"),
      "--paper-title",
      job.paperName,
    ],
    { cwd: benchRoot, env: { ...process.env, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  log.end();
  if (code !== 0) throw new Error(`OSF download failed with exit code ${code}`);
}

export async function runStage(id: string, stage: number) {
  if (active.has(id)) return;
  active.add(id);
  let job = await readJob(id);
  job.currentStage = stage;
  job.status = "running";
  job.error = undefined;
  job.message = `Running stage ${stage} of 4`;
  await persist(job);

  const logPath = path.join(jobDir(id), `stage${stage}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const python = process.env.HUMANSTUDY_PYTHON || "python3";
  const child = spawn(python, stageArgs(job, stage), {
    cwd: benchRoot,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  child.on("error", async (error) => {
    job = await readJob(id);
    job.status = "failed";
    job.error = error.message;
    job.message = "Pipeline process could not start";
    await persist(job);
    active.delete(id);
  });

  child.on("close", async (code) => {
    log.end();
    job = await readJob(id);
    if (code !== 0) {
      const tail = (await readFile(logPath, "utf8")).slice(-4000);
      job.status = "failed";
      job.error = tail || `Pipeline exited with code ${code}`;
      job.message = `Stage ${stage} failed`;
    } else if (stage < 4) {
      try {
        await normalizeStagePaths(job);
        if (stage === 1) await fetchExplicitOsf(job, logPath);
        job.status = "review";
        job.message = `Stage ${stage} is ready for researcher review`;
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.message = stage === 1 ? "Open materials could not be downloaded" : `Stage ${stage} failed`;
      }
    } else {
      job.status = "complete";
      job.packageDir = path.join(jobDir(id), "package", job.experimentId);
      const indexPath = path.join(job.packageDir, "index.json");
      try {
        const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
        index.contributors = [
          {
            name: job.contributorName,
            ...(job.contributorGithub
              ? { github: `https://github.com/${job.contributorGithub.replace(/^@/, "")}` }
              : {}),
            institution: "Independent Researcher",
          },
        ];
        await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
      } catch {
        // Stage 4 owns index validation; leave its output untouched if absent.
      }
      job.message = "Study package is ready";
    }
    await persist(job);
    active.delete(id);
  });
}

export async function approveStage(
  id: string,
  input: { decision: "approved" | "changes_requested"; note?: string },
) {
  const job = await readJob(id);
  if (job.status !== "review") throw new Error("This job is not waiting for review.");
  job.reviews[String(job.currentStage)] = { ...input, at: new Date().toISOString() };
  if (input.decision === "changes_requested") {
    job.message = "Changes requested; review note saved";
    await persist(job);
    return job;
  }
  await persist(job);
  void runStage(id, job.currentStage + 1);
  return job;
}

export async function readLog(id: string) {
  const job = await readJob(id);
  try {
    return (await readFile(path.join(jobDir(id), `stage${job.currentStage}.log`), "utf8")).slice(-12000);
  } catch {
    return "";
  }
}

export function getJobDirectory(id: string) {
  return jobDir(id);
}
