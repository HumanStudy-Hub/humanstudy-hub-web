import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { assignStudyId, listPackageFiles } from "@/lib/github-jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return NextResponse.json({ error: "GITHUB_TOKEN is not configured." }, { status: 503 });
    const { jobId } = await context.params;
    const job = await assignStudyId(jobId);
    if (job.status !== "complete") {
      return NextResponse.json({ error: "Package is not ready." }, { status: 409 });
    }

    const owner = process.env.GITHUB_REPO_OWNER || "HumanStudy-Hub";
    const repo = process.env.GITHUB_REPO_NAME || "HumanStudy-Bench";
    const base = process.env.GITHUB_BASE_BRANCH || "main";
    const octokit = new Octokit({ auth: token });
    const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
    const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseRef.data.object.sha });
    const branch = `contribute/${job.experimentId}-${job.id.slice(-8)}`;

    // Publishing is idempotent: an earlier attempt may already have opened the
    // PR (its response just never reached the browser). Return it instead of
    // failing with "Reference already exists" on the branch.
    const existingPRs = await octokit.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "open" });
    if (existingPRs.data.length > 0) {
      return NextResponse.json({ prUrl: existingPRs.data[0].html_url });
    }

    const packageFiles = await listPackageFiles(jobId);
    const firstSegments = new Set(packageFiles.map((file) => file.path.split("/")[0]));
    const packageRoot = firstSegments.size === 1 ? [...firstSegments][0] : "";
    const tree = await Promise.all(packageFiles.map(async (file) => {
      const relativePath = packageRoot && file.path.startsWith(`${packageRoot}/`)
        ? file.path.slice(packageRoot.length + 1)
        : file.path;
      let content = file.content;
      if (relativePath === "study.json") {
        const study = JSON.parse(content.toString("utf8"));
        study.contributors = [{
          name: job.contributorName,
          ...(job.contributorGithub ? { github: `https://github.com/${job.contributorGithub.replace(/^@/, "")}` } : {}),
        }];
        content = Buffer.from(`${JSON.stringify(study, null, 2)}\n`);
      }
      const blob = await octokit.git.createBlob({
        owner,
        repo,
        content: content.toString("base64"),
        encoding: "base64",
      });
      return {
        path: `studies/${job.experimentId}/${relativePath}`,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.data.sha,
      };
    }));
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
    try {
      await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    } catch (error) {
      // A previous attempt created the branch but died before opening the PR.
      // Re-point the branch at the freshly built commit instead of failing.
      if (!/reference already exists/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: true });
    }
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
