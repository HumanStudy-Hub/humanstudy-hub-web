import { NextResponse } from "next/server";
import { listBufferArms } from "@/lib/github-jobs";

export const runtime = "nodejs";

// Preview a buffer (agent-built) study's experiment arms before running, so the
// researcher can scope a run to one arm instead of the whole study.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId") || "";
    const slug = url.searchParams.get("slug") || "";
    if (!jobId || !slug) return NextResponse.json({ arms: [] });
    return NextResponse.json(
      { arms: await listBufferArms(jobId, slug) },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    console.error("buffer arms error", error);
    return NextResponse.json({ error: "Study arms could not be loaded." }, { status: 502 });
  }
}
