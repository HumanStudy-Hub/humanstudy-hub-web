import { createHash } from "node:crypto";
import { communityRest, storeConfigured, type ContributionRow, type ContributionStatus } from "./community-store";
import type { ResearchIndex } from "./research";

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const REVISION = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const BENCH = "HumanStudy-Hub/HumanStudy-Bench";
const api = `https://api.github.com/repos/${BENCH}`;

export type CommunityCredit = {
  id: string; paper_id: string; paper_title: string; revision: string;
  contributor_id: string; display_name: string; helpful: number;
};
export type Contributor = { id: string; display_name: string; contributions: number; helpful: number };
export type HelpfulState = { helpful: number; voted: boolean; canVote: boolean };

const order = "order=helpful.desc,submitted_at.desc,id.asc";
const filters = { paper: "paper_id", profile: "contributor_id", submission: "id" } as const;

export const CREDIT_PAGE_SIZE = 25;

export function creditPage(value?: string): number {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger((page - 1) * CREDIT_PAGE_SIZE) ? page : 1;
}

export async function listCredits(filter?: { by: keyof typeof filters; id: string; revision?: string }, page = 1): Promise<CommunityCredit[]> {
  const clause = filter ? `${filters[filter.by]}=eq.${encodeURIComponent(filter.id)}&` : "";
  const revision = filter?.revision ? `revision=eq.${encodeURIComponent(filter.revision)}&` : "";
  const pagination = filter ? `limit=${CREDIT_PAGE_SIZE + 1}&offset=${(page - 1) * CREDIT_PAGE_SIZE}` : "limit=50";
  return communityRest(`community_credit_totals?${clause}${revision}${order}&${pagination}`);
}

export async function listContributors(): Promise<Contributor[]> {
  return communityRest("community_contributor_totals?order=helpful.desc,contributions.desc,id.asc&limit=50");
}

export async function getContributor(id: string): Promise<Contributor | null> {
  const rows = await communityRest<Contributor[]>(`community_contributor_totals?id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] ?? null;
}

export async function setHelpful(id: string, revision: string, account: string, desired?: boolean) {
  return communityRest<HelpfulState | null>("rpc/set_community_helpful", {
    method: "POST",
    body: JSON.stringify({ submission_id: id, accepted_revision: revision, account, desired: desired ?? null }),
  });
}

async function publicJson<T>(url: string): Promise<T | null> {
  const token = new URL(url).origin === "https://api.github.com" ? process.env.GITHUB_TOKEN : undefined;
  const response = await fetch(url, {
    cache: "no-store", redirect: "error", headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Bench evidence is temporarily unavailable.");
  return response.json();
}

type Review = { status?: string; proposalId?: string; paperKey?: string; revision?: string; headCommit?: string };
type Proposal = { proposalId?: string; paperKey?: string; contributor?: { name?: string } };
type PullReview = { user?: { id?: number }; state: string };
const decisionStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const failingChecks = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);

async function hasRequestedChanges(pullUrl: string): Promise<boolean> {
  const decisions = new Map<number, string>();
  for (let page = 1; page <= 5; page++) {
    // GitHub returns reviews in chronological order. Comments do not replace a decision.
    const reviews = await publicJson<PullReview[]>(`${pullUrl}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(reviews)) break;
    for (const { user, state } of reviews) {
      if (user?.id && decisionStates.has(state)) decisions.set(user.id, state);
    }
    if (reviews.length < 100) return [...decisions.values()].includes("CHANGES_REQUESTED");
  }
  throw new Error("The submission's review history is incomplete.");
}

export async function readCommunitySubmissionStatus(row: ContributionRow): Promise<ContributionStatus> {
  if (row.branch !== `community/${row.id}` || !row.pr_number || !Number.isSafeInteger(row.pr_number) || row.pr_number < 1) return row.status;
  const repo = process.env.COMMUNITY_REPO || BENCH;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Community repository is invalid.");
  const repoUrl = `https://api.github.com/repos/${repo}`;
  const pullUrl = `${repoUrl}/pulls/${row.pr_number}`;
  const pull = await publicJson<{
    state?: string; merged?: boolean; head?: { ref?: string; sha?: string }; labels?: { name?: string }[];
  }>(pullUrl);
  if (!pull || pull.head?.ref !== row.branch) throw new Error("The submission could not be verified on GitHub.");
  if (pull.merged || pull.labels?.some(label => label.name === "community:accepted")) return "merged";
  if (pull.state === "closed") return "rejected";
  const sha = pull.head.sha;
  if (pull.state !== "open" || !sha || !COMMIT.test(sha)) throw new Error("The submission's current commit is unavailable.");
  const [changesRequested, checks, status] = await Promise.all([
    hasRequestedChanges(pullUrl),
    publicJson<{ total_count: number; check_runs: { conclusion?: string; head_sha?: string }[] }>(`${repoUrl}/commits/${sha}/check-runs?filter=latest&per_page=100`),
    publicJson<{ state: string }>(`${repoUrl}/commits/${sha}/status`),
  ]);
  if (changesRequested) return "changes_requested";
  if (status?.state === "failure" || status?.state === "error" || checks?.check_runs.some(check =>
    check.head_sha === sha && failingChecks.has(check.conclusion ?? ""))) return "checks_failed";
  if (!status || !checks || checks.total_count > checks.check_runs.length) throw new Error("The submission's check status is incomplete.");
  return "pr_open";
}

