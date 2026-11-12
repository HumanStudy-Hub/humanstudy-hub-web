import { NextResponse } from "next/server";
import { fail, requireHubUser } from "@/lib/community-auth";
import { REVISION, UUID, setHelpful } from "@/lib/community-credit";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!UUID.test(id) || typeof body?.revision !== "string" || !REVISION.test(body.revision) ||
      (body.helpful !== undefined && typeof body.helpful !== "boolean")) {
    return fail(400, "invalid_vote", "Choose an accepted contribution revision.");
  }
  try {
    const result = await setHelpful(id, body.revision, user.id, body.helpful);
    if (!result || typeof result.canVote !== "boolean") return fail(404, "unknown_revision", "This contribution revision is unavailable.");
    if (body.helpful !== undefined && !result.canVote) {
      return fail(403, "self_vote", "You can mark other contributors’ work helpful.");
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail(503, "votes_unavailable", "Helpful votes are temporarily unavailable.");
  }
}
