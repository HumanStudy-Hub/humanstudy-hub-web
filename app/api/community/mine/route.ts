import { NextResponse } from "next/server";
import { fail, requireHubUser } from "@/lib/community-auth";
import { readCommunitySubmissionStatus, reconcileCommunityCredit, UUID } from "@/lib/community-credit";
import { CONTRIBUTIONS_PAGE_SIZE, findOwnedContribution, getIdentity, listMine, refreshOwnedContributionStatus } from "@/lib/community-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * CONTRIBUTIONS_PAGE_SIZE)) {
    return fail(400, "invalid_page", "Choose a valid page of contributions.");
  }
  try {
    const [rows, identity] = await Promise.all([listMine(user.id, page), getIdentity(user.id)]);
    return NextResponse.json(
      {
        page, hasMore: rows.length > CONTRIBUTIONS_PAGE_SIZE,
        contributions: rows.slice(0, CONTRIBUTIONS_PAGE_SIZE).map((r) => ({ id: r.id, paperKey: r.paper_key, folder: r.folder, slug: r.slug, status: r.status, prUrl: r.pr_url, prNumber: r.pr_number, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at })),
        github: identity ? { login: identity.login, connectedAt: identity.connected_at } : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return fail(503, "database_unavailable", "Your contributions could not be loaded. Try again in a minute.");
  }
}

// Recheck one owned submission when an acceptance webhook was delayed or missed.
export async function POST(request: Request) {
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  const body = await request.json().catch(() => null);
  if (typeof body?.id !== "string" || !UUID.test(body.id)) return fail(400, "invalid_submission", "Choose a contribution.");
  try {
    const row = await findOwnedContribution(body.id, user.id);
    if (!row) return fail(404, "unknown_submission", "That contribution is unavailable.");
    const credit = await reconcileCommunityCredit(row);
    const latest = credit ? "merged" : await readCommunitySubmissionStatus(row);
    const status = await refreshOwnedContributionStatus(row, latest);
    return NextResponse.json({ status, contributorId: credit?.contributor_id ?? null },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail(503, "credit_unavailable", "Contribution status is temporarily unavailable.");
  }
}
