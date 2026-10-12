import { NextResponse } from "next/server";
import { fail, requireHubUser } from "@/lib/community-auth";
import { getIdentity, listMine } from "@/lib/community-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  try {
    const [rows, identity] = await Promise.all([listMine(user.id), getIdentity(user.id)]);
    return NextResponse.json(
      {
        contributions: rows.map((r) => ({ id: r.id, paperKey: r.paper_key, folder: r.folder, slug: r.slug, status: r.status, prUrl: r.pr_url, prNumber: r.pr_number, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at })),
        github: identity ? { login: identity.login, connectedAt: identity.connected_at } : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return fail(503, "database_unavailable", "Your contributions could not be loaded. Try again in a minute.");
  }
}
