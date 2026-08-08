import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { normaliseGroup, PersonaError, slug, summariseSegment } from "@/lib/persona-groups";

export const runtime = "nodejs";

// Contributed groups live beside the studies they were written for, named
// <study>-<contributor>-<n>.json. The number rises with each group the same
// contributor saves for the same study, so nothing is ever overwritten.
async function nextName(octokit: Octokit, owner: string, repo: string, base: string, studyPart: string, contributorPart: string) {
  const prefix = `${studyPart}-${contributorPart}-`;
  let taken: number[] = [];
  try {
    const listing = await octokit.repos.getContent({ owner, repo, path: "playground/profiles", ref: base });
    const entries = Array.isArray(listing.data) ? listing.data : [];
    taken = entries.flatMap((entry) => {
      const match = entry.name.match(new RegExp(`^${prefix}(\\d+)\\.json$`));
      return match ? [Number(match[1])] : [];
    });
  } catch {
    // The directory does not exist until the first group is contributed.
  }
  return `${prefix}${Math.max(0, ...taken) + 1}`;
}

export async function POST(request: Request) {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return NextResponse.json({ error: "GITHUB_TOKEN is not configured, so groups cannot be contributed." }, { status: 503 });

    const body = await request.json();
    const contributor = String(body.contributor || "").trim();
    if (!contributor) return NextResponse.json({ error: "Please add your name so the group can be credited to you." }, { status: 400 });
    const group = normaliseGroup({ ...body.group, contributor, studyId: body.studyId || body.group?.studyId || null });

    const owner = process.env.GITHUB_REPO_OWNER || "HumanStudy-Hub";
    const repo = process.env.GITHUB_REPO_NAME || "HumanStudy-Bench";
    const base = process.env.GITHUB_BASE_BRANCH || "main";
    const octokit = new Octokit({ auth: token });

    const studyPart = slug(group.studyId || "any-study", "any-study");
    const contributorPart = slug(contributor, "contributor");
    const name = await nextName(octokit, owner, repo, base, studyPart, contributorPart);
    const path = `playground/profiles/${name}.json`;

    const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
    const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseRef.data.object.sha });
    const blob = await octokit.git.createBlob({
      owner,
      repo,
      content: Buffer.from(`${JSON.stringify(group, null, 2)}\n`).toString("base64"),
      encoding: "base64",
    });
    const tree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.data.tree.sha,
      tree: [{ path, mode: "100644" as const, type: "blob" as const, sha: blob.data.sha }],
    });
    const commit = await octokit.git.createCommit({
      owner,
      repo,
      message: `Add persona group: ${name}`,
      tree: tree.data.sha,
      parents: [baseRef.data.object.sha],
    });
    const branch = `personas/${name}`;
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.data.sha });

    const rows = group.segments
      .map((segment) => `| ${segment.label} | ${Math.round(segment.share * 100)}% | ${summariseSegment(segment)} |`)
      .join("\n");
    const pr = await octokit.pulls.create({
      owner,
      repo,
      head: branch,
      base,
      title: `Add persona group: ${group.name}`,
      body: [
        `Contributed through the HumanStudy-Hub playground by **${contributor}**.`,
        group.description ? `\n${group.description}` : "",
        group.studyId ? `\nWritten for \`${group.studyId}\`.` : "\nNot tied to a particular study.",
        "\n| Segment | Share | Attributes |",
        "|---|---|---|",
        rows,
        "\nA persona group describes a population rather than a fixed cast, so it fits a run of any size.",
      ].join("\n"),
    });

    return NextResponse.json({ prUrl: pr.data.html_url, name });
  } catch (error) {
    if (error instanceof PersonaError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not contribute this group." },
      { status: 500 },
    );
  }
}
