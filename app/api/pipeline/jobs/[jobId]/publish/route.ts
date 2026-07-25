import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { readJob } from "@/lib/pipeline-jobs";

export const runtime = "nodejs";

async function filesUnder(root: string, current = root): Promise<Array<{ path: string; content: Buffer }>> {
  const result: Array<{ path: string; content: Buffer }> = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(root, absolute)));
    else result.push({ path: path.relative(root, absolute).split(path.sep).join("/"), content: await readFile(absolute) });
  }
  return result;
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return NextResponse.json({ error: "GITHUB_TOKEN is not configured." }, { status: 503 });
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    if (job.status !== "complete" || !job.packageDir) {
      return NextResponse.json({ error: "Package is not ready." }, { status: 409 });
    }

    const owner = process.env.GITHUB_REPO_OWNER || "HumanStudy-Hub";
    const repo = process.env.GITHUB_REPO_NAME || "HumanStudy-Bench";
    const base = process.env.GITHUB_BASE_BRANCH || "main";
    const octokit = new Octokit({ auth: token });
    const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
    const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseRef.data.object.sha });
    const branch = `contribute/${job.experimentId}-${job.id.slice(-8)}`;

    const tree = [];
    for (const file of await filesUnder(job.packageDir)) {
      const blob = await octokit.git.createBlob({
        owner,
        repo,
        content: file.content.toString("base64"),
        encoding: "base64",
      });
      tree.push({
        path: `studies/${job.experimentId}/${file.path}`,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.data.sha,
      });
    }
    const newTree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.data.tree.sha,
      tree,
    });
    const commit = await octokit.git.createCommit({
      owner,
      repo,
      message: `Add study: ${job.experimentId}`,
      tree: newTree.data.sha,
      parents: [baseRef.data.object.sha],
    });
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    const pr = await octokit.pulls.create({
      owner,
      repo,
      head: branch,
      base,
      title: `Add study: ${job.experimentId}`,
      body: `Generated through HumanStudy-Hub Build Study.\n\nContributor: ${job.contributorName}\nJob: ${job.id}`,
    });
    return NextResponse.json({ prUrl: pr.data.html_url });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not publish package." },
      { status: 500 },
    );
  }
}
