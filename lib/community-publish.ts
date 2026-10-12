// Opens a pull request against the community repository for one contribution zip. Pure of
// HTTP concerns: the route authenticates the user and fetches the zip, this does the rest.

import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import {
  BOT_LOGIN, MAX_PUBLISHES_PER_HOUR, contributionFolder, decryptToken, githubContributorId, hubContributorId,
  latestVersion, makePaperKey, paperKeyToDir, readContributionZip, signHub,
} from "./community";
import { countRecentContributions, getIdentity, insertContribution } from "./community-store";

const REPO = process.env.COMMUNITY_REPO || "HumanStudy-Hub/HumanStudy-Bench";

export type PublishBody = {
  contributor?: { name?: unknown; affiliation?: unknown; orcid?: unknown };
  includesPdf?: unknown;
  paperMeta?: { doi?: unknown; title?: unknown; year?: unknown; firstAuthor?: unknown; authors?: unknown; venue?: unknown };
  slug?: unknown;
  supersedes?: unknown;
};
export type PublishResult =
  | { ok: true; id: string; prUrl: string; status: "pr_open" }
  | { ok: false; status: number; error: string; message: string };

const bad = (status: number, error: string, message: string): PublishResult => ({ ok: false, status, error, message });
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : "");

type Files = { path: string; content: Buffer }[];

function describe(error: unknown): { status?: number; text: string } {
  const e = error as { status?: number; message?: string };
  return { status: e?.status, text: e?.message || String(error) };
}

async function isMissing<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (error) {
    if (describe(error).status === 404) return null;
    throw error;
  }
}

