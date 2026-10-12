import { createHmac, timingSafeEqual } from "node:crypto";
import type { ContributionStatus } from "./community-store";

export function verifyGithubSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(header.slice(7));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type StatusChange = { match: { prNumber?: number; branch?: string }; status: ContributionStatus; error: string | null };

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);
const isCommunityBranch = (b: unknown): b is string => typeof b === "string" && b.startsWith("community/");

/** Maps a GitHub event to the status change it implies, or null when it is not about us. */
export function statusChangeFor(event: string, p: Payload): StatusChange | null {
  if (event === "pull_request") {
    const pr = p.pull_request;
    if (!pr || !isCommunityBranch(pr.head?.ref)) return null;
    const match = { prNumber: pr.number as number };
    if (p.action === "closed") return { match, status: pr.merged ? "merged" : "rejected", error: null };
    if (p.action === "reopened" || p.action === "synchronize") return { match, status: "pr_open", error: null };
    return null;
  }
  if (event === "pull_request_review") {
    const pr = p.pull_request;
    if (!pr || !isCommunityBranch(pr.head?.ref) || p.action !== "submitted") return null;
    if (p.review?.state === "changes_requested") return { match: { prNumber: pr.number }, status: "changes_requested", error: "A reviewer asked for changes. Open the pull request to read what they wrote." };
    return null;
  }
  if (event === "check_suite" || event === "workflow_run") {
    const run = p[event];
    if (!run || p.action !== "completed" || !FAILED.has(run.conclusion) || !isCommunityBranch(run.head_branch)) return null;
    const prs: { number: number }[] = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    // Pull requests from forks come with an empty list, so fall back to the branch name.
    const match = prs.length ? { prNumber: prs[0].number } : { branch: run.head_branch as string };
    const what = event === "workflow_run" && run.name ? `"${run.name}"` : "The automatic checks";
    return { match, status: "checks_failed", error: `${what} on GitHub did not pass. Open the pull request to see which check failed.` };
  }
  return null;
}
