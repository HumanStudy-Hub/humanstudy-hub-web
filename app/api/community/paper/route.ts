import { NextResponse } from "next/server";
import { fail } from "@/lib/community-auth";
import { listOpenForPaper, storeConfigured } from "@/lib/community-store";
import { getResearchPaper } from "@/lib/research";

export const runtime = "nodejs";

/** What already exists for a paper key: the recommended revision from research_index.json, open pull requests from the Hub. */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  if (!key || key.length > 300 || !/^(doi:10\.\S+|title:[a-z0-9-]+)$/.test(key)) {
    return fail(400, "bad_key", "Give a paper key like doi:10.1111/1468-0017.00215 or title:<title>-<year>-<author>.");
  }
  const recommended = await getResearchPaper(key).catch(() => null);
  let pending: { folder: string; slug: string; status: string; prUrl: string | null; createdAt: string }[] = [];
  if (storeConfigured()) {
    try {
      const rows = await listOpenForPaper(key);
      pending = rows.map((r) => ({ folder: r.folder, slug: r.slug, status: r.status, prUrl: r.pr_url, createdAt: r.created_at }));
    } catch {
      // The index answer is still useful without the pending list.
    }
  }
  return NextResponse.json(
    { paperKey: key, paper: recommended ?? null,
      recommended, baseRevision: recommended?.currentRevision ?? null,
      contributions: recommended ? [recommended] : [], pending },
    { headers: { "Cache-Control": "public, max-age=30" } },
  );
}