export async function publishContribution(input: { userId: string; zip: Buffer; body: PublishBody }): Promise<PublishResult> {
  const { userId, zip, body } = input;
  const [owner, repo] = REPO.split("/");
  const botToken = process.env.GITHUB_TOKEN;

  // 1. Fields. Everything is re-checked here: the client is never trusted for the folder name.
  const name = str(body.contributor?.name, 200);
  const title = str(body.paperMeta?.title, 500);
  const firstAuthor = str(body.paperMeta?.firstAuthor, 200);
  const year = Number(body.paperMeta?.year);
  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!name) return bad(400, "missing_name", "Add your name so the contribution can be credited to you.");
  if (!title || !firstAuthor || !Number.isInteger(year) || year < 1800 || year > 2200) {
    return bad(400, "missing_paper", "The paper needs a title, a first author and a year.");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 80) return bad(400, "bad_slug", "The study name can only use lower-case letters, digits and hyphens.");
  const orcid = body.contributor?.orcid ? str(body.contributor.orcid, 19) : "";
  if (body.contributor?.orcid && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) return bad(400, "bad_orcid", "That ORCID does not look right. It should read like 0000-0002-1825-0097.");
  const affiliation = body.contributor?.affiliation ? str(body.contributor.affiliation, 300) : "";
  const includesPdf = body.includesPdf === true;
  const doi = typeof body.paperMeta?.doi === "string" ? body.paperMeta.doi : undefined;
  if (typeof body.supersedes === "string" && body.supersedes && !/^[a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9-]*$/.test(body.supersedes)) {
    return bad(400, "bad_supersedes", "The contribution you are replacing is not named correctly.");
  }

  // 2. Rate limit.
  try {
    const recent = await countRecentContributions(userId, new Date(Date.now() - 3_600_000).toISOString());
    if (recent >= MAX_PUBLISHES_PER_HOUR) return bad(429, "rate_limited", `You can publish ${MAX_PUBLISHES_PER_HOUR} times an hour. Try again later.`);
  } catch {
    return bad(503, "database_unavailable", "The Hub could not check your publish history. Try again in a minute.");
  }

  // 3. The zip.
  const read = readContributionZip(zip, { includesPdf });
  if (read.errors.length) return bad(400, "invalid_zip", read.errors.join(" "));
  let clientMeta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(read.files.find((f) => f.name === "CONTRIBUTION.json")!.data.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) clientMeta = parsed;
  } catch {
    return bad(400, "invalid_zip", "CONTRIBUTION.json in the zip is not valid JSON.");
  }

  // 4. Who is the author: the user's own GitHub account, or the Hub bot.
  let userToken: string | null = null, login = "";
  try {
    const identity = await getIdentity(userId);
    if (identity) {
      userToken = decryptToken(identity.token_encrypted);
      login = identity.login;
    }
  } catch {
    return bad(503, "database_unavailable", "The Hub could not read your GitHub connection. Try again in a minute.");
  }
  const asUser = Boolean(userToken && login);
  const token = asUser ? userToken! : botToken;
  if (!token) return bad(503, "not_configured", "Publishing is not set up on this server yet.");
  const api = new Octokit({ auth: token });

  const paperKey = makePaperKey({ doi, title, year, firstAuthor });
  const paperDir = paperKeyToDir(paperKey);
  const contributorId = asUser ? githubContributorId(login) : hubContributorId(userId);

  try {
    // 5. What exists upstream decides the version and whether paper.json is needed.
    const upstream = await api.rest.repos.get({ owner, repo });
    const defaultBranch = upstream.data.default_branch;
    const listing = await isMissing(api.rest.repos.getContent({ owner, repo, path: `community/${paperDir}`, ref: defaultBranch }));
    const existing = listing && Array.isArray(listing.data) ? listing.data.map((e: { name: string }) => e.name) : [];
    const hasPaperJson = existing.includes("paper.json");
    const latest = latestVersion(existing, slug, contributorId);
    const version = Math.max(latest + 1, 1);
    const folder = contributionFolder(slug, contributorId, version);
    const supersedes = typeof body.supersedes === "string" && body.supersedes ? body.supersedes : latest > 0 ? contributionFolder(slug, contributorId, latest) : undefined;
    const branch = `community/${folder}`;
    const root = `community/${paperDir}/${folder}`;

    const checks = clientMeta.checks as Record<string, unknown> | undefined;
    const contribution: Record<string, unknown> = {
      schemaVersion: 1,
      paperKey,
      slug,
      contributor: {
        name,
        ...(affiliation ? { affiliation } : {}),
        ...(orcid ? { orcid } : {}),
        ...(asUser ? { github: login } : { hub: { id: userId, signature: signHub(userId) } }),
      },
      license: { content: "CC-BY-4.0", code: "MIT" },
      includesPdf,
      appVersion: typeof clientMeta.appVersion === "string" && clientMeta.appVersion ? clientMeta.appVersion.slice(0, 50) : "unknown",
      createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      checks: {
        schema: typeof checks?.schema === "boolean" ? checks.schema : true,
        package: typeof checks?.package === "boolean" ? checks.package : null,
        simulation: typeof checks?.simulation === "boolean" ? checks.simulation : null,
      },
      ...(supersedes ? { supersedes } : {}),
    };

    const files: Files = read.files.filter((f) => f.name !== "CONTRIBUTION.json").map((f) => ({ path: `${root}/${f.name}`, content: f.data }));
    files.push({ path: `${root}/CONTRIBUTION.json`, content: Buffer.from(JSON.stringify(contribution, null, 2) + "\n") });
    if (!hasPaperJson) {
      const authors = Array.isArray(body.paperMeta?.authors) ? (body.paperMeta!.authors as unknown[]).filter((a): a is string => typeof a === "string" && !!a.trim()).slice(0, 200) : [];
      const paper = {
        schemaVersion: 1, paperKey, title, authors: authors.length ? authors : [firstAuthor], year,
        ...(doi && paperKey.startsWith("doi:") ? { doi: paperKey.slice(4) } : {}),
        ...(str(body.paperMeta?.venue, 300) ? { venue: str(body.paperMeta?.venue, 300) } : {}),
      };
      files.push({ path: `community/${paperDir}/paper.json`, content: Buffer.from(JSON.stringify(paper, null, 2) + "\n") });
    }

    // 6. Where the branch lives: the user's fork, or the repository itself for the bot.
    const baseRef = await api.rest.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
    const baseSha = baseRef.data.object.sha;
    const baseCommit = await api.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
    let target = { owner, repo };
    if (asUser) {
      const fork = await api.rest.repos.createFork({ owner, repo });
      target = { owner: fork.data.owner.login, repo: fork.data.name };
      await waitForRepo(api, target);
    }

    // 7. One commit through the Git Data API.
    const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    for (const f of files) {
      const blob = await api.rest.git.createBlob({ ...target, content: f.content.toString("base64"), encoding: "base64" });
      entries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.data.sha });
    }
    const tree = await api.rest.git.createTree({ ...target, base_tree: baseCommit.data.tree.sha, tree: entries });
    const trailer = `Co-authored-by: ${name} <${userId}@users.humanstudy-hub.com>`;
    const commit = await api.rest.git.createCommit({
      ...target,
      message: `Community: ${title} (${year}) by ${name}\n\nPublished from HumanStudy Hub as ${folder}.${asUser ? "" : `\n\n${trailer}`}`,
      tree: tree.data.sha,
      parents: [baseSha],
      ...(asUser ? {} : { author: { name, email: `${userId}@users.humanstudy-hub.com`, date: new Date().toISOString() } }),
    });
    const existingRef = await isMissing(api.rest.git.getRef({ ...target, ref: `heads/${branch}` }));
    if (existingRef) await api.rest.git.updateRef({ ...target, ref: `heads/${branch}`, sha: commit.data.sha, force: true });
    else await api.rest.git.createRef({ ...target, ref: `refs/heads/${branch}`, sha: commit.data.sha });

    // 8. The pull request (a republish of the same folder replaces the branch and keeps the PR).
    const head = `${target.owner}:${branch}`;
    const prBody = [
      `Reconstruction of **${title}** (${year}) by ${firstAuthor}, submitted by **${name}**${affiliation ? ` (${affiliation})` : ""} via HumanStudy Hub.`,
      "",
      `- Folder: \`${root}\``,
      `- Paper key: \`${paperKey}\``,
      asUser ? `- Author: @${login}` : `- Submitted through the Hub bot (@${BOT_LOGIN}) with a signed Hub id.`,
      "",
      "Checks run automatically. A pull request that only adds this folder and passes them is merged without further review.",
    ].join("\n");
    const prTitle = `Community: ${title} (${year}) — ${name}`;
    const open = await api.rest.pulls.list({ owner, repo, head, state: "open" });
    let pr: { number: number; html_url: string };
    if (open.data[0]) {
      pr = open.data[0];
      await api.rest.pulls.update({ owner, repo, pull_number: pr.number, title: prTitle, body: prBody });
    } else {
      pr = (await api.rest.pulls.create({ owner, repo, title: prTitle, head, base: defaultBranch, body: prBody })).data;
    }

    // 9. Remember it.
    const id = randomUUID();
    try {
      await insertContribution({ id, owner_id: userId, paper_key: paperKey, folder, slug, status: "pr_open", pr_url: pr.html_url, pr_number: pr.number, branch, error: null });
    } catch {
      return bad(500, "record_failed", `The pull request is open (${pr.html_url}) but the Hub could not record it. Do not publish again; contact the maintainers if it does not show under My contributions.`);
    }
    return { ok: true, id, prUrl: pr.html_url, status: "pr_open" };
  } catch (error) {
    const { status, text } = describe(error);
    if (status === 401 || (status === 403 && asUser)) {
      return bad(401, "github_token_rejected", asUser
        ? "GitHub no longer accepts your connection. Reconnect GitHub, or disconnect it to publish through the Hub account."
        : "The Hub's GitHub credentials were rejected. The maintainers have been unable to publish; try again later.");
    }
    if (status === 422 && /pull request already exists/i.test(text)) return bad(409, "pr_exists", "A pull request for this contribution already exists.");
    return bad(502, "github_failed", `GitHub did not accept the contribution (${text}). Nothing was published; try again in a few minutes.`);
  }
}

async function waitForRepo(api: Octokit, target: { owner: string; repo: string }): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const found = await isMissing(api.rest.repos.get(target));
    if (found) {
      const ref = await isMissing(api.rest.git.getRef({ ...target, ref: `heads/${found.data.default_branch}` }));
      if (ref) return;
    }
    await new Promise((r) => setTimeout(r, i < 3 ? 1000 : 3000));
  }
  throw new Error("your fork on GitHub is not ready yet");
}