/** Derives public credit from the exact accepted Hub proposal on the published Bench revision. */
export async function verifyCommunityCredit(row: Pick<ContributionRow, "id" | "paper_key" | "pr_number" | "branch">) {
  if (!UUID.test(row.id) || row.branch !== `community/${row.id}` ||
      !row.pr_number || !Number.isSafeInteger(row.pr_number) || row.pr_number < 1) return null;
  const ref = await publicJson<{ object?: { sha?: string } }>(`${api}/git/ref/heads/main`);
  const commit = ref?.object?.sha;
  if (!commit || !COMMIT.test(commit)) return null;
  const root = `https://raw.githubusercontent.com/${BENCH}/${commit}`;
  const index = await publicJson<ResearchIndex>(`${root}/co_website/data/research_index.json`);
  if (index?.schemaVersion !== 1 || !Array.isArray(index.papers)) return null;
  const matches = index.papers.filter(paper => paper.paperKey === row.paper_key || (paper.aliases?.includes(row.paper_key) || paper.aliases?.includes(`community:${row.paper_key}`)));
  const paper = matches.length === 1 ? matches[0] : undefined;
  if (!paper || !/^paper_[a-f0-9]{24}$/.test(paper.id) || typeof paper.title !== "string") return null;
  const directory = `${root}/community/${paper.id}`;
  const review = await publicJson<Review>(`${directory}/reviews/${row.id}.json`);
  if (review?.status !== "accepted" || review.proposalId !== row.id || review.paperKey !== row.paper_key ||
      typeof review.revision !== "string" || !REVISION.test(review.revision) || !COMMIT.test(review.headCommit ?? "")) return null;
  const [proposal, pull, manifest] = await Promise.all([
    publicJson<Proposal>(`${directory}/proposals/${row.id}/CONTRIBUTION.json`),
    publicJson<{ head?: { ref?: string; sha?: string } }>(`${api}/pulls/${row.pr_number}`),
    publicJson<{ revision?: string; files?: { path: string; sha256: string }[] }>(
      `${directory}/revisions/${review.revision}/manifest.json`),
  ]);
  if (proposal?.proposalId !== row.id || proposal.paperKey !== row.paper_key ||
      pull?.head?.ref !== row.branch || pull.head.sha !== review.headCommit ||
      manifest?.revision !== review.revision || !Array.isArray(manifest.files)) return null;
  const paths = new Set<string>();
  const entries = [];
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || file.path.split("/").some(part => !part || part === "." || part === "..") ||
        file.path.includes("\\") || paths.has(file.path) || !REVISION.test(file.sha256 ?? "")) return null;
    paths.add(file.path);
    entries.push({ path: file.path, sha256: file.sha256 });
  }
  if ((!paths.has("program.json") && !paths.has("protocol.json")) ||
      createHash("sha256").update(JSON.stringify(entries)).digest("hex") !== review.revision) return null;
  const name = typeof proposal.contributor?.name === "string" ? proposal.contributor.name.trim() : "";
  if (!name || name.length > 200 || !paper.title.trim() || paper.title.length > 500) return null;
  return { submission_id: row.id, accepted_paper: paper.id, accepted_title: paper.title,
    accepted_revision: review.revision, source_commit: commit, public_name: name };
}

export async function reconcileCommunityCredit(row: ContributionRow): Promise<CommunityCredit | null> {
  if (!storeConfigured()) return null;
  const existing = (await listCredits({ by: "submission", id: row.id }))[0];
  if (existing) return existing;
  const verified = await verifyCommunityCredit(row);
  if (!verified) return null;
  await communityRest("rpc/register_community_credit", { method: "POST", body: JSON.stringify(verified) });
  return (await listCredits({ by: "submission", id: row.id }))[0] ?? null;
}
